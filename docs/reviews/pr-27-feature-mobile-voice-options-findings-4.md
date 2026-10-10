# Review findings: mobile voice options, round 4

Review of PR #27, `feature/mobile-voice-options`, at `001468e`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-4.md`](pr-27-feature-mobile-voice-options-prompt-4.md).

All required checks pass in this checkout. The Python commands used the
repository virtual environment because this shell has no global `python`.

| Check | Result |
| --- | --- |
| `.venv/bin/python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 176 tests, pass on Node 18.19.1 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `.venv/bin/python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |
| Supplemental asynchronous-history harness | teardown assertion fails; setup lands on `live_recording` |
| Supplemental rapid-reopen and TTS edge cases | all 3 fail as described below |

The three pre-existing PDF credit-copy failures named in the prompt did not
reproduce; all 176 JavaScript tests passed.

**Merge-quality verdict: do not merge yet. The ordinary close and Forward
paths are fixed, but teardown still relies on synchronous History API behavior,
a rapid reopen loses the panel's history entry, and automatic-speaking
acknowledgement is ambiguous for repeated values and rejections.**

## Findings

### 1. MEDIUM — teardown with the panel open stops on the live-session entry

**Where** — `static/src/session/lifecycle.js:467-488`, together with the
synchronous history stub in
`tests/js/mobile-settings-and-voice.test.mjs:112-130`. The affected test is
`tests/js/mobile-settings-and-voice.test.mjs:289-302`.

This is a real ordering defect, not an artefact of planting the session entry
in the test harness. The app's own setup-to-live transition also creates that
entry with `history.pushState()` at `static/src/session/lifecycle.js:524-529`.

With the panel visible, the current entry is `voiceOptionsSheet`.
`overlaySteps` becomes 1, but `sessionSteps` becomes 0 because it only examines
the current entry. `applySessionTeardown()` therefore calls `history.go(-1)`.
History traversal is asynchronous, so `resetLiveRecordingToSetup()` runs while
the overlay is still current and does not schedule the session-entry pop.
Traversal then lands on `live_recording` after the app is already in setup.

The unit stub changes its index synchronously inside `go()`. That makes the
setup transition see `live_recording` and call its own `history.back()`, so the
test reaches the baseline and passes. I repeated the test outside the branch
with both the index change and `popstate` deferred to a microtask. It failed
with setup on `{ view: "live_recording" }`, matching the author's browser
observation.

The practical cost is limited but real: the next Back reaches the baseline
without an app transition, and Forward returns to a stale live entry. These are
dead navigation presses. A session end racing an already requested panel Back
is less deterministic because two traversals are then in flight.

**Smallest safe correction** — let one path own the teardown traversal. With a
current overlay, count both the overlay and live-session entries and jump two
steps while suppressing `syncLiveRecordingHistory()`. With a close already in
flight, wait for that traversal to land and then remove the live entry; do not
start a competing traversal. A teardown from the live entry should likewise
issue only one Back operation.

**Missing regression test** — make history traversal asynchronous in the test
harness. Start from baseline -> live -> overlay, call the real teardown, and
assert setup on the baseline after all traversal tasks. Add the same assertion
when browser Back or a programmatic close is already in flight.

### 2. MEDIUM — reopening before the close pop lands leaves a visible panel without an overlay entry

**Where** — `static/src/ui/voice-options-sheet.js:65-76`, `:96-120`. There is no
rapid close/reopen test in `tests/js/mobile-settings-and-voice.test.mjs`.

Trigger:

1. Open Voice options on the live-session entry.
2. Close it, which sets `_closeInFlight` and requests `history.back()`.
3. Reopen it before that traversal and its `popstate` arrive.

The sheet becomes visible again. `openVoiceOptionsSheet()` does not reclaim the
current overlay because `history.state.view` is still `voiceOptionsSheet`, and
it leaves `_ownsHistoryEntry` false. The pending Back then lands on
`live_recording`. The one-shot skip consumes its event without restoring an
overlay entry, so the panel stays visible above the live entry.

A browser Back now consumes the live entry merely to close the panel. The app
remains live on the baseline, so the following Back can leave the document
instead of going through normal session finish. An asynchronous-history test
reproduced the visible panel on `live_recording`.

**Smallest safe correction** — treat an open request during `_closeInFlight` as
a deferred reopen. When the expected close pop lands, push a fresh overlay
entry, restore ownership, and keep the sheet visible. Do not mark the existing
entry as owned while its Back traversal is still pending.

**Missing regression test** — close and reopen without awaiting `popstate`.
After the pending traversal drains, assert a visible panel on an owned
`voiceOptionsSheet` entry. Then verify that Back closes only the panel and a
second Back finishes the session.

### 3. MEDIUM — one pending Boolean cannot identify repeated echoes or recover from rejection

**Where** — `static/src/session/voice-options.js:109-147` and
`static/src/session/messages.js:133-155`. The new test at
`tests/js/mobile-settings-and-voice.test.mjs:418-440` covers only two opposite
changes followed by two successful echoes.

There are two failing sequences:

1. Start on, then tap off -> on -> off before any echo. The first echo is off,
   which equals the latest pending Boolean. `applyTtsSettingsEcho()` treats it
   as confirmation of the third tap and clears pending state. The second echo
   is on and is now accepted, so the control reverses the latest choice until
   the third echo arrives.
2. Tap off and receive `error.code === "invalid_tts_settings"`. The error path
   does not clear or reconcile `_pendingAutoSpeak`. A later authoritative
   snapshot with `auto_speak: true` is deleted as an older opposite echo. The
   server cannot become authoritative for that field again until another
   matching echo or session teardown.

Socket close and normal session end do clear the pending value through
`resetVoiceOptions()`. An accepted update whose echo never arrives leaves it
pending for the rest of an otherwise open session.

**Smallest safe correction** — serialize automatic-speaking updates or track
the ordered values awaiting echoes instead of one Boolean. Only mark a value
pending after the socket accepts the send. Handle `invalid_tts_settings` by
clearing the corresponding pending update and restoring the last confirmed
value, or request/apply a fresh server snapshot.

**Missing regression test** — cover off -> on -> off with all three echoes.
Also deliver `invalid_tts_settings` before a contrary snapshot and assert that
the snapshot is applied. Keep the existing socket-close and session-end reset
assertions.

## What holds up

- Close button, scrim, settled browser Back, and completed programmatic close
  no longer end the live session.
- Forward after a settled close or browser Back reopens the panel. Forward after
  teardown does not revive session UI. A second Forward has no additional entry
  to enter.
- Two settled open/close cycles replace the old Forward entry and retain one
  live-session entry.
- An empty authoritative backend list now disables voice modes. An absent or
  non-array list is the only direct predicate input that falls back to the
  capability and backend-family checks.
- The panel and session request still use the same capability predicate.
- Automatic speaking still sends the full TTS snapshot. No mobile path has
  regressed to the destructive partial delta.
- Open- and closed-socket finish paths still share teardown and clear cloning
  state. Cache busting was updated for the JavaScript changes.

## Unresolved risks and untested paths

- No installed browser automation was available. The teardown result was
  reproduced with the existing app test plus an asynchronous traversal stub;
  the author's Chromium observation independently matches that result.
- A completed swipe calls the shared close function, but the gesture itself was
  not exercised.
- No real microphone/device session was run. Live mode switching, clone
  preparation, websocket loss, PCM autoplay policy, and audio capture remain
  unverified.

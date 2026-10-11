# Review findings: mobile voice options, round 5

Review of PR #27, `feature/mobile-voice-options`, at `b602e48`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-5.md`](pr-27-feature-mobile-voice-options-prompt-5.md).

All required checks pass in this checkout. The Python commands used the
repository virtual environment because this shell has no global `python`.

| Check | Result |
| --- | --- |
| `.venv/bin/python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 179 tests, pass on Node 18.19.1 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `.venv/bin/python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |
| Supplemental history tests with an entry below the app baseline | both fail: teardown stops short or traverses past the baseline |
| Supplemental rejection test | fails: the rejected local automatic-speaking value remains active |

The three pre-existing PDF credit-copy failures named in the prompt did not
reproduce; all 179 JavaScript tests passed.

**Merge-quality verdict: do not merge yet. The new asynchronous traversal and
rapid-reopen fixes work for an open panel, but the entry-below flag is absent
when the panel was never opened and stale after it closes. A rejected TTS
update also leaves the client showing a value the server did not accept.**

## Findings

### 1. HIGH — panel bookkeeping can leave the session entry current or traverse past the app baseline

**Where** — `static/src/ui/voice-options-sheet.js:71-112` and
`static/src/session/lifecycle.js:474-495`, `:529-544`. The current tests at
`tests/js/mobile-settings-and-voice.test.mjs:269-313` and `:428-464` do not
cover teardown without opening the panel or an entry below the app baseline.

`applySessionTeardown()` now derives `sessionSteps` only from
`voiceOptionsSheetEntryBelowIsSession()`. That value describes what was below
the most recently opened overlay, not where the session entry is when teardown
runs. This fails in both directions.

**Panel never opened:** baseline -> `live_recording`, followed by local finish,
server end, or socket close. `_entryBelow` is null, so both step counts are zero.
The teardown suppresses the normal live-history sync and reaches setup with
`live_recording` still current. This is the normal session-end path for anyone
who did not use Voice options.

**Panel opened and closed, then session Back:** `_entryBelow` remains
`live_recording` after the overlay pop. Browser Back has already moved from the
session entry to the app baseline when the router calls `finishSession()`.
Teardown nevertheless counts another session step and calls `history.go(-1)`.
If the browser has an earlier entry, this leaves the app instead of ending on
its baseline.

I reproduced both sequences with the asynchronous test harness and a sentinel
entry below the app baseline. The first stopped on `live_recording`; the second
landed on the sentinel. The existing harness starts at its first entry and
clamps out-of-range traversals, so the over-traversal is otherwise invisible.

`_sessionHistoryBaseIndex` is assigned when a session starts but never read,
and `voiceSheetOverlayCurrent()` is also unused. Neither protects these paths.

**Smallest safe correction** — derive the step count from the current
transition:

- if the overlay is current or closing, remove it and the recorded session
  entry below it;
- otherwise, remove one step only when `history.state.view` is currently
  `live_recording`;
- if Back already landed on the baseline, remove zero steps.

Clear the overlay's entry-below marker when its entry is popped or reset. Remove
the unused base-index/function, or use one explicit session-history model
instead of combining both approaches.

**Missing regression test** — add an app-baseline entry above a sentinel. Test
server/local teardown without ever opening Voice options. Then open and close
the panel, use Back to finish the session, and assert that the app baseline—not
the sentinel—remains current.

### 2. MEDIUM — rejection clears pending state but does not undo the rejected optimistic value

**Where** — `static/src/session/voice-options.js:114-167`,
`static/src/session/messages.js:155-159`, and
`static/src/ui/voice-options-sheet.js:39-47`. The server rejection behavior is
at `app/runtime.py:302-326`. The test at
`tests/js/mobile-settings-and-voice.test.mjs:495-515` supplies a later snapshot
that the server does not send for the rejected request.

The panel applies and persists `auto_speak` before sending the full TTS
snapshot. When that snapshot is invalid, the server sends only
`invalid_tts_settings` and returns. It does not send a `tts_settings` snapshot.
`applyTtsSettingsRejection()` clears the pending counter but leaves the
optimistic value in `state.ttsSettings.auto_speak` and local storage.

For example, the server can remain on automatic speaking while the switch
shows off. Playback behavior then contradicts the control for the rest of the
session unless some unrelated later update produces a snapshot. The new test
passes only because it manually delivers such a later message.

**Smallest safe correction** — retain the last confirmed automatic-speaking
value when the first update becomes pending. On `invalid_tts_settings`, restore
and render that value, including its persisted preference. An
alternative is for the error response to carry the authoritative TTS snapshot
and route it through the normal merge.

**Missing regression test** — toggle the switch, deliver only
`invalid_tts_settings`, and assert immediately that state, persistence, and the
open switch return to the last confirmed server value. Do not add a synthetic
`tts_settings` message after the rejection.

## What holds up

- Teardown with a currently open panel now removes both overlay and session
  entries in the asynchronous harness.
- Teardown while a programmatic close or browser Back is in flight reaches the
  app baseline in supplemental tests.
- Close then immediate reopen waits for the pending traversal and creates a
  fresh overlay entry. Back then closes only the panel.
- Two settled open/close cycles retain one live entry. Forward reopens the
  panel, and a second Forward changes nothing.
- Accepted off -> on -> off changes preserve the latest choice until all three
  ordered echoes arrive. Session end and socket-drop teardown clear the pending
  count, and late messages from the ended session fail the session-id guard.
- Empty and removed backend lists still disable voice modes. The panel and
  session request use the same capability predicate.
- Automatic speaking still sends the full TTS snapshot. No mobile path has
  regressed to a partial delta.
- Open- and closed-socket finish paths still share teardown and clear cloning
  state. The mobile cache-busting query was updated.

## Unresolved risks and untested paths

- Two changes with only one response leave the automatic-speaking field
  pending until rejection or session teardown. The server emits one echo or
  error on every normal update path, and socket drop tears the session down, so
  this requires a missing response while the socket remains open. There is no
  timeout or request identifier for that failure mode.
- The history harness defers traversal with a microtask and clamps an
  out-of-range delta. Browser traversal runs as a task and may cross to another
  document. The supplemental sentinel tests expose the current step-count
  defects, but the full cross-document behavior was not exercised.
- A completed swipe uses the shared close callback, but the gesture itself was
  not exercised.
- No real microphone/device session was run. Live mode switching, clone
  preparation, websocket loss, PCM autoplay policy, and audio capture remain
  unverified.

# Review findings: mobile voice options, round 7

Review of PR #27, `feature/mobile-voice-options`, at `0f0975a`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-7.md`](pr-27-feature-mobile-voice-options-prompt-7.md).

All required checks pass in this checkout. The Python commands used the
repository virtual environment because this shell has no global `python`.

| Check | Result |
| --- | --- |
| `.venv/bin/python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 187 tests, pass on Node 18.19.1 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `.venv/bin/python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |
| Supplemental immediate reopen/teardown race | fails: hidden overlay remains current and the app stays live |
| Supplemental duplicate teardown and two-session tests | pass |
| Supplemental mixed TTS burst with repeated rejection | pass |

The three pre-existing PDF credit-copy failures named in the prompt did not
reproduce; all 187 JavaScript tests passed.

**Merge-quality verdict: do not merge yet. The two-stage teardown fixes the
reviewed settled paths and avoids multi-entry jumps, but a deferred reopen can
still create a new overlay after teardown has begun and leave teardown pending
indefinitely.**

## Findings

### 1. MEDIUM — teardown does not cancel a reopen that is waiting for the close pop

**Where** — `static/src/ui/voice-options-sheet.js:65-79`, `:109-142`, and
`static/src/session/lifecycle.js:466-495`. The test at
`tests/js/mobile-settings-and-voice.test.mjs:583-599` waits for the deferred
reopen to finish before starting teardown, so it misses the overlap.

Trigger this sequence without waiting between its last three actions:

1. Open the panel.
2. Close it, which queues `history.back()` and sets `_closeInFlight`.
3. Reopen it, which sets `_reopenAfterClose`.
4. End the session before the queued popstate arrives.

`applySessionTeardown()` marks teardown pending and calls
`closeVoiceOptionsSheet()`. The panel no longer owns the entry, so this close
does not request another pop. It also leaves `_reopenAfterClose` set. When the
original pop lands, `handleVoiceOptionsPopstate()` therefore pushes a replacement
overlay entry at lines 132-140. The panel is hidden by teardown, so
`retrySessionTeardown()` waits on that new `voiceOptionsSheet` entry. Nothing
pops it.

The supplemental asynchronous test ended with the hidden overlay current and
`state.appMode === 'live_recording'`. The session had ended, but the app never
returned to setup.

**Smallest safe correction** — make a close request cancel any deferred reopen.
In particular, `closeVoiceOptionsSheet()` should clear `_reopenAfterClose`
before it decides whether it owns an entry to pop. The already queued close can
then land normally, after which `retrySessionTeardown()` removes the session
entry.

**Missing regression test** — use the existing rapid-reopen sequence, but call
`applySessionTeardown()` before the first `settle()`. Assert that the panel is
hidden, setup is active, and the app baseline is current after both pops.

## What holds up

- The seven settled browser scenarios named in the prompt are represented by
  passing asynchronous tests. Ordinary open, close, Forward, and teardown paths
  now pop one owned entry at a time.
- The sentinel test reaches the app baseline without traversing the entry below
  it.
- A second teardown while the first is pending does not pop twice in the
  supplemental harness.
- Two open-panel sessions in one page load tear down independently.
- Button, scrim, and browser Back close only the panel and keep the session
  live. Forward reopens the panel.
- Every accepted automatic-speaking echo now updates the confirmed value. A
  mixed three-change burst followed by two rejections restored the last
  accepted value in state and persistence.
- Automatic speaking still sends the full TTS snapshot. No mobile path has
  regressed to a partial update.
- Empty and removed backend lists still disable voice modes. Panel rendering
  and session creation use the same availability predicate.
- Open- and closed-socket finish paths still share teardown and clear cloning
  state. The mobile cache-busting query was updated.

## Unresolved risks and untested paths

- The failing immediate reopen/teardown sequence was reproduced in the
  asynchronous harness, not in a browser. The author's rapid-reopen browser
  check covered teardown after the reopen had settled.
- Teardown relies on the same-document overlay popstate arriving. The browser
  should dispatch it for the owned entry, but there is no recovery if it does
  not.
- A missing TTS response leaves automatic speaking pending until rejection or
  session teardown. There is no timeout or request identifier.
- A completed swipe uses the shared close callback, but the gesture itself was
  not exercised.
- No real microphone/device session was run. Live mode switching, clone
  preparation, websocket loss, PCM autoplay policy, and audio capture remain
  unverified.

## Architecture recommendation

Keep the user-facing behavior from option 1: Back should close Voice options
before it ends the session. Do not keep the current split ownership. Implement
that behavior as option 4: one voice-session history controller owns both the
live entry and its panel entry.

The current flags are divided between `session/lifecycle.js` and
`ui/voice-options-sheet.js`. Each module can make a locally valid decision that
invalidates the other's pending transition. The finding above is another
instance: teardown wants setup while the sheet still intends to reopen.

Put the controller under the existing session workflow, for example
`static/src/session/history.js`. Keep `voice-options-sheet.js` responsible for
DOM behavior and rendering only. Do not make this a generic sheet abstraction;
language and settings have different route semantics and do not share the
live-session lifecycle.

The controller should expose desired states rather than individual history
operations:

- `setup`: neither voice entry is owned;
- `live`: the session entry is current;
- `panel`: the overlay entry is current above the session entry.

Opening, closing, teardown, Back, and Forward set or report one of those states.
One reconciler performs at most one `pushState()` or `back()` at a time. After
each popstate it compares the current entry with the desired state and takes the
next single step. Teardown sets the desired state to `setup`, which cancels any
pending reopen by definition.

Tag both entries with a session generation in `history.state`. That lets the
controller reject stale Forward entries from an earlier session without
consulting scattered DOM and app-state flags. It also makes two sessions in one
page load directly testable.

A bounded migration is enough:

1. Fix the current race by cancelling `_reopenAfterClose` on close and add the
   missing test.
2. Move voice-only history flags, the teardown target, and voice popstate
   handling into `session/history.js`. Keep lifecycle cleanup and sheet
   rendering in their current modules.
3. Replace sequence-specific tests with a small transition table covering
   current state, requested state, popstate, and expected owned entry. Retain a
   few end-to-end router tests and the sentinel.

This is a larger change than retaining the present flags, but it preserves the
better mobile Back behavior. Removing the overlay entry would simplify code at
the cost of surprising navigation. Leaving stale entries intentionally would
make correctness depend on a later open, so I would not choose options 2 or 3.

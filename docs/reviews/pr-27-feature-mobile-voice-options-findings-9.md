# Review findings: mobile voice options, round 9

Review of PR #27, `feature/mobile-voice-options`, at `1421d6e`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-9.md`](pr-27-feature-mobile-voice-options-prompt-9.md).

The Python commands used the repository virtual environment because this shell
has no global `python`.

| Check | Result |
| --- | --- |
| `.venv/bin/python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 197 tests, pass on Node 18.19.1 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `.venv/bin/python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |
| Supplemental two-cycle and panel-push goal changes | pass |
| Supplemental duplicate teardown and end-before-live-push sequences | pass; one completion, baseline current |
| Supplemental teardown during pending Forward | fail: completion runs, then a late pop leaves a raw live entry current |
| Supplemental reload with the browser stack preserved | implementation passes; the committed reload test does not preserve that stack |

The three pre-existing PDF credit-copy failures named in the prompt did not
reproduce; all 197 JavaScript tests passed.

**Merge-quality verdict: do not merge yet. The ordinary transition table and
the seven settled browser paths are repaired, but teardown can still complete
before an overlapping traversal is finished, and server end notices are lost
by the deferred setup reset.**

## Findings

### 1. MEDIUM — deferred setup clears a server end notice before it can be shown

**Where** — `static/src/session/messages.js:161-169`,
`static/src/session/lifecycle.js:471-488`, and
`static/src/ui/render-status.js:29-43`.

Let the server end a live session with `session_duration_limit` or
`session_storage_limit` while a voice-history entry is current.
`handleMessage()` calls `applySessionTeardown()`, which now leaves the app in
live mode until asynchronous history traversal completes. It then stores the
server message and renders, but the notice is hidden outside setup. When
traversal completes, `resetLiveRecordingToSetup()` clears
`state.sessionEndMessage` before switching to setup and rendering again. The
user never sees the limit notice.

**Smallest safe correction** — do not clear `sessionEndMessage` in the deferred
setup reset. `startListening()` already clears it when the next session starts.
Confirm that local finish and socket-close teardown still land in setup with an
empty message.

**Missing regression test** — deliver an `ended` message with a guardrail reason
while live and with the panel both closed and open. After all history pops,
assert setup mode, the app baseline, and the visible server message. Cover a
normal end, local finish, and socket close with no notice.

### 2. MEDIUM — teardown misidentifies an earlier Forward pop as its own step

**Where** — `static/src/session/history.js:98-120` and `:132-139`.

Open the panel, close it to live so the panel remains reachable with Forward,
then request Forward and end the session before that popstate arrives. Teardown
sets `_ourPop` and queues Back while the earlier Forward is already pending.
The Forward pop arrives first, but `handleVoiceHistoryPopstate()` treats the
next pop as the controller's Back, clears `_stepInFlight`, and queues another
Back from the panel.

In the supplemental asynchronous history harness, the first queued Back reached
the baseline and fired completion. The extra Back then landed on the old live
entry. The controller reported logical setup because it had already advanced
the generation, while raw `history.state` was still `source: 'voiceSession',
kind: 'live'`. The app had also moved to setup. This recreates the app/history
disagreement.

**Smallest safe correction** — track the expected landing entry or state for a
controller traversal instead of assuming the next popstate belongs to it. An
unrelated Forward pop must not clear the pending controller step or cause a
duplicate Back. Fire teardown completion only when a non-voice entry is current
and no controller traversal can still land afterward.

**Missing regression test** — from live with a panel entry ahead, call
`history.forward()` and immediately call `endVoiceHistorySession()`. Drain every
queued pop. Assert that completion runs once, the baseline remains current, and
no later pop restores either voice entry. Repeat this sequence in Chromium.

### 3. LOW — the reload regression test replaces the history stack it claims to retain

**Where** — `tests/js/voice-history.test.mjs:22-28` and `:220-249`.

The reload test builds old live and panel entries, then calls
`loadController('?second')`. That helper calls `installHistory()` and replaces
the stack with a new baseline. Forward therefore has no old panel entry to
reach. `assert.ok(seen.length >= 0)` is also true for every possible result.
The test would still pass if the reload-safe page identifier were removed.

The implementation itself passed a supplemental harness that imported a fresh
controller while retaining the same stack and current index.

**Smallest safe correction** — separate fresh-module import from history-stub
installation. Re-import the controller without replacing `history`, then prove
that the old panel is rejected before a new session and that the new session
creates an entry with a different page-load identifier. Remove the tautological
assertion.

## What holds up

- `panel -> live` now traverses Back and preserves the Forward entry. Both
  Forward routes pass the integration suite.
- Direct `setup -> panel` and a changed goal during a controller pop now settle
  on the requested state.
- Two open/close cycles keep one live entry and one reachable panel entry. A
  goal changed from the live callback during `setup -> panel` is respected.
- Two teardown requests while one is pending coalesce to one completion in the
  focused harness. Ending before a live entry exists completes once at the
  baseline.
- App mode remains live until ordinary teardown reaches the baseline, so Start
  is not exposed during the reviewed settled paths.
- The page-load identifier rejects old generations when the browser stack is
  retained in the supplemental harness.
- The round-6 rejection tests and the round-7 deferred-reopen cancellation test
  still pass.

## Unresolved risks and untested paths

- No Chromium binary was available in this checkout. The author's seven settled
  browser scenarios were not independently repeated, and the pending-Forward
  teardown sequence has not yet been tested in a browser.
- A physical reload with retained voice entries was not run in a browser. The
  implementation passed the stack-preserving Node harness.
- No real microphone/device session was run. Live voice switching, clone
  preparation, websocket loss, PCM autoplay policy, and the swipe gesture remain
  unverified.

# Review findings: mobile voice options, round 8

Review of PR #27, `feature/mobile-voice-options`, at `2f3ec1a`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-8.md`](pr-27-feature-mobile-voice-options-prompt-8.md).

The Python commands used the repository virtual environment because this shell
has no global `python`.

| Check | Result |
| --- | --- |
| `.venv/bin/python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 185 of 188 pass on Node 18.19.1; the three failures are the voice-history cases described below |
| `node --input-type=module --check < static/src/app.js` | pass |
| `.venv/bin/python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |
| Supplemental controller transition table against `HEAD` | 1 of 4 passes; `panel -> live`, direct `setup -> panel`, and a changed goal during a pending pop fail |
| Temporary bounded transition correction | all 43 existing mobile tests and all 4 initial controller-table tests pass |
| Supplemental teardown invariants after that correction | fail: setup is exposed before the baseline is current, and an old teardown pop can overtake a new session |
| Supplemental full-reload generation case | fail: the first new session accepts generation-1 entries from the previous page load |

The three pre-existing PDF credit-copy failures named in the prompt did not
reproduce. The only failures in the 188-test JavaScript run are the three
current voice-history failures.

**Merge-quality verdict: do not merge yet. Continue with the controller, but
fix its transition table and make session teardown completion atomic with the
app-mode transition. The controller's ownership boundary is sound; the current
state machine is not.**

## Findings

### 1. MEDIUM — closing the panel pushes a new live entry and destroys its Forward path

**Where** — `static/src/session/history.js:97-113` and `:127-149`.

Start a live session, open Voice options, and close it with the close button or
scrim. The requested transition is `panel -> live`. `reconcile()` has no edge
for that transition, so line 149 calls `pushEntry(live)`. `pushState()` adds a
second live entry above the panel and truncates the panel's Forward branch.
There is no popstate for a push. Forward therefore has nowhere to
go, while browser Back works because it traverses from the panel to the live
entry already below it.

This is the exact cause of the reported route asymmetry. It is not a delayed
programmatic `back()`: the close path never calls `back()`. It is not a
generation mismatch either: all three entries have the current session's
generation.

The same incomplete table has two further failures. A direct `setup -> panel`
request pushes `live` and returns without reaching `panel`. If a requested goal
changes while a controller-initiated pop is pending, lines 107-112 overwrite
the newer goal with the entry on which that pop lands.

**Smallest safe correction** — encode `panel -> live` as one guarded
`history.back()`. Capture whether the arriving pop completed a controller step:
such a pop must keep the current desired state and call `reconcile()` again;
only user-driven navigation adopts the landed state as a new goal. After
`setup -> panel` pushes the required live entry, reconcile once more to push the
panel entry. A temporary correction with those three changes passed all 43
mobile tests and the four focused transition tests.

**Missing regression test** — add an isolated controller table covering at
least `setup -> live`, `setup -> panel`, `live -> panel`, `panel -> live`,
`panel -> setup`, user Back/Forward, and a goal change while a pop is pending.
Assert the full stack and index, not only `history.state.kind`. Keep the seven
browser scenarios as integration coverage.

### 2. MEDIUM — teardown exposes setup while voice entries are still current

**Where** — `static/src/session/lifecycle.js:471-487` and
`static/src/session/history.js:55-59,73-90`.

End a session while the panel is open. `endVoiceHistorySession()` queues the
first asynchronous Back traversal, but `applySessionTeardown()` immediately
calls `resetLiveRecordingToSetup()`. Until the queued pops finish, app state is
`setup` while the current browser entry is still `panel` or `live`. The Start
action is therefore available before the previous session's history teardown
has completed.

If a new session starts in that window, `beginVoiceHistorySession()` clears
`_leavingSession` and `_stepInFlight`. The old queued pop can then land in the
new generation and replace its desired `panel` state with logical `setup`. The
supplemental controller test ended with the new session's desired state still
`panel` but its current state `setup`; the integration check also observed
`state.appMode === setup` while the panel entry was current.

**Smallest safe correction** — let the controller signal completion only when
`leaveVoiceEntries()` reaches a non-voice entry. Hide/reset the panel and stop
session resources immediately, but do not set app mode to setup or enable Start
until that completion signal. Split the final setup reset from the immediate
cleanup. Take care with the server `ended` path: it currently assigns `sessionEndMessage`
after calling teardown, while `resetLiveRecordingToSetup()` clears that message.
A deferred reset must preserve or receive the final end message.

**Missing regression test** — after teardown with the panel current, assert
that setup is not exposed until both voice entries have been left. Attempt a
new start before the first pop lands and prove that either it is blocked or it
starts only after teardown completion. Retain the sentinel assertion that the
entry below the app baseline is never traversed.

### 3. LOW — numeric generations collide after a full page reload

**Where** — `static/src/session/history.js:26,42-59` and
`static/src/app.js:268-270`.

Create generation-1 live and panel entries, navigate back to live, and reload
the page. Browser history survives the reload, but the module counter returns
to zero. The next session increments it to `1`, reuses the old live entry, and
accepts the old panel entry on Forward as belonging to the new session. The app
startup cleanup only recognizes the earlier `history.state.view` entries; it
does not invalidate `source: 'voiceSession'` entries.

**Smallest safe correction** — include a per-page-load nonce in the session
generation instead of using a process-local integer alone. That keeps old
entries identifiable without coupling startup to every possible position in
the history stack.

**Missing regression test** — retain a history stack, import a fresh controller
instance, start its first session, and prove that Forward cannot adopt the old
panel entry.

### 4. LOW — three integration tests create an impossible two-generation session stack

**Where** — `tests/js/mobile-settings-and-voice.test.mjs:865-867`, `:888-892`,
and `:904-907`.

Each test calls `startLiveSession()` twice. The helper increments the session
generation each time; the second call therefore sees the first live entry as
stale and pushes another live entry. Assertions that inspect only the top entry
can pass while an extra session entry remains below it. This weakens the tests
around the exact invariant under review.

**Smallest safe correction** — remove the duplicate calls and keep one live
entry per test session. Put the controller transition table in its own DOM-free
test file so it can assert every entry, the current index, desired state, and
whether a traversal is pending.

## What holds up

- `session/history.js` is the right workflow-local owner for the two related
  entries. Keeping history out of `ui/voice-options-sheet.js` is also the right
  separation. Do not turn this into a generic sheet controller.
- The round-6 rejection behavior still holds: a rejected automatic-speaking
  update restores the last server-confirmed value, including after an earlier
  accepted change.
- The round-7 immediate reopen/teardown case now reaches setup and the app
  baseline. The deferred reopen is cancelled as intended.
- Settled teardown removes panel and live one step at a time, and the sentinel
  test does not traverse below the app baseline.
- Browser Back closes the panel and preserves the live entry in the automated
  integration test.

## Unresolved risks and untested paths

- The temporary transition correction was exercised in the Node history
  harness, not in Chromium. After the findings are fixed, rerun all seven
  browser scenarios on fresh pages and include the sentinel below the app
  baseline.
- A real microphone/device session remains untested. Live voice switching,
  clone preparation, websocket loss mid-session, PCM autoplay policy, and the
  swipe gesture still need device coverage.
## Decision

**Continue with the controller; do not roll back to `04a81bb`.** Keep the
workflow-local module, the sheet's separation from history, and generation-tagged
entries. Make the generation identifier reload-safe.

The Forward asymmetry is caused by the close path falling through to
`pushEntry(live)` instead of traversing `panel -> live` with Back. The bounded
transition correction demonstrates that this part does not require another
architecture. The independent teardown-completion race must also be fixed
before merge, then the transition table and seven browser scenarios should be
the acceptance gate.

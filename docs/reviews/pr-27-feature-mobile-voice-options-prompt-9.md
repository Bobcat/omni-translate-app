# Review prompt: mobile voice options (round 9)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the ninth
round. Review only; do not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-9.md`](pr-27-feature-mobile-voice-options-findings-9.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify the files from earlier rounds; each round writes only its own.

## What changed since round 8

Round 8 reviewed `2f3ec1a` and advised continuing with the controller rather than
rolling back. The fixes are in `a855d80`.

**Finding 1 — the Forward asymmetry.** You identified it exactly: `panel -> live`
had no edge in the table, so `reconcile()` fell through to `pushEntry(live)`,
which truncated the panel's Forward branch. It is now a guarded `back()`. The
other two table gaps are fixed with it: `pushEntry` runs the next step, so
`setup -> panel` reaches the panel entry after creating the live one, and a pop
the controller asked for keeps the goal instead of adopting the landed entry, so
an older step cannot overwrite a newer goal.

**Finding 2 — teardown completing ahead of its history.** The controller now
signals completion: `endVoiceHistorySession({ onComplete })` runs the callback
once the browser is on an entry that is not ours, and the app's move to setup
waits for it. Immediately, teardown only hides the panel and resets the
session-only voice state, so setup is not exposed and Start is not available
while a session entry is still current.

One detail from your note that the author did not have to solve: the server
`ended` path assigns `sessionEndMessage` after calling teardown, and the deferred
reset runs later still, so the message is no longer cleared by it. Worth
confirming that this holds for every end path.

**Finding 3 — generations across a reload.** The generation is now
`<per-page-load id>:<counter>`, so entries left in the browser history by an
earlier load are not adopted by the first session after a reload.

**Finding 4 — the test shape.** `tests/js/voice-history.test.mjs` is new: a
DOM-free transition table asserting the whole stack, the current index, the
desired state and whether a traversal is pending, covering
`setup -> live`, `setup -> panel`, `live -> panel`, `panel -> live`, a goal change
during a pending pop, `panel -> setup`, teardown completion, and a reload with
leftover entries. The three integration tests that started two sessions each now
start one.

## Browser verification by the author

One scenario per page load:

| Scenario | `history.state` | app mode | panel |
| --- | --- | --- | --- |
| Close button | `live` | live | hidden |
| Forward after closing | `panel` | live | open |
| Back | `live` | live | hidden |
| Teardown without the panel | `null` | setup | hidden |
| Teardown with the panel open | `null` | setup | hidden |
| Teardown after a rapid reopen | `null` | setup | hidden |
| Teardown after a Forward reopen | `null` | setup | hidden |

Both Forward routes — after Back and after the close button — now reopen the
panel, which is the asymmetry this round fixes.

## Review priorities

- The transition table is the thing to attack. Run it against sequences the file
  does not cover: two open/close cycles, a goal change during a panel push, a
  teardown requested twice, a teardown while a Forward traversal is pending, and
  a session ended before its live entry was ever pushed.
- Confirm the teardown completion cannot fire twice, or fire after a new session
  has begun. The callback is stored in module state, so a second teardown while
  one is pending is the case to try.
- Confirm the reload-safe generation actually rejects a previous load's entries
  in a browser, not only in the harness: the harness re-imports the module, while
  a real reload keeps the stack.
- Check the deferred setup reset against every end path: server `ended`, socket
  close, and the local finish, including the `sessionEndMessage` behaviour noted
  above.
- Confirm the round-6 rejection behaviour and the round-7 reopen cancellation
  still hold.

## Intentional exclusions

Do not report these as missing scope unless this PR makes them unsafe:

- per-bubble voice selection: the protocol's voice mode is session scoped;
- porting the desktop TTS detail controls to mobile;
- server-side bounds or metering for voice, ASR tuning or image rendering;
- Cloudflare cache configuration, which lives outside this repository;
- the three pre-existing PDF credit-copy JavaScript failures.

## Verification

Run:

```bash
python -m unittest discover -s tests
node --test tests/js/*.test.mjs
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
git diff --check main...HEAD
```

The author's run: 309 Python tests pass; the JavaScript suite passes 194 of 197,
the three failures being the pre-existing PDF credit-copy tests.

Still unverified by anyone: a real session with a microphone. Live voice
switching, clone preparation, websocket loss mid-session, PCM autoplay policy
and the swipe gesture have not been exercised on a device.

## Review response

List findings first, ordered by severity. For each finding include:

- file and line;
- triggering sequence or input;
- observed or expected failure;
- smallest safe correction;
- missing regression test, when applicable.

Then list unresolved risks and untested paths, and give an explicit
merge-quality verdict. If there are no findings, say so directly and name the
paths that were not exercised.

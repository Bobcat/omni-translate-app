# Review prompt: mobile voice options (round 6)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the sixth
round. Review only; do not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-6.md`](pr-27-feature-mobile-voice-options-findings-6.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify the files from earlier rounds; each round writes only its own.

## What changed since round 5

Round 5 reviewed `b602e48`. The fixes are in `705974d`.

**Finding 1.** You were right that the entry-below marker described the last
opened overlay rather than the session entry at teardown time, and that it broke
the ordinary path. `applySessionTeardown` now derives the step count from the
current transition:

- the overlay current or closing: one step, plus one more when the panel
  recorded that the session entry sat directly below it;
- otherwise: one step only when `history.state.view` is `live_recording`;
- otherwise: none, which is the case when Back already reached the baseline.

The panel clears its entry-below marker as soon as its own entry is popped, in
both the programmatic close and the real Back path. The unused
`_sessionHistoryBaseIndex` assignment and `voiceSheetOverlayCurrent()` helper are
gone, so there is one history model instead of two.

**Finding 2.** The last confirmed automatic-speaking value is remembered when
the first change becomes pending, and `invalid_tts_settings` restores it —
state, stored preference and the open panel — so a refused update cannot leave
the switch showing something the server never accepted. A confirmed echo updates
what counts as confirmed; a session teardown clears it.

## Browser verification by the author

One scenario per page load:

| Scenario | Result |
| --- | --- |
| Teardown without ever opening the panel | baseline entry current, app in setup |
| Panel opened and closed, then Back ends the session | baseline entry current, app in setup |
| Teardown with the panel open | baseline entry current, app in setup |

## Review priorities

- Re-check those three, and the pairs that combine them: open, close, reopen,
  teardown; teardown during a close in flight; teardown during an in-flight
  Back; two sessions in a row without a reload, since the marker and the
  pending values must not survive the first.
- Confirm the step count cannot remove an entry the app does not own. The
  reviewer's sentinel experiment — an entry below the app baseline — is the
  right tool; the author's harness clamps out-of-range deltas and therefore
  cannot see an over-traversal.
- Finding 2: check the confirmed value against a rejection as the first change,
  a rejection after several confirmations, a rejection when the session ends
  before the error arrives, and a rejection whose error arrives twice.
- Confirm the round-1 to round-4 fixes still hold, especially that closing the
  panel never ends a session and that no path sends a partial TTS delta.

## Intentional exclusions

Do not report these as missing scope unless this PR makes them unsafe:

- per-bubble voice selection: the protocol's voice mode is session scoped;
- porting the desktop TTS detail controls to mobile;
- server-side bounds or metering for voice, ASR tuning or image rendering;
- Cloudflare cache configuration, which lives outside this repository;
- the pre-existing PDF credit-copy JavaScript failures noted under Verification.

## Verification

Run:

```bash
python -m unittest discover -s tests
node --test tests/js/*.test.mjs
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
git diff --check main...HEAD
```

The author's run: 309 Python tests pass; the JavaScript suite passes 179 of 182,
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

Then list unresolved risks and untested paths. Give an explicit merge-quality
verdict. If there are no findings, state that directly and name the paths that
were not exercised.

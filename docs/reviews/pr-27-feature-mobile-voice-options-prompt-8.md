# Review prompt: mobile voice options (round 8)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the eighth
round. Review only; do not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-8.md`](pr-27-feature-mobile-voice-options-findings-8.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify the files from earlier rounds; each round writes only its own.

## What changed since round 7

Round 7 reviewed `0f0975a`. Two commits followed:

- `04a81bb` fixed your finding: closing the panel now cancels a deferred reopen,
  so a teardown in that window cannot be left waiting on a replacement overlay.
- `b1e2e99` and `e505e9a` implement the architecture you recommended.

## What the controller change does

`static/src/session/history.js` now owns both entries. It holds a desired state
(`setup`, `live`, `panel`) and reconciles the browser history towards it, one
`pushState` or `back()` at a time; entries carry a session generation so an entry
from an earlier session is recognisable as stale. `ui/voice-options-sheet.js` no
longer touches history at all — it renders and follows the state it is handed,
and `session/lifecycle.js` wires the two together through
`configureVoiceSessionHistory`.

A teardown sets the goal to `setup` and leaves the voice entries one pop at a
time, completing when no voice entry is current. A popstate that is not a
teardown step sets the goal to whatever entry the browser landed on, whether the
app asked for that move or the user did — the special case for our own steps is
what made Forward behave differently by route, and `e505e9a` removes it.

## What the author could not finish

**Forward after the close button does not reopen the panel; Forward after browser
Back does.** Measured in a headless Chromium on a fresh page each time:

| Route | after closing | after Forward |
| --- | --- | --- |
| browser Back | `kind: live`, popstate observed | `kind: panel`, panel open |
| close button | `kind: live`, **no popstate observed** | `kind: live`, panel stays closed |

The close button's `history.back()` does not deliver its popstate before the
Forward is issued in this environment, so there is no entry to move forward
into. `_stepInFlight` is false throughout, and the handler is now uniform, so the
author could not find the remaining cause. This is the same class of
route-dependent behaviour the controller was meant to remove.

**Test state:** 182 of 188 JavaScript tests pass. In the app-boot suite, 40 of 43
pass; the three failures are this Forward case and two related entry-count
assertions that still assume the old shape.

**Not independently verified:** the controller's own transition table. The tests
that accompanied it were adapted from the previous model rather than written as
the table you suggested, so they may share the implementation's assumptions.

## The question the author needs answered

You recommended the controller, and it is in. The author is now unsure whether to
finish it or roll it back, and would rather have your judgement than another
guess. Concretely, please advise one of:

1. **Continue with the controller.** Then say which of these is the cause of the
   Forward asymmetry, or what else to look at: the close path going through the
   reconciler while Back goes through the router; the deferred traversal after a
   programmatic `back()`; or the controller treating a generation-mismatched
   entry as `setup` while the entry is still on the stack.
2. **Roll back to `04a81bb`** — the state before the controller, where your
   round-7 finding was fixed, all tests passed, and seven scenarios were verified
   in a browser. The controller would become its own change, from `main`, with
   this history as context.
3. **Roll back further or differently**, naming the commit.

If you choose 2 or 3, say what you would keep from the controller work — the
module, the generation tags, or the sheet's separation from history — since those
are independently reasonable even if the reconciler is not.

## Review priorities

- Answer the question above; it gates the rest.
- If continuing: the transition table you proposed, written against the
  controller, plus the seven browser scenarios and the sentinel below the app
  baseline.
- Confirm whether the two round-6 and round-7 findings still hold under the
  controller: a rejection restoring the last accepted automatic-speaking value,
  and a deferred reopen being cancelled by a close.
- Confirm that no path can leave the app in setup while a voice entry is still
  current, or the reverse.

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

The author's run: 309 Python tests pass; the JavaScript suite passes 182 of 188,
three of the failures being the pre-existing PDF credit-copy tests.

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

Then list unresolved risks and untested paths, give an explicit merge-quality
verdict, and finish with your answer to the question above.

# Review prompt: mobile voice options (round 10)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the tenth
round. Review only; do not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-10.md`](pr-27-feature-mobile-voice-options-findings-10.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify the files from earlier rounds; each round writes only its own.

## What changed since round 9

Round 9 reviewed `1421d6e` and confirmed the transition table and the seven
settled browser paths. It also found a lost server end notice, a pending-Forward
race in the teardown, and a reload test that replaced the stack it claimed to
retain.

`13ada89` does two things:

**The controller is reverted.** It was your round-7 recommendation and round 8
asked to continue, and the author agrees with the ownership boundary. But four
attempts at its pending-traversal race each repaired one sequence and broke
another — the last left ordinary panel closes failing, and the fix after that
(tracking a traversal count instead of a landing length) broke a wider set again.
Continuing to iterate on it inside this PR was making a reviewed feature less
predictable, so the branch went back to `04a81bb`, the state before the
controller: the last one verified end to end in a browser.

Your round-9 **finding 1 is fixed** and kept: `resetLiveRecordingToSetup()` no
longer clears `state.sessionEndMessage`, so a guardrail end notice survives the
teardown. The two exits that carry no notice — socket close and local finish —
clear it themselves, and `startListening()` still clears it when the next session
begins.

Your round-9 **finding 2 does not apply** to this state: there is no reconciler
and no traversal queue, so an earlier Forward cannot be mistaken for a pending
controller step.

Your round-9 **finding 3 is moot**: `tests/js/voice-history.test.mjs` and the
controller it tested are both removed.

## What this state is

`04a81bb` plus the end-notice fix. Verified in a headless Chromium, one scenario
per page load: close button, Forward after closing, teardown without the panel,
teardown with the panel open, teardown during a close, teardown after a rapid
reopen, and teardown after a Forward reopen. All seven end on the expected entry
with the app baseline current after a teardown.

185 of 188 JavaScript tests pass; the three failures are the pre-existing PDF
credit-copy tests. 309 Python tests pass.

## What the author needs from you

The controller is not in the branch, and the author does not intend to bring it
back without a different approach. Please advise:

1. **Is the reverted state mergeable?** It is the state you reviewed in rounds 4
   to 7 after the fixes — the plugin owns one history entry, and the teardown
   leaves voice entries one at a time without counting or jumping. Say whether
   any finding from rounds 5 to 9 still applies to it that the author has not
   carried over.
2. **If the controller is worth another attempt, what would you change about the
   approach rather than the code?** The failures clustered on one question: how a
   reconciler tells its own traversal apart from a navigation that was already
   pending. Length does not change during traversal, a count breaks when a goal
   changes mid-flight, and a boolean breaks when two are queued. If you have a
   shape that sidesteps that question — for example driving the desired state
   from popstate alone, or keeping the panel out of history entirely — say so and
   the author will take it to a separate branch with this history as context.
3. **Or is the honest answer to ship this and treat the panel's history
   behaviour as accepted?** Name anything you would document as a known
   limitation instead.

## Review priorities

- Answer the three questions above; they gate the rest.
- Re-check the end-notice fix: a guardrail `ended` with the panel closed and
  open, local finish, socket close, and the next session start. The notice must
  be visible in setup for the server end and absent for the other two.
- Confirm nothing from rounds 5 to 9 that survives in this state is unfixed —
  in particular the round-6 rejection behaviour (an older TTS echo must not
  reverse the latest automatic-speaking tap) and the round-7 deferral fix.
- Check the reverted files for edits left behind by the controller work.

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

The author's run: 309 Python tests pass; the JavaScript suite passes 185 of 188,
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

Then list unresolved risks and untested paths, give an explicit merge-quality
verdict, and finish with your answers to the three questions above.

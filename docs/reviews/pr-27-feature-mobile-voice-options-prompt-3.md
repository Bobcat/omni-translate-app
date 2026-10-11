# Review prompt: mobile voice options (round 3)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the third
round. Review only; do not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-3.md`](pr-27-feature-mobile-voice-options-findings-3.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify the files from rounds 1 and 2; each round writes only its own.

## What changed since round 2

Round 2 reviewed `098da82`. The fixes are in `8841a88`; `e038aef` records the
round-2 findings file as written.

**Finding 1** — `static/src/ui/voice-options-sheet.js` now marks its own
programmatic pop with a one-shot skip that `handleVoiceOptionsPopstate` consumes
before anything else, the pattern the language sheet uses. That handler no
longer pushes a `live_recording` entry when Back pops the overlay, because the
session entry is already current. `applySessionTeardown` in
`static/src/session/lifecycle.js` detects an open overlay and jumps over both
entries with `history.go(-2)` synchronously, because `history.back()` is
asynchronous and would never land before the setup transition runs.

**Finding 2** — `ttsSupportsVoiceSelection` validates the selected backend
against `state.ttsOptions.backends`, so a stored backend the server no longer
offers does not enable the modes.

**Finding 3** — the `tts_settings` echo in `static/src/session/messages.js`
calls `notifyVoiceOptionsChanged()` after merging the snapshot, so the open
panel follows server state.

**Finding 4** — the closed-socket branch of `finishSession()` calls
`applySessionTeardown()` instead of transitioning directly.

The history work was the delicate part, so it is worth saying how it was
checked: the author ran each scenario against a freshly reloaded page in a
headless Chromium, one scenario per load, because two scenarios in one load
share the history stack and interfere.

| Scenario | Result |
| --- | --- |
| Close button | `history.state.view` back to `live_recording`, `appMode` live, panel hidden |
| Browser Back | same, and the stack is not duplicated |
| Teardown with the panel open | setup reached, no overlay entry left current |

## Review priorities

- Re-check the three history paths above, and the ones the table does not
  cover: the scrim, a completed swipe, Forward after closing, Back while the
  panel is open during an in-flight session end, and two open/close cycles in a
  row. The author's per-load isolation is a hint that history state is easy to
  corrupt; look for orders that leave the app live on a setup entry, or setup on
  an overlay entry.
- Confirm the one-shot skip cannot be left set: the teardown path deliberately
  does not set it, and the author removed an earlier version that did because a
  jump landing at the baseline emits no popstate and the stale flag swallowed
  the next real Back. Check whether any other path can leave it behind.
- Finding 2: confirm the offered list is the right source, including when the
  server reports no backends at all, and check the four combinations the round-2
  table lists.
- Finding 3: confirm the echo cannot make the panel fight the user — the switch
  the user just tapped against a snapshot that arrives out of order.
- Confirm the round-1 fixes still hold, especially that no path sends a partial
  TTS delta and that the capability the request uses matches the panel.
- Check the tests added in this round actually fail against the round-2 code:
  the close-button, scrim, Back, teardown, closed-socket finish, offered-backend
  and echo cases.

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

The author's run: 309 Python tests pass; the JavaScript suite passes 168 of 171,
the three failures being the pre-existing PDF credit-copy tests.

Still unverified by anyone: a real session with a microphone. Live voice
switching, clone preparation, websocket loss mid-session, PCM autoplay policy
and swipe-to-close have not been exercised on a device.

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

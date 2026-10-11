# Review prompt: mobile voice options (round 4)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the fourth
round. Review only; do not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-4.md`](pr-27-feature-mobile-voice-options-findings-4.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify the files from earlier rounds; each round writes only its own.

## What changed since round 3

Round 3 reviewed `cf3c9fa`. The fixes are in `b1ed94f`; `996934e` records the
round-3 findings file as written.

**Finding 1** — `handleVoiceOptionsPopstate` now reads `event.state`. A popstate
into `voiceOptionsSheet` reopens and renders the panel and is consumed; a
popstate away from it closes the panel. A stale Forward entry is refused unless
the app is in live recording, so a Forward after teardown cannot bring session
UI back. The sheet also exposes `resetVoiceOptionsSheetHistory()`, and the
session teardown calls it, because a flag left over from an interrupted close
could disable the next open or swallow the next Back.

**Finding 2** — `ttsSupportsVoiceSelection` honours an authoritative backend
list even when it is empty.

**Finding 3** — the session module keeps the automatic-speaking value that is
awaiting its echo and drops an older opposite `auto_speak` from a snapshot
before it is merged; the value clears when the matching echo arrives or the
session tears down.

The author verified four scenarios in a headless Chromium, **one scenario per
page load** because two scenarios in one load share the history stack:

| Scenario | Result |
| --- | --- |
| Forward after closing the panel | panel reopens, session live |
| Forward after browser Back | panel reopens, session live |
| Close button | session live, session entry current |
| Teardown with the panel open | panel closed, app in setup, a Forward afterwards does not reopen the panel |

## What the author could not settle

Be direct about this one, because it is the most likely place for a remaining
defect:

`applySessionTeardown` counts the entries to leave — the panel's overlay, which
may still be in flight from a close, plus the session entry — and jumps them with
one synchronous `history.go(-N)`. In the unit tests that lands on the baseline
entry. In the browser, with a session entry planted by the test harness rather
than by the app's own mode transition, the app sometimes ends in setup with a
`live_recording` entry still current instead of the baseline. The author could
not determine whether that is an artefact of the harness (which sets
`state.appMode` directly instead of going through the app's session start) or a
real ordering problem between the panel's asynchronous close and `history.go`.

Please settle it: drive a real session start if you can, or reproduce the harness
setup and say which it is. Note what a stale current entry costs in practice:
Forward from it reaches the overlay, which the handler refuses because the app is
no longer live, so the panel does not reopen — the cost is a dead Back/Forward
press rather than a visible defect.

## Review priorities

- Settle the paragraph above.
- Re-check the four scenarios, plus: Forward twice, Back while a session end is
  in flight, a completed swipe, rapid close then reopen before the first
  popstate lands, and two open/close cycles.
- Finding 3: check the pending automatic-speaking value against a rejected
  update, a socket drop before the echo, a session end, and an echo that never
  arrives. Say whether the value can be left pending so the server is never
  authoritative again.
- Finding 2: confirm an absent or non-array `backends` field is the only input
  that falls back to the capability flag.
- Confirm the round-1 and round-2 fixes still hold, particularly that no path
  sends a partial TTS delta and that closing the panel never ends a session.

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

The author's run: 309 Python tests pass; the JavaScript suite passes 173 of 176,
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

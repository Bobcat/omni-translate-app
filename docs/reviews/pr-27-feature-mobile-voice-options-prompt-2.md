# Review prompt: mobile voice options (round 2)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the
second round. Review only; do not modify the implementation. Record the outcome
in
[`pr-27-feature-mobile-voice-options-findings-2.md`](pr-27-feature-mobile-voice-options-findings-2.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify
[`pr-27-feature-mobile-voice-options-prompt-1.md`](pr-27-feature-mobile-voice-options-prompt-1.md)
or
[`pr-27-feature-mobile-voice-options-findings-1.md`](pr-27-feature-mobile-voice-options-findings-1.md);
each round writes only its own files. If you disagree with how a round-1 finding
was resolved, say so in `-findings-2.md` rather than editing the earlier record.

## What changed since round 1

Round 1 reviewed `9291e50`. The fixes are in `1898447`; `96cf4ae` bumps the app
entry version and records the round-1 findings file exactly as written.

Every finding was reproduced before it was fixed, and two were reproduced
against the running backend:

- Finding 1: `POST /api/sessions` with `tts_settings.backend = "kokoro"` and
  `voice_mode = "female"` returns 422 `requires the active VoxCPM TTS backend`;
  the same request without `voice_mode` returns 200.
- Finding 2: `app/runtime.py` `_update_tts_settings` assigns the snapshot that
  `tts_bridge.tts_settings_snapshot` built from the *server base* plus the
  submitted fields, so a one-field delta does replace the rest.

**Finding 1** — `voiceModeAvailable()` now follows the settings that are
actually submitted (`static/src/settings/tts.js:ttsSupportsVoiceSelection`:
capability flag *and* a backend that implements the modes), and
`sessionVoiceMode()` returns `null` when the modes are unavailable, so
`static/src/session/lifecycle.js` omits `voice_mode`. The capability is also
refreshed per session request rather than frozen at startup.

**Finding 2** — the panel's change handler sends
`sessionTtsSettingsPayload()` through the socket
(`static/src/ui/voice-options-sheet.js`), the same full payload the TTS settings
page sends. `setAutoSpeak` in the session module no longer sends anything
itself.

**Finding 3** — the sheet owns exactly one overlay history entry while open and
restores the `live_recording` entry when Back closes it
(`static/src/ui/voice-options-sheet.js`). The round-1 test that asserted
`history.current === null` was replaced.

**Finding 4** — `configureVoiceOptions()` now restores the stored mode and
fallback and clears any prior cloning status.

**Finding 5** — the radio group follows voice-mode availability, automatic
speaking follows `state.ttsSettings.enabled`.

**Finding 6** — the session module takes the shared audio queue in
`configureVoiceOptions` and calls `preparePcmPlayback()` when automatic
speaking turns on.

**Finding 7** — `applySessionTeardown()` in `static/src/session/lifecycle.js`
closes the panel, resets the session-only voice state and returns to setup. The
server `ended` path, the socket-close callback and `finishSession()` all route
through it.

## Review priorities

- Re-check each finding above against the new code, and say which of them the
  new tests would actually catch. Two are known to be thin: the socket-close
  and server-`ended` teardown paths are covered through the shared transition
  rather than by driving a real socket, and the panel's full-payload send is
  asserted in the app-level test rather than end to end.
- Finding 1's capability now depends on the submitted backend. Check the
  combinations: capability false with a VoxCPM backend, capability true with
  Kokoro, a stored dev-only backend, and a backend the server no longer offers.
  Confirm the request and the panel agree in each case.
- Finding 2: confirm no path still sends a partial TTS delta, including the
  dev-gated TTS settings page and any retry after the server rejects an update.
  Check what happens when the server's `tts_settings` echo differs from what the
  panel just sent.
- Finding 3: trace Back, the close button, the scrim, swipe-to-close, the
  session ending while the panel is open, and Forward afterwards. Confirm the
  history stack cannot end up with the app live on a setup entry, or with two
  overlay entries.
- Finding 7: confirm every transition out of live recording goes through the
  shared teardown, and that nothing now resets voice state twice.
- Look for regressions in what round 1 verified: the shared rules, the icon
  mount/unmount, the module graph and the cache-busting versions.

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

The author's run: 309 Python tests pass; the JavaScript suite passes 161 of 164,
the three failures being the pre-existing PDF credit-copy tests.

The author also checked three of the fixes in a headless Chromium against the
dev server: the capability now reports available on the voice-capable backend
and `null` for the session mode on Kokoro while automatic speaking stays
enabled, and Back from the open panel returns `history.state.view` to
`live_recording` with the app still live. Reproduce what you can; none of that
is in the test suite.

**Not exercised by anyone:** a real session with a microphone. Live voice
switching, clone preparation, websocket loss mid-session, PCM autoplay policy
and swipe-to-close remain unverified on a device.

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

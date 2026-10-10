# Review findings: mobile voice options, round 3

Review of PR #27, `feature/mobile-voice-options`, at `cf3c9fa`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-3.md`](pr-27-feature-mobile-voice-options-prompt-3.md).

All required checks pass in this checkout. The Python commands used the
repository virtual environment because this shell has no global `python`.

| Check | Result |
| --- | --- |
| `.venv/bin/python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 171 tests, pass on Node 18.19.1 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `.venv/bin/python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |
| Round-3 mobile tests against round-2 commit `098da82` | all 7 new tests fail as intended |

The three pre-existing PDF credit-copy failures named in the prompt did not
reproduce; all 171 JavaScript tests passed.

**Merge-quality verdict: do not merge yet. Browser Forward deterministically
ends the active voice session and leaves setup on an overlay entry. Empty
backend discovery and an older TTS echo also still produce incorrect panel and
request state.**

## Findings

### 1. HIGH — Forward from a closed panel ends the live session and strands the overlay entry

**Where** — `static/src/ui/voice-options-sheet.js:77-100` and
`static/src/session/lifecycle.js:463-480`, `:529-545`. The history tests at
`tests/js/mobile-settings-and-voice.test.mjs:220-284` have no Forward case.

Trigger:

1. Start a live session and open Voice options. The stack is baseline ->
   `live_recording` -> `voiceOptionsSheet`.
2. Close the panel with its button, scrim, completed swipe, or browser Back.
   The browser lands on `live_recording`; the overlay remains as a Forward
   entry.
3. Use browser Forward.

The resulting `popstate` carries `{ view: "voiceOptionsSheet" }`, but
`handleVoiceOptionsPopstate()` ignores the event state. Because the sheet is
hidden, it returns `false`. The outer router sees a live session and falls
through to `finishSession()`. Teardown then sees a hidden sheet while the
overlay entry is current, so it does not take the `history.go(-2)` branch. The
user unexpectedly loses the session and the app reaches setup with
`voiceOptionsSheet` still current.

The ordinary round-2 paths now work, but they do not establish that every
popstate while live means Back. Forward has the opposite meaning here: it
re-enters the overlay.

**Smallest safe correction** — make the voice-sheet handler use `event.state`.
While the app is live, a popstate into `voiceOptionsSheet` should reclaim and
render that overlay, then consume the event. A popstate away from it while the
sheet is visible should close the sheet. Keep the app-mode guard so a stale
Forward entry cannot reopen session UI after teardown.

**Missing regression test** — add `forward()` to the history harness. Cover
Forward after both a programmatic close and browser Back. Assert that the panel
reopens, the session remains live, no finish command is sent, and Back returns
to the one existing live entry.

### 2. MEDIUM — an explicitly empty backend list still enables a stored VoxCPM mode

**Where** — `static/src/settings/tts.js:113-125`. The new capability test at
`tests/js/mobile-settings-and-voice.test.mjs:313-325` covers a non-empty list
without the selected backend, but not an empty list.

Set `voice_selection: true`, retain `nanovllm_voxcpm` as the selected stored
backend, and let the server report `options.backends: []`. This is a valid
authoritative response when no TTS backend is loaded. `applyTtsConfig()` keeps
the empty array, and the settings page itself reports `none loaded` for it.

`ttsSupportsVoiceSelection()` only checks the offered list when
`offered.length` is non-zero. It therefore returns `true` for this input. The
panel enables Female, Male, and Clone speaker, and `sessionVoiceMode()` includes
the stored mode in the session request even though the server offered no
backend.

The other requested combinations now behave consistently: capability false
disables the modes, Kokoro disables them, an offered voice-capable backend
enables them, and a non-empty list that omits the stored backend disables them.

**Smallest safe correction** — when `backends` is an array, always require a
matching entry. An empty array must return `false`; only a genuinely absent or
invalid field needs an explicit policy.

**Missing regression test** — set `state.ttsOptions.backends = []` and assert
that both `voiceModeAvailable()` is false and `sessionVoiceMode()` is null.

### 3. MEDIUM — an older TTS echo visibly reverses the user's latest switch change

**Where** — `static/src/ui/voice-options-sheet.js:38-47`,
`static/src/session/voice-options.js:106-115`, and
`static/src/session/messages.js:132-139`. The new echo test at
`tests/js/mobile-settings-and-voice.test.mjs:327-338` invokes the render
notification directly and covers only one authoritative snapshot.

Trigger:

1. Tap Automatically speak off. The client applies and sends snapshot A.
2. Before A's echo arrives, tap it on. The client applies and sends snapshot B.
3. Receive A's valid `tts_settings` echo, followed later by B's echo.

WebSocket ordering preserves A before B, but it does not prevent the second tap
before A returns. The A echo overwrites `state.ttsSettings.auto_speak` and the
new notification immediately renders the switch off, undoing the latest tap in
front of the user. B normally restores it. If B is rejected or the socket
closes, runtime state and the persisted latest choice remain split.

**Smallest safe correction** — serialize this control while an update is
pending, or retain the latest pending `auto_speak` value and do not render an
older opposite echo over it. Clear the pending value only when the matching
echo arrives, with an explicit rejection/socket-close path.

**Missing regression test** — drive the real matching-session message handler:
send two opposite local changes, deliver the first echo, and assert that it
does not reverse the latest visible choice. Then deliver the matching latest
echo and assert that pending state clears.

## What holds up

- Close button and scrim now stay live after their asynchronous popstate.
  Browser Back closes the panel without duplicating the live entry. Direct
  teardown with the overlay current reaches the baseline entry.
- Open- and closed-socket local finish both use shared session teardown and
  clear cloning state.
- The mobile automatic-speaking control still sends the full TTS snapshot;
  there is no new partial-delta path.
- Panel availability and `sessionVoiceMode()` use the same predicate, so they
  agree for every input except the empty-list defect in finding 2.
- Stored voice modes, PCM preparation, cloning fallback/status, icon lifetime,
  cache busting, and the round-1 teardown paths remain intact.
- Each of the seven tests added for the round-2 findings fails against the
  round-2 source and passes against the reviewed commit.

## Unresolved risks and untested paths

- The history test double changes its current index synchronously in
  `back()`/`go()`, while browser traversal itself is asynchronous. It therefore
  does not model a server end or socket close arriving after Back was requested
  but before traversal completed. The concurrent `history.back()` and
  `history.go(-2)` ordering remains unverified in a real browser.
- Two settled open/close cycles follow the intended ownership transitions, but
  rapid close/reopen before the first popstate is not covered. The one-shot
  skip has no timeout or transition identity, so this should be included in the
  browser-level history regression.
- A completed swipe calls the corrected close function, but the gesture itself
  was not exercised.
- No real microphone/device session was run. Live mode switching, clone
  preparation, websocket loss, PCM autoplay policy, and audio capture remain
  unverified.

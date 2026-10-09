# Review findings: mobile voice options, round 1

Review of PR #27, `feature/mobile-voice-options`, at `9291e50`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-1.md`](pr-27-feature-mobile-voice-options-prompt-1.md).

All required checks pass in this checkout:

| Check | Result |
| --- | --- |
| `python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 155 tests, pass on Node 18.19.1 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |

**Merge-quality verdict: do not merge yet. Mobile sessions cannot start with a
TTS backend that does not expose voice selection, and the new automatic-speaking
control can replace the active session's complete TTS configuration. The panel
also has persistence, history, playback-unlock and teardown defects.**

## Findings

### 1. HIGH — mobile session creation always submits a voice mode, including to unsupported backends

**Where** — `static/src/session/voice-options.js:58-61`,
`static/src/session/lifecycle.js:88-94`, `app/router.py:638-646`, and
`app/voice/mode.py:24-30`.

`sessionVoiceMode()` returns `female` even when `configureVoiceOptions()` was
given `available: false`. `startListening()` passes that value to every session
request. The backend deliberately accepts an omitted mode on an incompatible
backend but rejects any explicit product mode with 422. A direct check of the
shipped contract returns:

```text
normalize_voice_mode("female", supported=False)
-> ("female", {"voice_mode": "requires the active VoxCPM TTS backend"})
```

The concrete trigger is a mobile deployment using Kokoro, including the default
in `config/settings.json`: tap **From microphone** and session creation fails
before the websocket opens. A second trigger exists when the advertised default
supports modes but the persisted dev-only TTS choice changes the effective
session backend to Kokoro. Desktop already avoids the first failure by omitting
`voice_mode` when its selector is unavailable.

**Smallest safe correction** — omit `voice_mode` unless voice selection is
available for the effective TTS settings being submitted. Do not use only the
startup capability flag when the mobile TTS backend can change independently.

**Missing regression test** — boot the mobile path with
`capabilities.voice_selection: false` and assert that the session request omits
`voice_mode` and succeeds. Add the capability-true/stored-Kokoro combination as
a second case.

### 2. HIGH — changing automatic speaking replaces the rest of the session TTS settings

**Where** — `static/src/session/voice-options.js:89-95`, compared with the full
payload at `static/src/settings/tts.js:136-146` and `:373-375`; server replacement
semantics are in `app/runtime.py:302-337` and `app/tts_bridge.py:853-862`.

The new panel sends only `{ auto_speak: next }`. The websocket handler does not
merge that delta into the session's current settings. It calls
`tts_settings_snapshot()`, which starts from the server's configured base and
then applies the submitted fields. Therefore this sequence loses live settings:

1. Start a mobile session with a persisted or dev-selected backend, Kokoro
   voices, VoxCPM language settings, or ultimate-cloning settings.
2. Toggle **Automatically speak translations** in the new panel.
3. The server replaces the session snapshot with its base configuration plus
   the boolean, then echoes that replacement into mobile state.

If speaker cloning is active and the configured base is not a VoxCPM backend,
the server rejects the partial update instead. The panel has already changed
and persisted the local boolean, so the switch and the server then disagree.
This makes the otherwise excluded detail controls unsafe specifically through
the new panel.

**Smallest safe correction** — send the same `sessionTtsSettingsPayload()` used
by the existing TTS settings page. Also refresh the open voice panel from the
`tts_settings` echo so server state remains authoritative.

**Missing regression test** — seed non-default backend and nested voice settings,
toggle automatic speaking, and assert that the websocket payload retains the
complete snapshot. Cover the clone case against a non-VoxCPM configured base.

### 3. MEDIUM — Back closes the sheet after it has already popped the live-session entry

**Where** — `static/src/ui/voice-options-sheet.js:48-66` and
`static/src/session/lifecycle.js:488-517`; the misleading coverage is
`tests/js/mobile-settings-and-voice.test.mjs:373-388`.

Opening the panel deliberately pushes no history entry. A live session already
sits on `{ view: "live_recording" }`. Browser Back first moves the browser to
the preceding setup entry and only then dispatches `popstate`. The handler hides
the sheet and returns, but it cannot cancel that navigation. Application state
therefore remains live while `history.state` is the setup entry. A second Back
can leave the document without taking the session finish path; Forward back to
the live entry instead triggers `finishSession()` unexpectedly.

The current test reproduces the pop but asserts that `history.current === null`.
That proves the session entry was consumed, despite the test comment claiming
the session entry is still current.

**Smallest safe correction** — when Back is consumed by this no-history sheet,
restore the live-session history entry before returning. Alternatively give the
sheet one explicit overlay entry and pop exactly that entry on every close path.

**Missing regression test** — start from a real `live_recording` entry, open the
sheet, go Back, and assert both `state.appMode === live_recording` and
`history.state.view === live_recording`. A second Back must finish the session,
not navigate away.

### 4. MEDIUM — a stored voice choice is ignored on a fresh mobile load

**Where** — `static/src/session/voice-options.js:25-39` and `:126-137`.

The module starts `_options.mode` at `female`. `configureVoiceOptions()` restores
only the automatic-speaking preference. It never calls `storedVoiceMode()` or
initializes the fallback from it. `resetVoiceOptions()` does that work, but it
is called only after one server-driven `ended` event.

Trigger: select Male or Clone speaker, reload the page, and start the first
session. `loadVoiceModePreference()` returns the saved value, while
`sessionVoiceMode()` still returns `female`; the request and UI use Female. The
storage-only test named `product voice mode is separate and survives reload`
does not exercise the session module's initialization.

**Smallest safe correction** — initialize the mode and fallback from
`storedVoiceMode()` in `configureVoiceOptions()`, and clear any prior cloning
status there.

**Missing regression test** — pre-seed `voice_mode`, configure a fresh module,
and assert the first session mode for both Male and Clone speaker. Include a
malformed value resolving to Female.

### 5. MEDIUM — automatic speaking is disabled when only voice selection is unavailable

**Where** — `static/src/ui/voice-options-sheet.js:69-91`.

The automatic-speaking switch is disabled from `!voiceModeAvailable()`. Voice
selection and speech playback are separate capabilities. Kokoro cannot select
the three product modes, but it can still speak translations automatically.
After finding 1 is corrected, a Kokoro session will open this panel with its
only usable setting disabled. This also differs from the desktop specification,
where the mode field follows `voiceModeAvailable` but automatic speaking is
disabled only when TTS itself is disabled.

**Smallest safe correction** — gate the radio group on voice-mode availability
and gate automatic speaking on `state.ttsSettings.enabled`.

**Missing regression test** — with TTS enabled and voice selection unavailable,
assert disabled voice radios and an enabled automatic-speaking switch.

### 6. MEDIUM — enabling automatic speaking does not unlock PCM playback from the user gesture

**Where** — `static/src/session/voice-options.js:89-95`. The established mobile
and desktop paths are `static/src/settings/tts.js:212-218` and
`static/desktop/src/views/voice/session.js:698-704`.

Start a session with automatic speaking off, then enable it from the new panel.
Unlike both existing controls, this path does not call
`audioQueue.preparePcmPlayback()` inside the change gesture. On browsers that
suspend a new `AudioContext` until a user gesture, the next automatic PCM stream
stays at **Audio ready** and requires a second manual resume action. It therefore
does not speak automatically.

**Smallest safe correction** — inject or otherwise call the shared audio queue's
`preparePcmPlayback()` when the setting changes from false to true.

**Missing regression test** — spy on playback preparation and assert one call
when enabling, and no call when disabling.

### 7. MEDIUM — websocket-close and local-finish paths do not tear down the voice panel state

**Where** — `static/src/session/lifecycle.js:101-106`, `:168-192`, and
`:455-461`, compared with the server `ended` path in
`static/src/session/messages.js:153-164`.

Only an accepted `ended` message closes the sheet and calls
`resetVoiceOptions()`. An unexpected websocket close calls
`resetLiveRecordingToSetup()` without either action. If the voice sheet is open
when connectivity drops, the app returns to setup and detaches the titlebar icon
but leaves the sheet visible with the ended session's cloning status. The local
`finishSession()` path also clears `sessionId` before a later `ended` message can
be accepted, so it never performs the voice-state reset.

**Smallest safe correction** — put voice-sheet closure and session-only voice
state reset in the common transition from live recording to setup, then remove
the duplicated cleanup from the message-only path.

**Missing regression test** — end through a server event, a socket close, and
the local finish action while the panel is open. Each path must hide the sheet,
clear cloning status, and leave the stored mode available for the next session.

## Shared-rule and regression review

- The extracted fallback helper matches the old desktop implementation for all
  18 reachable combinations of requested mode, active mode and stable fallback.
  `male -> female -> speaker_clone` ends with Female as the fallback in both
  frontends, and `voiceModeSelectionStatus()` reports that same voice.
- Unreachable inputs resolve safely: an unknown stored mode normalizes to
  Female; `speaker_clone`, unknown, and `undefined` fallbacks are ignored unless
  a stable selected or current mode wins, otherwise Female is used. An unknown
  direct request can temporarily preserve a stable current fallback internally,
  but the selected mode and emitted status normalize to Female; the shipped UI
  and storage cannot produce that request.
- The desktop status mapping and visible status/guidance text are unchanged for
  valid payloads. Constants, fallback logic and status text now each have one
  implementation under `static/src/domain/`.
- A valid mode change before a session or while its socket is closed updates
  local state and persistence without sending. Existing subscribed/queued audio
  is not re-voiced; the server retains subscribed preparation and applies the
  new mode to later synthesis, matching desktop behavior.
- Both storage readers reject malformed values: automatic speaking accepts only
  a boolean and voice mode accepts only the three product values. The app-storage
  reset includes both keys and reloads, so it restores the configured automatic
  speaking default and Female. Finding 4 is the remaining initialization gap.
- Detaching and reattaching the same icon node preserves its click listener.
  Repeated renders do not create copies, attachment clears `hidden`, and setup
  plus image modes remove it. The image CSS also keeps all right-side titlebar
  controls hidden.
- The mobile and desktop module-graph tests pass with one URL per source module.
  The mobile entry and changed stylesheet have new cache-busting versions. No
  new fatal module cycle was introduced; the existing lifecycle/messages cycle
  still resolves because it uses functions after module initialization.
- No authorization or backend write surface was added. The branch changes the
  session request and websocket controls only.

## Unresolved risks and untested paths

- No real microphone or browser session was run. Live voice switching, clone
  preparation, websocket loss, PCM autoplay policy, swipe-to-close, and the
  Back/Forward findings above remain unverified on a device.
- I did not reproduce the author's Chromium measurements at 390, 360 and 320px.
  The CSS offsets reserve the reported 8px gaps, but a translated or otherwise
  longer speech-detected badge was not measured.
- The desktop voice state machine still has no end-to-end test. Its extracted
  valid-input rules compare equal to `main`, but live websocket and audio
  behavior remains reasoned rather than exercised.

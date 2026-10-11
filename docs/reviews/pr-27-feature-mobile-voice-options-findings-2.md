# Review findings: mobile voice options, round 2

Review of PR #27, `feature/mobile-voice-options`, at `098da82`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-2.md`](pr-27-feature-mobile-voice-options-prompt-2.md).

All required checks pass in this checkout:

| Check | Result |
| --- | --- |
| `python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 164 tests, pass on Node 18.19.1 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |

**Merge-quality verdict: do not merge yet. The ordinary close button, scrim and
swipe paths can end the live session, and session teardown can leave a voice
overlay entry current. Three lower-severity lifecycle and synchronization gaps
also remain.**

## Findings

### 1. HIGH — the new history bookkeeping ends sessions and leaves stale entries

**Where** — `static/src/ui/voice-options-sheet.js:56-92` and
`static/src/session/lifecycle.js:461-464`, `:500-528`. The incomplete tests are
`tests/js/mobile-settings-and-voice.test.mjs:362-404` and `:491-518`.

The history fix has three broken paths:

1. The close button, scrim and completed swipe call
   `closeVoiceOptionsSheet()`. It clears `_ownsHistoryEntry` and hides the sheet
   before calling `history.back()`. When the asynchronous `popstate` arrives,
   `handleVoiceOptionsPopstate()` sees a hidden, unowned sheet and returns false.
   The router falls through to `finishSession()`. Closing the options panel thus
   ends the live voice session.
2. Browser Back already lands on the existing `live_recording` entry after it
   pops the overlay. `handleVoiceOptionsPopstate()` nevertheless pushes another
   `live_recording` entry. The stack becomes setup -> live -> live. The next
   Back finishes on the older live entry and leaves setup UI on a history entry
   still labelled `live_recording`.
3. Server end or socket loss while the panel is open calls
   `closeVoiceOptionsSheet({ popHistory: false })`. The overlay remains current.
   `resetLiveRecordingToSetup()` then cannot pop the session entry because
   `history.state.view` is `voiceOptionsSheet`. The app reaches setup on a stale
   overlay entry.

A direct run of the first sequence produced this state after clicking Close and
waiting for `popstate`:

```json
{"appMode":"setup","current":{"view":"live_recording"},"stack":[null,{"view":"live_recording"},{"view":"voiceOptionsSheet"}]}
```

The close-button tests assert synchronously, before the queued `popstate`, and
do not set `state.appMode` to live. The Back test checks only the current label,
not the duplicate entry. The teardown test calls the shared helper directly and
does not inspect history. The first open-sheet test also leaves the module's
ownership flag set; `beforeEach` hides the DOM node but cannot reset that flag,
so later history cases do not all start from their claimed state. Scrim, swipe
and Forward are not covered.

**Smallest safe correction** — give programmatic overlay pops their own
one-shot popstate skip, as the language sheet does. A user Back should consume
the existing overlay and leave the already-current live entry untouched. A
session teardown while the overlay is current must remove both overlay and live
entries, or first normalize the overlay to the live entry before the existing
session-history cleanup runs.

**Missing regression test** — for close button, scrim and swipe, await the
popstate and assert that the app remains live, the socket did not receive a
finish action, and exactly one live entry is current. For browser Back, assert
the complete stack before and after a second Back and Forward. For server end
and socket close, assert setup on the baseline entry with no overlay or live
entry left current.

### 2. MEDIUM — capability can disagree with the backend the server actually offers

**Where** — `static/src/settings/tts.js:86-116` and `:118-132`, together with
the server payload semantics in `app/tts_bridge.py:362-377`.

`ttsSupportsVoiceSelection()` combines the startup capability boolean with a
hard-coded family check. It does not check `state.ttsOptions.backends`, even
though that is the server's current list of loaded backends. The capability
boolean is also not deployment-wide: the server computes it from the configured
default backend.

This produces both mismatches requested by the prompt:

| Configuration | Panel and request |
| --- | --- |
| capability false, offered and selected VoxCPM | modes disabled; `voice_mode` omitted even though the submitted backend supports it |
| capability true, selected Kokoro | modes disabled; `voice_mode` omitted |
| capability true, selected and offered NanoVLLM VoxCPM | modes enabled; stored mode submitted |
| capability true, stored VoxCPM no longer present in `options.backends` | modes enabled; `voice_mode` submitted for an unavailable model |

The last combination occurs after the server stops offering a formerly stored
backend. `mergeStoredTtsConfigIntoState()` accepts the stale name, and the new
predicate treats it as available because it remains in the hard-coded family.
The session route accepts that known name, but synthesis later targets a model
the pool did not advertise. The first combination occurs when Kokoro is the
configured default while an offered VoxCPM backend is selected through the
persisted dev setting.

**Smallest safe correction** — validate a stored backend against
`ttsOptions.backends` before applying it. Derive mode availability from TTS
enabled state, the effective backend family and presence in that offered list.
If the capability flag is intended as a separate kill switch, change the server
to report that meaning rather than the configured default's current state.

**Missing regression test** — cover all four rows above, including a stored
voice-family backend that is absent from `ttsOptions.backends`. Assert the
radio state and `sessionVoiceMode()` together.

### 3. MEDIUM — a differing `tts_settings` echo does not update the open panel

**Where** — `static/src/session/messages.js:131-135` and
`static/src/ui/voice-options-sheet.js:113-139`.

The full-payload send fixes the destructive update. The echo path still merges
the server snapshot and renders only the dev TTS page. It does not notify or
render the open voice panel.

Trigger: keep the voice panel open while an earlier TTS update is in flight,
then change automatic speaking in the panel. If the earlier server echo arrives
with the opposite `auto_speak` value, state follows the server while the visible
switch keeps the value just tapped. The later echo normally converges the state,
but the control is wrong during the race. A rejected later update or a socket
drop can leave that disagreement in place. A backend change in an echo likewise
does not refresh the radio availability.

**Smallest safe correction** — route a `tts_settings` echo through the voice
options change notification, or render the open voice sheet after merging the
snapshot.

**Missing regression test** — open the panel, deliver a matching-session
`tts_settings` message with the opposite automatic-speaking value and a changed
backend, then assert the switch and radio disabled states against the merged
server state.

### 4. MEDIUM — the closed-socket local finish path still bypasses shared teardown

**Where** — `static/src/session/lifecycle.js:169-175`.

The server `ended` path, socket-close callback and local finish with an open
socket now call `applySessionTeardown()`. The early branch for a socket that is
already closed still calls `setLiveRecordingAppMode(SETUP)` directly.

Trigger: the websocket enters a non-open state and the user presses Back before
its close callback runs. The app returns to setup without resetting cloning
status or applying the shared panel cleanup. The later close callback may repair
it, but the branch itself violates the new teardown invariant and a stale socket
callback can be ignored by its identity guard.

**Smallest safe correction** — replace the direct setup transition in the
non-open branch with `applySessionTeardown()` after client cleanup.

**Missing regression test** — call `finishSession()` with a live app and a fake
closed socket. Assert panel, cloning status, app mode and history. The current
test loops over three labels but invokes `applySessionTeardown()` directly for
all three, so it does not exercise any routing path.

## Round-1 fix verification

| Round-1 finding | Result | Would the new test catch the old behavior? |
| --- | --- | --- |
| 1. Unsupported-backend session request | partly resolved; effective backend is consulted, but offered-backend validation remains finding 2 | yes for Kokoro and a supported NanoVLLM backend; no for capability false plus VoxCPM or a removed stored backend |
| 2. Partial automatic-speaking update | resolved for mobile | yes; the app-level test fails when only `{ auto_speak }` is sent, though it is not end to end |
| 3. Back consumes the live entry | replaced by a new broken history flow; finding 1 | yes for the original no-overlay implementation, but not for the new asynchronous and duplicate-entry defects |
| 4. Stored mode ignored on reload | resolved | yes for Male, Clone and malformed storage |
| 5. Automatic speaking tied to voice selection | resolved | yes for enabled Kokoro and disabled TTS |
| 6. PCM playback not unlocked | resolved | yes; the queue spy checks the false-to-true transition |
| 7. Incomplete session teardown | partly resolved; finding 1 covers history and finding 4 covers the closed-socket branch | yes for removal of the shared helper, but the test does not drive any real exit path |

## What holds up

- Mobile's panel and dev-gated TTS settings page now send the same complete
  session snapshot. There is no mobile retry path that can fall back to a
  partial delta. Desktop still sends `{ auto_speak }`, but its voice view owns no
  other session TTS choices and starts from the same server base.
- Stored Male and Clone selections initialize the first mobile session. Invalid
  stored modes still resolve to Female. Teardown reloads the stored mode while
  clearing cloning status.
- Enabling automatic speaking prepares PCM playback within the change gesture.
  Disabling it and repeated enabled values do not prepare again.
- The shared selection rules, `male -> female -> clone` fallback, desktop status
  mapping and single-source status text are unchanged from round 1.
- Icon attachment still preserves the listener, does not duplicate the node,
  and removes it in setup and image modes.
- Mobile and desktop module-graph tests pass. The mobile entry is bumped to
  `20261009-voice-options-4`; the changed CSS version remains valid because no
  CSS changed in the fix commit.
- Server `ended`, the socket-close callback and an open-socket local finish each
  call the shared teardown once. Their socket identity guards prevent a later
  close event from resetting voice state twice.

## Unresolved risks and untested paths

- No real microphone or device session was run. Live mode switching, clone
  preparation, socket loss, PCM autoplay and swipe-to-close remain unverified.
- I did not reproduce the headless Chromium run. The capability and Back tests
  above used the JavaScript modules and history stubs; the close-button failure
  was reproduced with an asynchronous popstate harness.
- The desktop voice state machine still has no end-to-end websocket or audio
  test. Its remaining partial automatic-speaking update is safe only while that
  view continues to expose no other TTS session settings.

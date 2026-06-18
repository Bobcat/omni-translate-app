# Mic auto-off — design

## Problem

The microphone stays on for as long as the session is `RUNNING` and
the user has the mic toggle on. Even during stretches of silence, the
client transmits 16 kHz PCM16 mono frames continuously — 32 kB/s, or
roughly 115 MB/hour over WebSocket. On a mobile data plan, a single
30-minute session can eat a meaningful chunk of the monthly budget.

The backend's rolling-context VAD already gates downstream work
(no LLM/TTS calls during silence), so the bytes spent on the wire
during quiet stretches are pure waste.

## Why this matters

1. **Mobile data cost.** Real users with capped plans avoid the app or
   pay for it. The wasted bytes are disproportionately concentrated in
   long-silent stretches where the system is doing nothing useful.

2. **Honest UX.** When the mic is "open but silent", the OS mic
   indicator stays on. The user has no signal that we're not actually
   transcribing — only that we're recording in vain. Pausing the
   transmission silently makes that worse, not better.

3. **Battery & sensor honesty.** The mic capture pipeline (AudioWorklet,
   getUserMedia track) keeps the audio sensor active. Real off ≠
   suppressed.

## Approach in the broader data-reduction strategy

Reducing mobile data has four orthogonal levers:

| | Mechanism | Wins on | Status |
|---|---|---|---|
| 1 | WebSocket permessage-deflate compression | Active speech *and* mic ambient noise; always-on baseline | Not yet implemented (future server config change) |
| 2 | **Auto-stop the mic on silence or bubble close** | Idle stretches (zero bytes during quiet) | **This document** |
| 3 | Client-side energy VAD + timing heartbeat protocol | Short pauses inside speech | Out of scope; protocol-invasive |
| 4 | Opus encoding instead of PCM16 on the wire | Always-on, biggest single reduction | Out of scope; large refactor |

Levers 1 and 2 stack cleanly: compression reduces bytes per frame *if*
we are transmitting; auto-off cuts how much we transmit at all. If the
user disables both auto-off triggers in the settings, only the
infrastructure-level levers (1/3/4) remain — which is why those should
not be forgotten as future work.

## Approach (this branch)

Auto-stop the mic capture entirely under one of two configurable
triggers. The bottom-bar stop-circle reverts to the mic icon (the
existing OFF state). Resume requires a deliberate tap.

### Trigger 1 — Sustained silence

After **N seconds** of continuous backend-detected silence (the
speech-gate already fires after `force_commit_silence_ms`; we count
how long the gate has been in the `quiet` state since the last speech
hit), the backend emits a `mic_auto_off` event. Frontend receives it,
calls `stopMicrophoneCapture()`, plays the audible cue (see below).

- Reuses the existing speech-gate signal — no new VAD plumbing.
- N is user-configurable; default suggested 30 s. Set to 0 / disabled
  for users who never want this.
- Counter resets whenever a speech-hit observation arrives, so a
  whispered word mid-pause keeps the mic alive.

### Trigger 2 — After bubble close (opt-in)

When a bubble closes via the heuristic layer (sentence boundary or
VAD silence — *not* the hard duration cap), the backend emits a
`mic_auto_off` event immediately. Frontend handles it the same way.

- Off by default. Targets the "translate-one-utterance-at-a-time" flow
  where the user expects to compose deliberately.
- The hard-cap close is excluded: that fires only when there is *no*
  natural stop signal, so it does not indicate intent to pause.

### Audible cue

When the frontend handles `mic_auto_off`, it plays a short Web Audio
tone (~150 ms, low volume, sine ~800 Hz). Generated via
`AudioContext.createOscillator()` — no asset file. Configurable on/off,
default on.

The cue must be distinguishable from the TTS playback start, so the
user can tell "we just stopped listening" from "we just started
playing back".

### User-facing settings

A new "Auto-off" section on the existing **Microphone** subpage
(`settingsMicrophonePage`), below the pre-gain/AGC controls. Three
controls:

| Setting | Type | Default |
|---|---|---|
| Auto-off after silence | duration select: 3 / 5 / 10 / 15 / 30 / 60 s / Off | `10 s` |
| Auto-off after each bubble | toggle | off |
| Play cue on auto-off | toggle | on |

Settings live in the existing `state.audioSettings` blob; persisted
the same way as `preGain` and `autoGainControl`. The existing
"Reset" button on the Microphone subpage covers these new values as
well — one reset action restores all mic defaults.

## Behaviour with concurrent flows

- **TTS playback in progress (`OPEN_SPEAKING`).** Mic is already gated
  off for transmission. The silence timer should *pause* while
  `OPEN_SPEAKING` — we don't want a TTS clip's wall time to count
  towards user silence. After playback completes, timer resumes from
  where it was.

- **Mic toggle off by user.** Already off — no auto-off to apply.

- **User starts talking just before the timer fires.** Speech-hit
  observations reset the counter. No false-off if the gate is doing
  its job.

## Key code touch points (orientation)

- [app/runtime.py](../app/runtime.py) `_send_vad_state` and
  `_enqueue_asr` — the speech-gate signal that backs Trigger 1.
- [app/runtime.py](../app/runtime.py) `_close_current_bubble` — the
  natural hook for Trigger 2 (after `is_closed` is set, before the
  refresh).
- [static/src/session/lifecycle.js](../static/src/session/lifecycle.js)
  `stopMicrophoneCapture` — the frontend action both triggers call.
- [static/src/session/messages.js](../static/src/session/messages.js) —
  new `mic_auto_off` event handler.
- [static/src/settings/audio.js](../static/src/settings/audio.js) and
  the audio settings panel — the three user-facing controls.
- New helper for the cue: short Web Audio oscillator in a small util
  module under `static/src/shared/`.

Backend silence-timer state lives per-lane on `ConversationLane` (e.g.
`silence_since_mono`); reset on every speech-hit, evaluated on every
dispatch tick.

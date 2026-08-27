# Responsive TTS delivery for voice translation

Status: streaming delivery is merged. Speculative generation, automatic
speaking, and the first review corrections are implemented on
`feature/speculative-auto-voice-tts` and await merge.

## Decision summary

Voice translation has two playback modes:

| Mode | Behavior after a definitive target bubble |
|---|---|
| Manual | Prepare speech ahead of a possible click. Stop preparing after eight consecutive bubbles without a playback request. |
| Automatic | Generate and play every definitive target bubble. The eight-bubble limit does not apply. |

Manual mode starts each voice session with speculative generation enabled. A
successful Speak or Replay request resets the eight-bubble window. This gives a
new user a responsive first click while bounding unused GPU work.

Automatic mode starts TTS as soon as a target bubble becomes definitive. This
is required work, not speculation. The browser plays the first PCM chunk while
the TTS pool generates the rest.

## Goals

- Start audible playback as early as the TTS pool permits.
- Make the first Speak interaction responsive for a new user.
- Avoid unlimited GPU work for users who do not play translated speech.
- Play definitive target bubbles automatically when the user enables that mode.
- Reuse one generation when preparation, playback, and replay refer to the same
  bubble and TTS configuration.
- Keep mobile and desktop voice behavior aligned.

## Non-goals

- Generate TTS from target preview text.
- Change ASR, translation-services, or TTS-pool model behavior.
- Persist audio on the browser device as application data.
- Add a legacy protocol alongside the streaming protocol.
- Guarantee zero click-to-audio latency. An immediate click can arrive before
  the first PCM chunk exists.

## Terms

**Definitive bubble** means a closed turn part with non-empty committed target
text. Target preview text is not eligible because it can still change.

**Prepared artifact** means the complete WAV stored under the voice session's
server-side TTS directory. The browser receives its URL only when playback or
replay needs it.

**Speculative generation** means TTS generation before a manual playback
request. The result may remain unused.

**Subscribed generation** means the browser currently wants the result. The
backend forwards buffered and new PCM chunks over the session WebSocket.

## Implemented streaming flow

Manual Speak currently follows this path:

```text
browser Speak action
  -> session WebSocket: speak_part or speak_now
  -> app backend: TTS request
  -> tts-pool gRPC event stream
  -> app backend: base64 PCM WebSocket events
  -> browser Web Audio queue
  -> server-side WAV artifact for replay
```

The backend uses these WebSocket events:

| Event | Purpose |
|---|---|
| `tts_stream_started` | Identifies the artifact and supplies sample rate and channel count. |
| `tts_stream_chunk` | Carries one ordered PCM16LE chunk as base64. |
| `tts_stream_complete` | Supplies final artifact metadata and its replay URL. |
| `tts_stream_failed` | Ends an incomplete or cancelled browser stream. |
| `tts_artifact_ready` | Supplies a ready WAV URL for first playback or Replay, identified by `playback_kind`. |

`tts_stream_started` and `tts_artifact_ready` also carry a
`playback_trigger`: `automatic` for automatic speaking and `explicit` for a
Speak or Replay action. The clients use this field only for the microphone
policy after playback.

The browser decodes each PCM chunk and schedules it through the Web Audio API.
It does not wait for `tts_stream_complete` before starting playback. Chunks for
multiple bubbles remain ordered in one shared audio queue.

The complete WAV stays on the app-backend machine. Replay fetches that artifact
over HTTP. The app does not deliberately persist it in browser storage.

One bridge smoke test against the deployed NanoVLLM TTS stream on 27 August
2026 received its first PCM chunk after 186.1 ms and completed generation after
296.1 ms. It produced nine chunks and 1,440 ms of audio. This single run confirms
the path; it is not a latency benchmark.

## Configuration

The server-owned speculation limit belongs to live voice delivery:

```json
{
  "live": {
    "tts_delivery": {
      "speculative_bubble_limit": 8
    }
  },
  "tts": {
    "auto_speak": true
  }
}
```

`live.tts_delivery.speculative_bubble_limit` is a non-negative integer. `0`
disables speculative generation. Clients cannot raise this server-owned limit.

`tts.auto_speak` is the server default for the user-facing setting. The
client may change it for the active voice session through the existing TTS
settings boundary. The UI label is **Automatically speak translations**.

Automatic speaking requires `tts.enabled`. Disabling TTS disables both
speculative generation and automatic speaking.

## Generation ownership

The app backend owns preparation state. The browser does not start background
TTS requests. This gives manual clicks, automatic playback, cancellation, and
cleanup one source of truth.

Preparation is keyed by:

```text
turn id
+ part id
+ exact committed target text
+ target language
+ synthesis-affecting TTS settings
+ selected reference identity
```

A preparation record has one of these states:

```text
queued -> generating -> ready
                    \-> failed or cancelled
```

Generation state stays separate from `speech_state`. Preparing unused audio
must not mark a bubble as speaking or pause the active ASR/translation turn.

One voice session runs at most one generation task at a time. Its queue keeps
bubble order. Completing one generation may overlap with browser playback of an
earlier bubble. PCM forwarding is serialized per preparation so a manual
subscription cannot interleave buffered chunks with newly arriving chunks. A
send failure settles that preparation and its completion future without
stopping later queue entries.

## Manual mode

Each new voice session starts with a speculation budget equal to
`speculative_bubble_limit`.

For every eligible definitive bubble:

1. If the budget is positive, enqueue preparation and decrement the budget.
2. If the budget is zero, leave the bubble unprepared.
3. Do not send audio to the browser until the user requests playback.

A valid `speak_part`, `speak_now`, or `replay_tts` request resets the budget to
the configured limit. Stop does not reset it.

For Replay, valid intent means that the requested part belongs to the active
lane, was spoken, and TTS is enabled. Artifact availability is checked after
that intent reset. An unavailable cached artifact therefore still resets the
budget, then returns the part to pending so the user can request fresh speech.

A playback request has three paths:

| Preparation state | Action |
|---|---|
| Ready | Send the stored WAV URL and play it. |
| Generating | Subscribe the browser, send already buffered chunks in order, then forward new chunks. |
| Missing or failed | Start demand generation and stream it immediately. |

Ready first-play and Replay responses should use one generic
`tts_artifact_ready` message. It identifies whether playback is a first play or
a replay so playback settlement remains correct. It replaces
`tts_replay_ready`; the protocol must not retain both paths.

`speak_now` applies the same rules to each selected bubble and preserves their
order. It does not combine multiple bubbles into a new synthesis request.

The backend never starts a second TTS request for the same preparation key. An
explicit request for an unprepared bubble takes precedence over another
speculative bubble and may cancel that task.

The first app implementation does not add a priority class to the TTS-pool
protocol. Pool-level metrics must show whether traffic from other sessions lets
speculative work delay explicit requests. A pool priority change is separate
TTS-pool work if that delay is material.

## Automatic mode

When `auto_speak` is enabled:

1. Closing a definitive target bubble enqueues TTS immediately.
2. The browser subscribes without waiting for a Speak click.
3. The first PCM chunk starts playback.
4. Later bubbles wait in bubble order when generation or playback is busy.
5. The completed WAV remains available for Replay.

The speculation budget is ignored while automatic speaking is enabled.

Enabling automatic speaking affects only bubbles that become definitive after
the setting change. It does not read the existing conversation backlog.
Disabling it cancels automatic items that have not started playback and prevents
new automatic work. Current playback may finish; the user can stop it with the
existing stop control.

Browsers can block audio that was not unlocked by a user gesture. The voice
workflow therefore prepares or resumes its AudioContext during the explicit
session-start action when automatic speaking is enabled. Changing the setting
is also a user gesture. If playback is still blocked, the existing resume-audio
control remains the recovery path.

The current capture-muting policy remains in force during playback so output
audio is not fed back into ASR. Speech during that interval is intentionally not
captured. After automatic playback, the existing microphone session resumes.
After an explicit Speak action, the microphone switches off as before. A URL
playback error or missing URL settles the item through the same failure path as
an invalid PCM stream, which also releases capture muting.

## Implementation boundaries

The backend delivery lifecycle belongs in
[`app/voice/tts_delivery.py`](../../app/voice/tts_delivery.py). The conversation
runtime detects a definitive bubble and delegates preparation or automatic
delivery. It must not absorb the generation registry.

The existing TTS bridge and pool client continue to expose one validated stream
of PCM callbacks. They do not own speculation budgets, bubble identity, or
automatic-playback policy.

The shared browser audio implementation remains in
[`static/src/shared/audio-playback.js`](../../static/src/shared/audio-playback.js)
because mobile and desktop voice workflows both use it. Each workflow owns its
session messages, visible setting, and bubble rendering. The shared
post-playback microphone decision lives in
[`static/src/shared/voice-playback.js`](../../static/src/shared/voice-playback.js).

## Staleness and cancellation

Cancel or ignore preparation when any key input changes before completion:

- the turn or bubble is removed;
- committed target text changes;
- source or target language changes;
- the selected backend, voice, cloning mode, or reference changes;
- TTS is disabled;
- the voice session closes.

A late callback may not publish an artifact or PCM chunk for a stale turn. A
subscribed stale stream receives `tts_stream_failed` so the browser can settle
its queue.

Changing `auto_speak` alone does not invalidate a ready artifact. It changes
delivery policy, not synthesized audio.

## Storage and cleanup

Prepared WAV files use the existing session TTS directory and session cleanup
lifecycle. Preparation records are process-local and disappear on restart.
After a restart, a missing record is a cache miss even if an orphaned file still
exists; normal session cleanup removes the file.

Buffered PCM is released when:

- the browser has subscribed and all chunks have been forwarded;
- the WAV is complete and no subscription exists;
- generation fails or is cancelled;
- the session closes.

The implementation must not keep a second complete in-memory audio copy after
the WAV is ready.

## Observability

Record counts and timings without recording source or target text:

| Metric | Purpose |
|---|---|
| preparation started, ready, failed, cancelled | Shows generation outcomes by manual, speculative, or automatic reason. |
| prepared artifact used | Measures useful speculative work. |
| prepared artifact unused | Measures wasted GPU and storage work. |
| playback ready hit | Counts clicks served from a complete artifact. |
| playback joined generation | Counts clicks that attach to in-flight work. |
| playback demand miss | Counts clicks that still start TTS. |
| click to first PCM | Measures manual responsiveness. |
| final bubble to first PCM | Measures automatic-speaking responsiveness. |
| speculation budget exhausted and reset | Shows whether eight bubbles is a useful window. |

Compare explicit-request queue time before and after speculation is enabled.
If it regresses materially, reduce speculative admission or add pool-level
priority before increasing the rollout.

## Delivery plan and status

### Phase 1: stream demand-generated TTS

- [x] Expose validated TTS-pool stream-start and PCM-chunk callbacks.
- [x] Forward PCM chunks from the app backend over the voice-session WebSocket.
- [x] Start browser playback before the complete WAV is available.
- [x] Preserve bubble order in the shared mobile and desktop audio queue.
- [x] Show a preparing indicator between the Speak request and first playback.
- [x] Stop active synthesis and browser playback through an explicit protocol action.
- [x] Store the completed WAV on the backend for replay.
- [x] Replay by stable turn-part identity without another TTS-pool request.
- [x] Ignore late audio for stale turns.
- [x] Cover stream order, early playback, replay reuse, stop, and stale-turn behavior in tests.
- [x] Validate the bridge against the deployed TTS-pool stream.
- [ ] Make transitive ES-module cache invalidation reliable; the public CDN can
  currently cache imported modules for four hours even when the entry module's
  version changes.

### Phase 2: speculative generation in manual mode

- [x] Add `live.tts_delivery.speculative_bubble_limit` with default `8`.
- [x] Separate preparation state from playback state.
- [x] Start preparation for definitive target bubbles while the budget is positive.
- [x] Reset the budget after valid Speak or Replay intent.
- [x] Let a click subscribe to buffered and future chunks of an active generation.
- [x] Reuse a ready artifact without a new TTS-pool request.
- [x] Replace replay-only URL delivery with generic `tts_artifact_ready` delivery.
- [x] Prioritize explicit per-session requests over unrelated speculative work.
- [x] Invalidate preparations when their content or synthesis key changes.
- [x] Add bounded cleanup and speculation outcome metrics.
- [x] Test the initial budget, exhaustion, reset, join, reuse, invalidation, and cancellation paths.
- [x] Serialize buffered and live PCM forwarding when a click joins generation.
- [x] Keep the generation worker alive when one browser send fails.

### Phase 3: automatic speaking

- [x] Add validated `tts.auto_speak` state with a `true` server default.
- [x] Add **Automatically speak translations** to both voice interfaces.
- [x] Unlock the AudioContext from the setting or session-start gesture.
- [x] Enqueue each newly definitive target bubble for subscribed TTS generation.
- [x] Ignore the speculation budget while automatic speaking is enabled.
- [x] Preserve generation and playback order across multiple bubbles.
- [x] Avoid automatic playback of bubbles finalized before the setting was enabled.
- [x] Cancel queued automatic work and stop new work when the setting is disabled.
- [x] Test autoplay blocking, runtime setting changes, ordering, stop, and replay.
- [x] Resume an existing microphone session after automatic playback while
  retaining turn-ending behavior for explicit Speak.
- [x] Settle missing and failed ready-artifact URLs.

## Acceptance checks

Manual mode is complete when:

- a new session prepares up to eight definitive bubbles without a click;
- the ninth bubble does not generate until playback intent resets the budget;
- a first click uses ready or in-flight work without duplicate synthesis;
- explicit demand remains responsive under measured speculative load.

Automatic mode is complete when:

- every newly definitive bubble starts playing once and in order;
- no Speak click is required;
- toggling the mode does not read old bubbles aloud;
- disabling the mode prevents new automatic playback;
- automatic playback temporarily mutes capture and resumes it afterwards;
- Replay uses the completed artifact without new synthesis.

## Open decisions

- What measured explicit-request latency warrants TTS-pool priority support.

The browser stores the automatic-speaking preference in `localStorage`. Mobile
and desktop use the same preference. A browser without a stored choice starts
from the server default in `config/settings.json`.

# Review prompt: responsive voice TTS streaming

Review `feature/responsive-voice-tts` against `main`. Review only; do not modify
the branch.

## Change under review

The app previously waited for a complete WAV before browser playback. It now
forwards PCM16LE chunks from the TTS-pool gRPC stream over the voice-session
WebSocket. Mobile and desktop browsers schedule those chunks through the Web
Audio API while the backend finishes and stores the WAV.

The same change:

- replays a completed bubble from its server-side artifact without new TTS;
- addresses bubbles by stable part ID instead of matching text;
- adds explicit stop and stale-stream cancellation;
- shows a preparing indicator before the first chunk plays;
- preserves playback order across multiple bubbles.

The design and follow-up phases are in
[`docs/voice-translation/tts-delivery-design.md`](../voice-translation/tts-delivery-design.md).

## Review priorities

Report correctness, lifecycle, protocol, and regression risks. Prioritize a
concrete failure mode over style comments.

### Backend stream lifecycle

- Check gRPC event validation and callback order in
  `app/upstreams/tts_pool/client.py`.
- Check the transition from the blocking synthesis thread to the asyncio event
  loop in `app/voice/tts_delivery.py`.
- Look for deadlocks, unbounded waits, callbacks after WebSocket closure, and
  cancellation that leaves the pool request running.
- Trace stop, turn change, session close, synthesis failure, and playback
  completion. Each path must settle `tts_task`, `pending_tts`, active artifact
  state, and bubble `speech_state` consistently.
- Check whether a late chunk or completion can attach to a new turn or lane.
- Check that replay cannot expose another turn's or session's artifact.

### Browser playback lifecycle

- Check PCM16LE base64 decoding, channel handling, sample rate handling, and
  strict sequence-number validation in `static/src/shared/audio-playback.js`.
- Check Web Audio scheduling for gaps, overlaps, duplicate completion, and
  sources that remain referenced after stop or failure.
- Trace stop before the first chunk, during playback, after synthesis completes,
  and while another bubble is queued.
- Check that an audio item settles exactly once and reports the correct part IDs
  to the backend.
- Check browser autoplay recovery and the existing URL playback path used by
  Replay and the voice library.

### Protocol and UI state

- Confirm mobile and desktop handle the same stream event sequence.
- Confirm the obsolete `tts_clip_ready` path is gone from all reachable code.
- Check the transitions between Speak, Preparing, Stop, and Replay icons.
- Check repeated clicks, a disconnected WebSocket, a disabled TTS setting, and
  a lane or turn change during synthesis.
- Confirm cached Replay does not issue a second TTS-pool request.

### Resource use

- Look for retained PCM buffers, AudioBufferSource nodes, callback futures, and
  server-side artifact metadata after cancellation or session cleanup.
- Flag avoidable whole-audio copies beyond the copy required to write the final
  WAV.
- Assess whether JSON base64 chunk forwarding can create WebSocket backpressure
  or block the synthesis callback under realistic chunk sizes.

## Intentional follow-up work

Do not report these as missing scope unless the current patch makes their later
implementation unsafe:

- speculative generation after a definitive target bubble;
- the configurable eight-bubble speculation window;
- automatic speaking after every definitive target bubble;
- a generic artifact-ready event for prepared first-play and Replay;
- improved cache invalidation for transitive ES modules.

The current cache-busting convention updates the HTML entry URL. Imported
modules may still remain in browser cache until a hard refresh or expiry. This
is documented follow-up work.

## Verification

Run:

```bash
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
python -m unittest discover -s tests
node --test tests/js/
git diff --check main...HEAD
```

Also inspect the complete diff from `main`; do not review only the last commit.

## Review response

List findings first, ordered by severity. For each finding include:

- file and line;
- triggering sequence or input;
- observed or expected failure;
- smallest safe correction;
- missing regression test, when applicable.

After the findings, list unresolved risks and test gaps. If there are no
findings, state that directly and name any paths that were not exercised.

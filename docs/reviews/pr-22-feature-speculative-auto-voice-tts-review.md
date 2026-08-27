# Review prompt: speculative and automatic voice TTS

Review PR #22, `feature/speculative-auto-voice-tts` against `main`. Review only;
do not modify the branch.

## Change under review

The app now prepares TTS after a target bubble becomes definitive. Manual mode
prepares at most eight consecutive bubbles without playback intent. A valid
Speak or Replay action resets that budget.

A playback request reuses the same preparation:

- ready audio is delivered through `tts_artifact_ready`;
- an in-flight preparation forwards its buffered and future PCM chunks;
- a missing preparation starts demand generation;
- explicit per-session demand may cancel unrelated speculative work.

Automatic speaking is available in both voice interfaces and is enabled by
default. It applies only to bubbles finalized after the setting is enabled. The
browser stores the choice in `localStorage`; mobile and desktop share it.

The same PR updates the **Under the hood** information. It lists LaMa as the
selective image-inpainting model and distinguishes the self-hosted consumer
hardware from its workstation-class GPU.

The design and state rules are in
[`docs/voice-translation/tts-delivery-design.md`](../voice-translation/tts-delivery-design.md).

## Review priorities

Report correctness, lifecycle, protocol, and regression risks. Prefer a
concrete failure sequence over style comments.

### Preparation lifecycle and concurrency

- Trace `_Preparation` through queued, generating, ready, failed, and cancelled
  states in `app/voice/tts_delivery.py`.
- Confirm one session runs at most one synthesis at a time and preserves bubble
  order.
- Check that Speak joins an existing preparation without a second pool request.
- Check the blocking synthesis-thread callbacks against the asyncio event loop.
  Look for deadlocks, callbacks after cancellation, unresolved futures, and a
  worker that stops servicing its queue.
- Verify that buffered PCM is sent once, in order, and released after forwarding
  or completion.
- Check explicit-demand preemption while speculative generation is queued,
  generating, completing, or failing.
- Confirm preparation never changes `speech_state` until playback is requested.

### Budget, staleness, and cleanup

- Verify the configured limit is server-owned, non-negative, and starts at
  eight.
- Confirm only eligible definitive target bubbles consume the budget.
- Confirm valid Speak and Replay intent reset it, while Stop and unrelated
  controls do not.
- Trace content, language, synthesis-setting, turn, and session changes. Stale
  work must not publish chunks or artifacts.
- Trace Stop, next turn, TTS disable, WebSocket close, and session cleanup.
  Preparation records, cancellation handles, queued keys, pending playback,
  buffered PCM, and bubble state must settle consistently.
- Check that ready but unused artifacts are bounded by the current turn and are
  reported as unused when discarded.

### Automatic speaking

- Confirm only newly definitive bubbles are spoken. Enabling the setting must
  not play the existing backlog.
- Confirm the speculation budget is ignored in automatic mode.
- Check generation and browser playback order across consecutive bubbles.
- Disabling the setting must cancel automatic work that has not started
  playback, prevent new automatic playback, and allow already-started playback
  to finish.
- Check interactions with TTS disabled, Stop, Replay, lane changes, and a
  suspended AudioContext.
- Confirm session start and the setting gesture unlock or resume Web Audio
  without falsely reporting inaudible playback as started.

### Protocol and browser state

- Confirm mobile and desktop implement the same `tts_stream_*` and
  `tts_artifact_ready` semantics.
- Confirm `tts_replay_ready` has no reachable compatibility path.
- Check first-play versus Replay settlement through `playback_kind` and stable
  part IDs.
- Check that delayed artifact events cannot attach to a new turn or lane.
- Verify `tts_settings` in the ready event and runtime updates cannot overwrite a
  newer browser choice.

### Default and localStorage preference

- Confirm a browser without stored state starts with automatic speaking on.
- Confirm a stored `false` wins over the server default on mobile and desktop.
- Confirm toggling either interface updates the active session and survives a
  reload.
- Confirm the shared `tts_global` update preserves backend, voice, and cloning
  settings.
- Check malformed, unavailable, or quota-limited localStorage. The server
  default must remain usable without breaking session start.
- Check the app-storage reset path removes this preference with the other app
  settings.

### Resource use and observability

- Look for retained PCM chunks, preparation futures, cancellation handles, or
  artifact metadata after completion and cleanup.
- Confirm metrics contain no source or translated text.
- Check ready-hit, joined-generation, demand-miss, cancellation, unused-artifact,
  queue-time, and first-PCM measurements for misleading double counts.

### Help and information copy

- Confirm both Gemma instruction models are identified as vLLM-served.
- Confirm LaMa is described as a selectively used image-background model, not
  as a mandatory step for every image.
- Confirm the hardware wording distinguishes a workstation GPU from a
  datacenter accelerator without describing the whole system as enterprise
  infrastructure.

## Intentional exclusions

Do not report these as missing scope unless this patch makes them unsafe:

- TTS-pool protocol changes or cross-session priority classes;
- generating speech from target preview text;
- transitive ES-module cache invalidation;
- iOS background-audio support.

The app updates the HTML entry-module cache keys. Imported modules may still
require a hard refresh because transitive cache invalidation remains separate
work.

## Verification

Run:

```bash
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
python -m unittest discover -s tests
node --test tests/js/
git diff --check main...HEAD
```

The author run passed 257 Python tests and 85 JavaScript tests. Inspect the full
diff from `main`; do not review only the last commit.

## Review response

List findings first, ordered by severity. For each finding include:

- file and line;
- triggering sequence or input;
- observed or expected failure;
- smallest safe correction;
- missing regression test, when applicable.

After the findings, list unresolved risks and test gaps. If there are no
findings, state that directly and name any paths that were not exercised.

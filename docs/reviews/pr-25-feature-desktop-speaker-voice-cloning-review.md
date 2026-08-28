# Review prompt: desktop speaker voice cloning

Review PR #25, `feature/desktop-speaker-voice-cloning` against `main`. Review
only; do not modify the implementation. Record the result in
`docs/reviews/pr-25-feature-desktop-speaker-voice-cloning-findings.md`.

## Required context

Read these documents before reviewing the code:

- [`docs/voice-translation/voice-cloning-design.md`](../voice-translation/voice-cloning-design.md)
- [`docs/voice-translation/tts-delivery-design.md`](../voice-translation/tts-delivery-design.md)
- [`docs/voice-translation/session-guardrails-design.md`](../voice-translation/session-guardrails-design.md)

The voice-cloning design is authoritative for product behavior. Phases 1–3 are
implemented in this PR. Phase 4 remains later tuning and mobile migration.

## Change under review

Desktop voice translation has one new option: **Clone speaker voice**. It is off
by default and remembered in `localStorage`.

When enabled, the backend keeps independent recent-speech state for each
conversation direction. It selects complete, non-overlapping ASR segments from
terminal results. One materializer clips the matching source WAV intervals and
joins only the selected transcript text. The default accepted duration is 3–10
seconds.

The resulting pair is sent to a VoxCPM-family backend as Prompt + reference.
While a lane has no valid pair, its state is **Preparing**. Automatic,
speculative, and manual cloned TTS are skipped. The app never substitutes a
stable generated voice. A manual Speak action gets a non-error
`voice_clone_preparing` result.

Each materialized reference has an immutable identity. New preparations use the
current identity. Existing completed WAVs remain replayable after the reference
window changes.

## Review priorities

Report correctness, lifecycle, concurrency, protocol, and regression risks.
Prefer a concrete triggering sequence over style comments.

### Segment provenance and exact pairing

- Trace ASR job `t0_ms`/`t1_ms`, absolute segment timestamps, and source WAV
  offsets through selection and clipping.
- Confirm every prompt word comes only from a segment included in the output
  WAV. Audio and transcript must fail together.
- Check invalid, empty, reversed, out-of-WAV, duplicated, and partially
  overlapping intervals.
- Confirm the newest overlapping ASR result wins without duplicating spoken
  audio from an older rolling result.
- Verify selection may cross ASR jobs and bubbles but never cuts inside one ASR
  segment.
- Check exact minimum and maximum durations, a segment larger than the maximum,
  frame rounding, differing WAV formats, stereo input, and truncated WAVs.
- Confirm `min_duration_s` is the actual readiness threshold. No hidden
  three-second condition should remain when the setting changes.

### Reference lifecycle and bounds

- Confirm the two lanes have independent deques, state, and reference identity.
- Trace disabled → preparing → ready, direction changes, disable/re-enable, and
  session restart.
- Check whether terminal ASR results can race with TTS preparation or session
  shutdown while materialization runs in a worker thread.
- Verify source metadata is bounded and materialized WAVs count toward the
  existing combined ASR/TTS session cap.
- Check cleanup and retention through normal completion, disconnect, duration
  limit, storage limit, and expired-session cleanup.
- Assess how often replacement references are written during a 15-minute
  session. Report a concrete storage risk if the hard cap can be reached much
  earlier than expected.
- Confirm metrics contain no transcript or audio content.

### Session setting and capability

- Confirm `voice_cloning.enabled` is a separate semantic session setting, not a
  browser-controlled VoxCPM recipe.
- Verify create and live-update validation reject enabled cloning unless TTS is
  enabled and the active backend is VoxCPM-family.
- Confirm changing TTS settings cannot silently move an enabled cloning session
  to Kokoro or another incompatible backend.
- Check `/api/config` capability reporting when the configured backend is
  loaded, missing, or replaced in the displayed TTS options by another loaded
  backend.
- Confirm enabling cloning never automatically switches the backend.

### TTS admission, staleness, and replay

- Confirm product cloning always maps to `last_speech`, Prompt enabled, and
  `also_use_as_reference=true` with the same materialized WAV.
- Check automatic and manual paths in `ConversationRuntime` and the speculative
  path in `TtsDelivery`. No path may synthesize while the lane is preparing.
- Confirm a skipped speculative bubble does not consume the eight-bubble budget.
- Confirm reaching Ready does not enqueue or automatically play skipped bubbles.
- Trace a reference replacement while preparations are queued, generating,
  streaming, ready, or replaying.
- Verify the reference identity participates in preparation staleness without
  invalidating an already completed WAV.
- Confirm disabling cloning affects future preparation but preserves valid
  replay of existing audio.
- Check storage-limit and source-WAV failures before and during synthesis. The
  bubble and generation worker must settle without a generic fallback voice.

### Browser state and UX

- Confirm the option is disabled when capability is false and remains
  independent from **Automatically speak translations**.
- Trace first load, slow or failed config fetch, clicking Record before config
  resolves, stored true/false, malformed storage, reset, and reload.
- Check toggling before a session, during a live session, and while TTS is
  preparing or playing.
- Verify Ready and Preparing follow the active lane after direction changes.
- Confirm a manual Speak skip leaves the bubble pending and shows Preparing as
  normal status, not an error.
- Check that audio playback status temporarily takes priority over Ready and
  that an actual error still takes priority over both.
- Verify the desktop modulepreload URLs and import query strings identify one
  consistent version of every changed module. The feature must not combine old
  and new voice-session JavaScript.
- Check the two switches and status copy at narrow desktop widths and increased
  text size.

## Intentional exclusions

Do not report these as missing scope unless this PR makes them unsafe:

- changing ASR-pool, translation-services, or TTS-pool;
- migrating the product option to mobile;
- hiding the current mobile experiment controls behind Dev tools;
- speaker recognition or diarization;
- persistent voices across sessions;
- word-level clipping inside a long ASR segment;
- choosing the final three- versus five-second product default;
- proactively deleting old reference WAVs during an active session. The
  existing session storage cap remains authoritative.

## Verification

Run:

```bash
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
python -m unittest discover -s tests
node --test tests/js/
git diff --check main...HEAD
```

The author run passed 281 Python tests and 92 JavaScript tests. A manual smoke
test produced recognizable cross-language cloning, but did not exhaustively
cover voices, languages, background audio, or the three-second quality limit.

## Review response

List findings first, ordered by severity. For each finding include:

- file and line;
- triggering sequence or input;
- observed or expected failure;
- smallest safe correction;
- missing regression test, when applicable.

After the findings, list unresolved risks and test gaps. Give an explicit
merge-quality verdict. If there are no findings, state that directly and name
the paths that were not exercised.

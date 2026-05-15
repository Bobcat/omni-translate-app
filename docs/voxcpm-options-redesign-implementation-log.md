# VoxCPM Options Redesign — Implementation Log

Field report on what has shipped against [voxcpm-options-redesign.md](voxcpm-options-redesign.md)
and where we intentionally deviated. The design doc remains the working
contract for remaining work; this file tracks reality.

Last updated: 2026-05-15.

---

## Status

### Phase 1 — Structural cleanup + gender/style switch

**Shipped.**

- Per-language voxcpm2 config keyed by BCP-47 tag, persisted in
  `localStorage` under `voxcpm2_voice_config`.
- Replaces legacy globals: `voice_presets`, `use_input_audio_reference`,
  `reference_max_duration_s`, `reference_match`.
- Per-entry shape: `mode` (`description` | `reference_audio`) plus the
  fields that mode uses (`gender` + `style`, or `reference_source` +
  `trim_seconds` + optional `stable_gender`).
- Backend (`app/tts_bridge.py`) holds the runtime override; frontend
  mirrors localStorage to the backend on init.
- Variant A and Variant B implemented in Audio settings with a
  language-picker dropdown at the top of the panel.
- Prompt-inspect preview reflects the rendered prompt per language.

### Phase 2 — Stable Generated library

**Shipped as a shortcut variant (Phase 2a).**

In scope and shipped:

- Server-side WAV storage at
  `data/voice_library/stable/<bcp47>/<gender>/{audio.wav,meta.json}`.
- Resolver, status, generator, and prompt-preview helpers in
  `app/voice_library.py`.
- Routes: `POST /api/voice-library/stable` (takes `language`, `gender`,
  `engine`) and `GET /api/voice-library/stable/<lang>/<gender>/audio.wav`.
- `/api/config` carries per-language status, reference text, and
  generated-at metadata.
- Reference texts seeded in `config/voice_reference_texts/<bcp47>.txt`
  for `it` and `en`. Other languages added by dropping additional `.txt`
  files.
- Dev tools sub-page `Voice library` (under the Dev tools subpage) with
  engine / language / gender selectors, read-only reference text and
  prompt preview, last-generated timestamp, Generate/Regenerate + Play.
  The bottom sheet takes the full viewport for this page.
- Audio settings (Variant B) gets a `Voice gender` row and a read-only
  status line when `Stable generated` is the picked source.

Out of scope for Phase 2a, deferred to Phase 2b:

- TTS → ASR → WER pipeline with N candidates per (language, gender).
- `wer_score`, `asr_backend`, `duration_s` in `meta.json`.
- NanoVLLM-VoxCPM `/encode_latents` caching (currently re-encodes per
  call when reference audio is used).
- Hi-Fi cloning via `prompt_text` + `prompt_wav_path` (we send only the
  reference WAV, no paired transcript yet).

### Phase 3 — Power user mode

**Not started.**

### Phase 4 — User Voice library

**Not started; design widened.**

Original scope was guided own-voice setup. Widened to a per-user voice
library with three population paths (generate, record, upload). Storage
and lifecycle pattern (IndexedDB + session-scoped upload + discard with
session) already drafted in the design doc and applies to all three
sources. Open items (granularity, source-tracking, conflict resolution
with the server library, upload validation, user-facing UI surface) are
listed in the design doc and need decisions before implementation.

---

## Deviations from the design

### 1. `no_preference` gender removed everywhere

**What.** The doc lists three genders (`no_preference`, `female`, `male`)
both for Variant A description-mode and for Stable Generated library
granularity. The shipped UI offers only `female` and `male` in both
places. Backend normalization defaults missing or unknown gender values
to `female`.

**Why.** Empirical: `no_preference` produced ambiguous outputs and the
user wanted a clean binary choice for now. Documented intent to revisit.

**Status.** Reversible. Re-adding `no_preference` is a tuple entry plus
default change plus the prompt clause string.

### 2. Skipped Phase 2 WER pipeline (Phase 2a is manual curation)

**What.** The doc specifies that Stable Generated samples are produced
by generating N candidates, running each through ASR, scoring on WER,
and saving the lowest-WER candidate with `wer_score` in `meta.json`.
The shipped generator produces one sample per click and trusts the
user's ear.

**Why.** For a small sample matrix (10 languages × 2 genders), the
quality-control infrastructure is overkill. Manual review is faster and
the user judges acceptability directly via the Play button after
generation.

**Status.** Deferred to Phase 2b. The current `meta.json` shape is a
strict subset of the doc's shape, so extending it is additive.

### 3. Hi-Fi cloning not wired

**What.** The doc describes pairing the reference WAV with its
transcript (`prompt_text` for VoxCPM-2 direct, plus `prompt_latents_*`
caching for NanoVLLM-VoxCPM) as the recommended default whenever a
reference audio is used. The shipped code sends only the reference WAV,
no transcript.

**Why.** Reference-audio-alone already produces consistent results in
the user's testing. Hi-Fi adds complexity (per-source transcript
handling: ASR transcript for `last_speech`, original generation text
for `stable_generated`) without proven need yet.

**Status.** Deferred. The doc's distinction between "ASR transcript for
last-speech" and "generation text for stable-generated" is still the
intended approach when this is wired up.

### 4. No `latents.json` caching

**What.** The doc describes caching the `/encode_latents` output next
to each stable sample so subsequent inferences use
`prompt_latents_base64` instead of re-encoding the WAV.

**Why.** Useful only with Hi-Fi cloning. Reference-only mode does not
benefit, and Phase 2a does not use Hi-Fi.

**Status.** Deferred to Phase 2b together with Hi-Fi cloning.

### 5. Voice library generator is engine-independent

**What.** The doc does not address what engine produces a Stable
Generated sample. The shipped generator takes an explicit `engine`
parameter (one of the loaded voxcpm-family models) and is decoupled
from the user's currently selected TTS backend.

**Why.** Curating samples while the active TTS backend is Kokoro (or
anything else without reference-audio support) is a normal workflow.
Forcing a backend switch just to curate would be friction.

**Status.** Permanent. The Voice library page exposes an engine
dropdown showing only loaded voxcpm-family models.

### 6. Voice library lives under Dev tools, not as a standalone surface

**What.** The doc says "User opens Dev tools → Voice library". The
shipped UI implements this as a sub-page within the Dev tools subpage
(three-level navigation: Settings → Dev tools → Voice library).

**Why.** Matches the existing settings-sheet subpage pattern (ASR
tuning is similarly nested). Also: future intent is to gate the entire
Dev tools subpage behind a single production toggle so all dev-only UI
sits together.

**Status.** Permanent.

### 7. Variant B exposes `Voice gender` when source is `stable_generated`

**What.** The doc explicitly hides gender in Variant B ("A reference
WAV always overrides text-level voice traits; the app composes the
prompt itself in that case and hides gender + style.").

**Why.** With per-gender stable samples on disk, the user needs to pick
which curated sample to use. The gender field re-emerges as a
*sample-selection* control in this specific case, not as a prompt
trait.

**Status.** Permanent for `stable_generated` source. Other reference
sources (e.g. `last_speech`) still hide gender as the doc prescribes.

### 8. Pre-shortcut samples not migrated

**What.** When Phase 2a introduced the gendered directory layout
(`<bcp47>/<gender>/audio.wav`), pre-existing samples at the older
`<bcp47>/audio.wav` path were left in place but are no longer resolved.

**Why.** No migration scaffolding; the user prefers regenerating over
adding fallback code. Matches the "no fallback layers unless asked"
discipline.

**Status.** Permanent. Affected samples are orphaned files on disk;
regenerate per (language, gender) when needed.

### 9. Audio settings shows a read-only stable-sample status, not actions

**What.** Phase 2a originally placed an inline `Generate` + play button
in Audio settings. The current UI keeps only a read-only status line
("Sample · YYYY-MM-DD HH:MM" or "Not generated yet" or "No reference
text"). Generation lives only in Dev tools.

**Why.** Avoids duplicate actions across two pages; keeps the
user-facing Audio settings free of curation actions.

**Status.** Permanent for this Phase 2a UI.

### 10. Localstorage as voice-config source of truth

**What.** The doc places per-language voice config in localStorage. The
shipped flow puts the frontend in charge: on init it loads the
localStorage blob and pushes it to the backend runtime overrides; every
subsequent change does the same in reverse order (state → localStorage
→ backend). The backend persists nothing to disk.

**Why.** Implements the doc's intent literally — config is
client-owned. The backend mirror exists only to inform the synthesize
path at request time.

**Status.** Permanent.

---

## Out-of-scope additions

These were not in the design doc but were added during Phase 1 / Phase 2a
work on explicit user request.

### Replay an already-spoken target bubble

- New WS control message `replay_tts { lane_id, text }`.
- New event `tts_replay_ready` carrying a fresh `tts` artifact payload
  without touching turn state.
- Frontend renders a small `volume-2` button on spoken target bubbles;
  clicking it re-synthesizes the same text with the current voice
  configuration. On coarse-pointer devices the whole bubble is also a
  tap target.

Purpose: iterate on voice settings without re-recording speech.

### Auto-play after Generate, plus manual Play in Voice library

- The Voice library Generate action plays the freshly created sample
  immediately (`audioQueue.clear()` + enqueue with `replay: true`).
- An adjacent inline `volume-2` button replays the existing sample
  without re-generating.

Purpose: tight regenerate-until-satisfied loop for sample curation.

### Settings subpage rename: Debug → Dev tools

The user-visible label was renamed to "Dev tools" in an earlier dock
refactor; the code identifiers (HTML IDs, JS state, localStorage key,
page-state string) followed in a separate refactor commit so the names
match the visible label. Unrelated ASR-diagnostic uses of "debug" in
the backend (`_SEGMENT_DEBUG_KEYS`, `_segment_debug_payload`,
`asr_debug` payload fields) are left alone.

---

## Open items

Carry-over work for future rounds, in rough order of likely priority:

- **Phase 2b**: WER pipeline, latent caching, Hi-Fi cloning with
  per-source transcript handling, expanded `meta.json` (`wer_score`,
  `asr_backend`, `duration_s`).
- **Phase 4 (widened)**: implement the User Voice library with three
  sources. Decide the open items currently listed in the design doc's
  Phase 4 section before starting.
- **Phase 3**: power user mode (free-form custom prompts, optional
  reference-audio + gender/style override combination).
- **Prompt tuning per language.** The doc's starting templates include
  a "Pronounce numbers, abbreviations, and short fragments in
  {target_lang}" clause that the doc itself flags as unreliable for
  some languages (e.g. Italian still pronouncing numbers in English).
  Needs empirical iteration per (language, engine).
- **Dev tools production gate.** A single toggle to hide the entire
  Dev tools subpage in production deployments.

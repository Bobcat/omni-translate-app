# VoxCPM Options Redesign

This document describes the redesign of the TTS options for the VoxCPM2 and
NanoVLLM VoxCPM backends.

The goal is to make the settings simpler, predictable, and free of
contradictory inputs. In the current UI the user can combine a text-based voice
description with a reference WAV, and choose half-working selectors like "sample
matches: voice only / voice + pace". Those are removed.

The redesign is the working contract for the next implementation phase. Where
behavior is intentionally deferred to a later phase it is marked explicitly.

---

## Contents

- [Core rule](#core-rule)
- [Per-language model](#per-language-model)
- [Storage](#storage)
- [UI structure](#ui-structure)
- [Variant A — From description](#variant-a--from-description)
- [Variant B — From reference audio](#variant-b--from-reference-audio)
- [Last speech fragment — quality heuristic](#last-speech-fragment--quality-heuristic)
- [Stable Generated voice library](#stable-generated-voice-library)
- [Phasing](#phasing)

---

## Core rule

The user picks one source of voice instruction **per target language**:

- `From description` — text prompt only (gender + style)
- `From reference audio` — a WAV sample as voice anchor

The choice determines which fields are visible. There is no combined mode. A
reference WAV always overrides text-level voice traits; the app composes the
prompt itself in that case and hides gender + style.

Every prompt always contains explicit instructions. There is no "send no
instructions" mode.

---

## Per-language model

All voice configuration is stored per target language. Two users translating
into Dutch and Italian can have completely different voice setups for each, and
the app does not assume one global default.

State shape (conceptual):

```js
voxcpm2.languages = {
  "nl": {
    mode: "description",
    gender: "no_preference",
    style: "neutral",
  },
  "pt-br": {
    mode: "reference_audio",
    reference_source: "last_speech",
    trim_seconds: 8,
  },
  // ...
}
```

Keys are BCP-47 language tags in lowercase, matching the filesystem layout
used elsewhere in this document.

If a language has no entry yet, the default is:

```
mode: description
gender: no_preference
style: neutral
```

These defaults are not stored until the user actually changes a value.

---

## Storage

Per-language voice config is persisted in **localStorage** as a JSON blob under
a single key (e.g. `voxcpm2_voice_config`). Reasons:

- Total size stays small (tens of KB at most)
- Survives page reloads without backend dependency
- Simple to read/write synchronously during render

IndexedDB is not needed at this stage. If we later add power-user custom
prompts that get large, we re-evaluate.

The Stable Generated voice library (see below) is stored **server-side**
because it consists of audio files, not text settings.

---

## UI structure

### Layout

A language picker sits at the top of the panel; only the fields for the
selected language are visible underneath.

```
Configure for: [Dutch ▾]
────────────────────────────
Voice instruction:  From description
Voice gender:       Female
Speaking style:     Warm

Prompt              Inspect prompt
```

Rationale:

- Compact: one set of fields visible at any time
- Scales from 2 to 50 languages without layout changes
- Maps to the in-session mental model ("I'm about to translate to Italian")
- Mobile-friendly: avoids long vertical lists

### Picker behavior

- The two languages currently active in the session swap (source + target)
  appear at the top of the picker, with a divider separating them from the rest
  of the alphabetically sorted list.
- The picker pre-selects the **current target language** of the session when
  the panel is opened.
- A future "Apply to all languages" bulk action is deferred for now.

---

## Variant A — From description

Visible fields:

```
Voice instruction     From description
Voice gender          No preference / Female / Male
Speaking style        Neutral / Warm / Calm / Clear
Prompt                Inspect prompt
```

Hidden fields:

```
Reference audio
Trim reference audio
```

### Voice gender options

Three options only:

- `No preference`
- `Female`
- `Male`

### Speaking style options

Four options:

- `Neutral`
- `Warm`
- `Calm`
- `Clear`

Emotive styles (angry, sad, excited, etc.) are not included for now. The
initial set is intentionally kept small and limited to mild prosodic styles
until we have validated which styles produce reliable results.

No `Off` option. `No preference` (gender) and `Neutral` (style) are the
"baseline" choices.

### Prompt composition

The prompt templates below are **starting points**, not validated final wording.
They will need experimentation per language and model to confirm what works
reliably.

Known open issue: pronunciation of numbers and short tokens in the target
language is unreliable. For example, Italian output frequently still
pronounces "1, 2, 3" in English even though the prompt explicitly instructs
otherwise. The current numbers/abbreviations clause does not solve this
reliably and needs further iteration. Other clauses (voice style, gender,
brevity instruction) are unverified — they may be too verbose, too narrow, or
unnecessary.

Examples below include the numbers/abbreviations clause noted above as
unreliable. They are starting templates, not the canonical final wording.

Example for Italian, Female, Warm:

```
Speak in Italian. Pronounce numbers, abbreviations, and short fragments in Italian.
Use a natural adult female voice.
Use a warm, natural speaking style.
Speak clearly and generate only the requested text.
```

Example for Italian, No preference, Neutral:

```
Speak in Italian. Pronounce numbers, abbreviations, and short fragments in Italian.
Use a natural adult voice.
Use a neutral, natural speaking style.
Speak clearly and generate only the requested text.
```

---

## Variant B — From reference audio

Visible fields:

```
Voice instruction     From reference audio
Reference audio       Last speech fragment / Stable generated / Own voice later
Trim reference audio  8 seconds
Prompt                Inspect prompt
```

Hidden fields:

```
Voice gender
Speaking style
```

When a reference WAV is used, the user cannot set gender or style. The
reference audio wins for voice identity, and the app composes the prompt
itself. This prevents contradictions like a male reference WAV with a "female
voice" prompt.

### Reference audio sources

- **Last speech fragment** — the most recent suitable spoken fragment from this
  session. Selection logic in the next section.
- **Stable generated** — shown but **not selectable in Phase 1**. Becomes
  selectable in Phase 2 when the Stable Generated voice library is in place.
- **Own voice (later)** — disabled placeholder. User records their own voice
  via a guided onboarding flow; becomes selectable in Phase 4 (see Phasing).

### Trim reference audio

Single numeric input, default **8 seconds**, range **1–60 s**.

Helper text:

> Longer samples are trimmed before they are sent to the TTS model.

### Prompt composition

Starting template, subject to the same experimentation caveat as the
description-mode prompts.

```
Speak in Italian. Pronounce numbers, abbreviations, and short fragments in Italian.
Use the reference audio as the voice reference.
Do not infer the output language from the reference audio; the output language is Italian.
Do not copy or continue the content of the reference audio.
Speak clearly and generate only the requested text.
```

### Hi-Fi cloning (reference audio + transcript)

Both VoxCPM 2 and NanoVLLM-VoxCPM support a higher-fidelity cloning mode where
the reference audio is paired with its exact transcript. The model uses the
transcript to align the audio precisely, producing higher cloning fidelity
than reference-audio-only mode. Conceptually identical; only the wire format
differs.

**VoxCPM 2 (direct Python API):**

```python
model.generate(
    text="<the translated text to speak>",
    prompt_wav_path=ref_wav_path,
    prompt_text=ref_transcript,
    reference_wav_path=ref_wav_path,   # same audio
)
```

**NanoVLLM-VoxCPM (HTTP `/generate`):**

```json
{
  "target_text": "<the translated text to speak>",
  "prompt_wav_base64": "<base64 ref audio>",
  "prompt_text": "<ref transcript>",
  "ref_audio_wav_base64": "<base64 ref audio, same as prompt>"
}
```

NanoVLLM-VoxCPM also exposes a `/encode_latents` endpoint that turns a WAV
into a cached latent representation. For Stable Generated samples (used many
times) we can pre-encode once and pass `prompt_latents_base64` + `prompt_text`
+ `ref_audio_latents_base64` instead of re-uploading the audio every call.

Our pipeline always has an ASR transcript available because every speech
fragment we use as a reference has just been transcribed. We can therefore
enable Hi-Fi cloning for both reference sources, but with a subtle choice for
the transcript:

- **Last speech fragment** — use the **ASR transcript** of the fragment. It
  is the only transcript we have, since the user spoke spontaneously. Risk:
  if ASR made errors, the transcript and audio are slightly misaligned. For
  short, clean fragments this is acceptable; the quality heuristic below
  already filters out the worst fragments.
- **Stable Generated** — use the **original generation text** (the script we
  fed to TTS to create the sample). It is the ground truth and avoids
  propagating ASR errors. The ASR transcript of the generated sample is only
  used for the WER quality check at generation time, not at inference.

Hi-Fi mode is the recommended default whenever a reference audio is used. If
the model output regresses for some languages, we can fall back to
reference-only mode per language.

---

## Last speech fragment — quality heuristic

ASR confidence is not available across all backends (e.g. WhisperX), so the
quality score relies on signal-level and timing features only.

```text
quality_score = min(
  duration_s / 3.0,                     // ≥3s scores 1.0
  vad_coverage_ratio,                   // fraction of speech-active frames
  1 - (max_internal_silence_ms / 1000)  // penalize long internal pauses
)
```

Threshold: **0.7**. Below threshold the fragment is not used; the app falls
back to the previous qualifying fragment, or shows "No usable sample yet".

### Recency policy

Among fragments that score ≥ 0.7, take the **most recent** one. Emotion can
shift between turns; using the latest fragment keeps voice identity in sync
with the current speaker state, rather than locking in a past mood.

### ASR confidence (backend-conditional)

Backend availability:

- **Faster Whisper (direct)** — exposes `avg_logprob` per segment. This can be
  mapped to a 0..1 confidence proxy with `exp(avg_logprob)`.
- **WhisperX** — does not currently expose token-level confidence in our
  pipeline. The signal-level formula above applies as-is.

When `avg_logprob` is available, the formula extends to:

```text
asr_confidence = exp(avg_logprob)        // 0..1, only when available

quality_score = min(
  duration_s / 3.0,
  vad_coverage_ratio,
  1 - (max_internal_silence_ms / 1000),
  asr_confidence,
)
```

For Faster Whisper, the threshold of `0.7` applies to the combined score; for
WhisperX, the three signal-level features carry the full weight of the score.

Open item: verify the practical range of `exp(avg_logprob)` for realistic
speech fragments and tune the threshold if needed. A naive map may compress
the useful range too aggressively.

---

## Stable Generated voice library

Goal: provide a stable voice identity across a session, independent of whether
a clean speech fragment is available.

### Granularity

**Per (language, gender)** — not per style.

- Language × gender keeps the matrix manageable: 10 languages × 3 genders = 30
  samples.
- Style remains prompt-based. A stable WAV plus a "warm" style prompt is a
  valid combination.
- Per-style samples would explode the matrix without clear quality gain.

### Reference text

A short, natural-sounding paragraph per target language, used as the script
fed to TTS at generation time and stored alongside the audio for Hi-Fi
cloning.

Scope and reuse:

- One text per supported target language.
- The same text is used by Stable Generated (TTS reads it) and Phase 4 (the
  user reads it). Both need a known script that ASR can score against;
  reusing one text per language keeps things consistent and saves work.

Generation: feed the following prompt to a frontier LLM, once per language,
review the output, and commit it to the repo.

```
Produce one short paragraph in {language} that will be used as a voice setup
script. It will be (a) fed to a TTS model to generate a reference audio
sample, and (b) read aloud by a human user during onboarding. The same
paragraph is then run through ASR and scored against the original text to
gauge quality.

Constraints:
- Natural, everyday wording. No pangram-style sentences ("the quick brown
  fox..."), no tongue twisters, no archaic phrasing.
- 8 to 15 seconds when read at a natural pace (roughly 20–35 words depending
  on the language).
- Neutral content: no strong emotion, no domain-specific jargon, no proper
  nouns of people or places.
- No numerals, no abbreviations, no acronyms — TTS handles those unreliably
  and they would muddy the ASR comparison.
- Self-contained: do not reference outside context.

Return the paragraph as a downloadable text file named `<lang_tag>.txt`,
where `<lang_tag>` is the BCP-47 tag of the language in lowercase (e.g.
`it.txt` for Italian, `nl.txt` for Dutch, `en.txt` for English,
`pt-br.txt` for Brazilian Portuguese, `pt-pt.txt` for European Portuguese,
`zh-cn.txt` for Mandarin, `zh-tw.txt` for Taiwanese Mandarin). For
languages without a meaningful regional variant the two-letter form is
enough; include the region subtag only when the variant matters for word
choice or pronunciation. The file should contain only the paragraph
itself — no quotes, no explanation, no front matter.
```

Reference texts live as plain `.txt` files in the repo under
`config/voice_reference_texts/`, one file per language tag (BCP-47, e.g.
`it.txt`, `pt-br.txt`, `zh-cn.txt`).

### Generation flow (Dev tools)

1. User opens Dev tools → "Voice library".
2. Picks a language and gender.
3. Backend reads the reference text for that language.
4. Backend generates `N` candidate samples from the reference text.
5. Each candidate is run through ASR.
6. Candidates are scored on **WER** against the reference text.
7. The lowest-WER candidate is saved as the stable sample for that
   (language, gender) pair.

### Trigger

Manual button per (language, gender) in Dev tools, with progress feedback.
Not automatic — generation is computationally expensive and the user wants
explicit control.

### Storage

Server-side, one directory per (language, gender) pair under
`data/voice_library/stable/`. Each directory holds the sample's audio,
metadata, and optionally cached latents.

All language-keyed directories use BCP-47 lowercase tags (`it`, `nl`,
`pt-br`, `pt-pt`, `zh-cn`, `zh-tw`, ...).

```
config/voice_reference_texts/
  it.txt                  # source of truth scripts, committed to git
  nl.txt
  en.txt
  pt-br.txt
  pt-pt.txt
  ...

data/voice_library/
  stable/
    it/
      female/
        audio.wav         # the chosen TTS-generated sample
        meta.json
        latents.json      # NanoVLLM-VoxCPM cached latents (optional)
      male/
        audio.wav
        meta.json
        latents.json
    pt-br/
      female/...
      male/...
    pt-pt/
      female/...
      male/...
    ...
  own/                    # Phase 4 — see Phasing section
    audio.wav
    meta.json
    latents.json
```

`meta.json` shape:

```json
{
  "language": "pt-br",
  "gender": "female",
  "reference_text": "<exact text fed to TTS>",
  "wer_score": 0.08,
  "tts_backend": "nanovllm_voxcpm",
  "tts_model_id": "voxcpm2-0.5b",
  "asr_backend": "whisperx",
  "generated_at": "2026-05-14T12:34:56Z",
  "duration_s": 9.2
}
```

The reference text is stored inside `meta.json` (not looked up from
`config/`) so the sample is self-contained: if a script in `config/` is
later edited, existing samples still know which text they were generated
from. The `config/` files are seed data for *new* generations only.

For NanoVLLM-VoxCPM, `latents.json` caches the `/encode_latents` output so
we do not re-encode the WAV on every inference call. Latents are derived
data; if missing, they are recomputed from `audio.wav`.

`data/` is runtime state, not source code. It is gitignored. The
own-voice recording in `data/voice_library/own/` is irreplaceable user
data and must be backed up separately if persistence matters.

---

## Phasing

### Phase 1 — Structural cleanup + gender/style switch (one PR)

- Remove the `both` mode and `Sample matches` selector
- Rename `Max duration` → `Trim reference audio`
- Introduce per-language `mode` (description / reference_audio)
- Replace `voice_presets` with `gender` + `style` per language
- Implement the language picker UI (Variant B)
- Persist per-language config in localStorage
- Show but disable the "Stable generated" and "Own voice (later)" options in
  the reference audio source picker

Phase 1 is a single refactor because Phase 1a (cleanup) and Phase 1b
(gender/style) touch the same state shape. Splitting would create an awkward
intermediate state.

### Phase 2 — Stable Generated library

- Backend: TTS → ASR → WER pipeline
- Dev tools UI: per-(language, gender) generate button + progress
- Enable "Stable generated" option in the reference audio picker
- Storage of the audio files server-side

### Phase 3 — Power user mode

- Free-form custom prompts per language (stored in the same localStorage blob
  introduced in Phase 1; switch to IndexedDB only if prompts grow large)
- Optional "advanced" toggle that exposes ref-audio + gender/style override
  combination for users who explicitly opt in

### Phase 4 — Guided own-voice setup

A guided onboarding flow that lets the user record their own voice as a
reference sample. The app provides a short script for the user to read aloud;
the recording becomes a Hi-Fi cloning input (audio + ground-truth transcript).

Why this is a natural fit:

- The script text is known up front, so the transcript is perfect — no ASR
  errors propagate into the alignment.
- The WER pipeline from Phase 2 transfers directly: run the recording through
  ASR, compare against the script, gate on WER.
- Hi-Fi cloning is cross-lingual. One personal sample works across all target
  languages without re-recording per language.

Flow:

1. User opens "Set up own voice" in TTS settings or onboarding.
2. App shows the reference text for the user's preferred language (the same
   reference text used by Stable Generated — see "Reference text" under
   Stable Generated voice library).
3. User records themselves reading the script.
4. Recording is run through ASR; WER is compared against the script.
5. If WER passes, the recording is saved as the user's reference sample.
6. If WER fails, the app gives non-judgmental feedback ("Background noise
   detected — try a quieter spot") and offers a retake. The raw WER number is
   not exposed to the user.

UX considerations:

- Make it optional and skippable. Reading aloud is friction.
- Set expectations clearly: cloning captures voice timbre, not native
  pronunciation. A Dutch user's voice in Italian will still carry a Dutch
  accent.
- Privacy framing: the sample stays on the user's server; no third party.

Once set, "Own voice" becomes a selectable option in the Reference audio
source picker, alongside "Last speech fragment" and "Stable generated".


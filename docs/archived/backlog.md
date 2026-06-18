# Backlog

Living index of work we want to do but isn't actively in flight. Status
stays simple — `open` until someone is on it, `in design` if a separate
doc is being drafted, `in progress` if there's a branch. Once shipped,
the item moves out of here (the commit history becomes the record).

Large items get spun out to their own design doc under `docs/` when
they reach "in design". Small items stay here through completion.

---

## A. TTS / voice generation quality

### A1. Emotion-suppression control prompt (user-toggleable)
**Status:** open. A text like *"No, and don't even think about it"*
gets read with implicit emotion even when the stable voice is supposed
to be calm. Idea: add an explicit prefix to the inline `(control)text`
that asks the model to ignore text-implicit emotion and stick to the
voice's neutral baseline. User-facing toggle (per-language?
session-wide?).

Open: where does the toggle live — Microphone subpage no, TTS options
yes probably; per-language config or global?

### A3. Vary the prompt in the voice library sheet
**Status:** open. Today the stable-library prompt is fixed per gender
(`_STABLE_LIBRARY_PROMPTS` in `app/voice_library.py`). The voice
library sheet shows it read-only. Users want to vary the prompt so they
can shape the generated voice (e.g. "younger", "warmer", "slower",
custom adjectives).

Three design directions:

- **Structured.** Extra dropdowns next to gender (age, style, accent,
  mood, …). Compositional and predictable; bounded by the knobs we
  expose.
- **Free text.** Replace the read-only prompt block with a textarea.
  Maximum flexibility, matches the VoxCPM2 demo's natural-language
  recipe; no guardrails.
- **Hybrid.** Presets (dropdowns) pre-populate the textarea, user can
  fine-tune inline. Most UI but most usable.

Open questions when picked up:
- Per (language, gender) cell or global per gender?
- Persisted server-side or in-memory per session?
- "Reset to default" affordance back to the current
  `_STABLE_LIBRARY_PROMPTS` baseline?

Note: A1 (emotion-suppression) and this item both touch the TTS
voice-instructions path; consider one combined redesign pass when both
are scheduled.

### A4. User-side voice library (client-managed)
**Status:** open. **Existing design:** Phase 4 "User Voice library"
in [voxcpm-options-redesign.md](voxcpm-options-redesign.md) — full
spec for the feature including sources, storage, lifecycle, open
items, and UX. Re-read before implementing.

Summary of what this builds:
- A second voice library, parallel to the current server-side one,
  populated by the user on their own device via three paths:
  **Generate** (same flow as today), **Record** (browser
  `MediaRecorder`), **Upload** (file input).
- Samples live in IndexedDB (`voxcpm2_user_voice_library`). They are
  lazily uploaded to a session-scoped server cache the first time a
  synth call needs them, then discarded with the session.
- "My library" becomes a third option in the Variant B reference-audio
  picker, alongside "Last speech fragment" and "Stable generated".

Once this lands, the current server-side voice library (what we just
finished iterating on) becomes a curator-only tool. Two follow-up
moves at that point:
- Move the "Voice library" nav row in `static/index.html` behind the
  dev-tools gate so end users no longer see it on the Settings home.
- Or hide it entirely from the production build if dev-tools is itself
  off; keep accessible via a feature flag for curation work.

Most of the open questions from the design doc still apply: granularity
(per (lang, gender) vs cross-lingual for Record/Upload), source labels,
how to pick between server "Stable generated" and "My library" when
both have a sample, upload validation/format support, and where the
user-facing UI surface lives.

---

## B. Bubble UX model

A coherent cluster — these all touch the same source/target render path
and bubble lifecycle. Probably wants one combined design doc when
picked up, rather than four piecemeal patches.

### B1. Source ↔ target merge
**Status:** open. Source pane becomes "current ASR only" (no history).
On close of the current ASR bubble, both the source and the translation
move into a single bubble in the target pane. Target pane carries the
history; source stays at one bubble max.

Open: timing of the verhuizing — on close of the previous bubble, or
only when the *next* one opens (so the just-closed bubble briefly stays
visible in source as well)?

### B2. Inline bubble actions
**Status:** open. Beyond the current speak / stop buttons: copy to
clipboard, mark as favorite, delete from history, … Pick the set
carefully — every extra control is visual cost.

### B3. Keyboard text input alongside ASR
**Status:** open. A text-entry affordance so users can type instead of
(or in addition to) speaking. Several open design questions: how it
relates to live ASR, where in the UI it lives, what events get
triggered downstream.

### B4. Edit ASR bubbles via keyboard
**Status:** open. **Depends on B3.** Small ASR mistakes shouldn't
require re-recording the whole utterance. Tap a closed bubble, edit
text, the translation re-runs from the edited source.

---

## C. Observability / dev

### C2. In-app dev info panel
**Status:** open. Surface TTS RTF, LLM timings, TTS timings inside the
app rather than only in exports. Likely path: broaden the existing
dev-tools "show export" toggle into "show dev info in-app", with a
panel near the transcript that updates per turn.

---

## D. Discoverability

### D1. Language capability matrix in UI
**Status:** open. Per language: ASR supported? TTS supported? Voice
library reference text present? Currently the user discovers gaps by
trial and error. Expose a small matrix or per-row indicator in the
language picker.

---

## Carry-overs from prior design work

These came up during earlier features and were deferred. Listed here
so they don't fall through the cracks.

### E1. WebSocket permessage-deflate compression
Cheap baseline data-reduction; transparent to client+server logic.
Mentioned as the #1 lever in
[mic-auto-off-design.md](mic-auto-off-design.md).

### E2. Opus encoding on the wire
Biggest single data win (~32× over PCM16) but a major refactor —
client encoder, server decoder. From the same data-reduction context
as E1.

### E3. Client-side VAD with timing heartbeat protocol
Cuts mid-speech silent bytes without touching the engine's timeline
accounting. Protocol extension; complex.

### E4. SENTENCE_END_CHARS validation against real Whisper output
For zh, ja, hi, ar — confirm the engine actually produces the chars in
our set. From phase 3 of
[bubble-segmentation-design.md](bubble-segmentation-design.md).

### E5. Tune `BUBBLE_CLOSE_MAX_DURATION_S`
Currently `3.0` seconds — chosen low for testing. Revisit once we have
field experience. From phase 3 of bubble-segmentation-design.md.

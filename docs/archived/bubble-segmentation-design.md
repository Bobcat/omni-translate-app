# Bubble segmentation — design

## Problem

A bubble in the source/target pane corresponds to one `TurnPart`. The
current rule for creating a new part is in
[app/runtime.py:1074-1078](../app/runtime.py#L1074-L1078):

```python
def _current_writable_part(self) -> TurnPart:
    turn = self.current_turn
    if not turn.parts or turn.parts[-1].speech_state == "spoken":
        turn.parts.append(TurnPart(...))
    return turn.parts[-1]
```

A new part is only created once the previous one has been **spoken**
(TTS playback completed). Until that happens every ASR commit and
preview rewrites the same part with the ever-growing
`lane.source_state.source_committed_text`. If the user does not press
Speak, the bubble grows without bound for the entire session.

## Why this matters

1. **UX.** A single forever-growing bubble is not how people naturally
   segment speech. Long monologues become unreadable; the user loses
   the ability to pick a single utterance to vocalise.

2. **TTS pool fairness.** A single late Speak press generates one
   giant TTS call that holds the shared pool for as long as it takes
   to synthesise. One slow speaker can monopolise the pool.

## Approach: two layers

### Layer 1 — Natural close (heuristics)

Close the current bubble (advance to a fresh `TurnPart`) when EITHER:

**A. Silence / VAD gate.** The realtime-asr-engine speech-gate already
fires after `live.rolling.speech_gate.force_commit_silence_ms`
(currently 2500 ms). The runtime translates that signal into a
bubble-close when the current bubble has non-empty committed text.

**D. Sentence boundary in source ASR commit.** When the latest ASR
commit text ends on a sentence-terminator character.

The terminator set is wider than the engine's ASCII-only check, to
cover every language we currently offer in the picker:

```python
SENTENCE_END_CHARS = ".?!。？！．؟।॥"
```

| Group | Chars | Languages |
|---|---|---|
| ASCII Latin | `.` `?` `!` | en, de, fr, es, it, nl, pt, pl, ro, hu, sv, da, nb, af, vi, tr, ko, ru, uk |
| CJK | `。` `？` `！` | zh, ja (Korean modernised to ASCII) |
| Fullwidth Latin | `．` | Japanese in fullwidth contexts |
| Arabic | `؟` | ar (question only; `.` already covered) |
| Devanagari | `।` `॥` | hi |

Ellipsis (`…` / `...`) and em-dash (`—`) are deliberately not in the
set: they signal trailing-off / interruption, not closure.

The engine-side `_ends_with_sentence_boundary` is left alone (ASCII
only). For CJK / Hindi the engine's `commits_target` will rarely fire,
so its `open_source_chunks` would grow — but our bubble-close action
forces a runner reset (`_reset_lane_text_scope`) which clears those
chunks anyway. End result: the LLM still sees windows bounded by our
bubble close, not the engine's narrower detector.

### Layer 2 — Hard cap (forced close)

**B. Max duration.** Close the bubble after N seconds of spoken audio
regardless of whether the heuristics fired. Initial value to be tuned
(suggest 15 s); the value is a fairness ceiling, not a UX choice. May
cut mid-sentence; that is acceptable for the guarantee.

Char/token cap (option C) was considered and dropped — duration is the
more interpretable knob and a better proxy for downstream cost in this
pipeline.

## Closed-but-not-spoken bubbles

A closed bubble is fully translated (the close action drains the
translation runner) and displayed in source + target. It does **not**
auto-trigger TTS. The user clicks a per-bubble Speak button on the
specific bubble they want to vocalise. Multiple closed bubbles can
co-exist.

Rationale:
- Keeps the "Speak is a user action" mental model intact.
- Preserves the layer-2 fairness guarantee — the TTS pool is never
  used unprompted.
- The translation pane remains a useful scanning surface even when
  the user is silent.

A per-bubble Speak affordance partially exists already
(`.bubble-speak-button`, currently only active for replayable spoken
bubbles); the change is to extend its enabled state to closed-unspoken
bubbles too.

## Key code touch points (orientation)

- [app/runtime.py:1074-1078](../app/runtime.py#L1074-L1078)
  `_current_writable_part` — current new-bubble decision.
- [app/runtime.py:815-862](../app/runtime.py#L815-L862) `_source_event`
  — sees every ASR commit / preview; natural place to fire the
  bubble-close.
- [app/runtime.py:1066-1072](../app/runtime.py#L1066-L1072)
  `_reset_lane_text_scope` — already used by next-turn and
  tts-playback-complete; the close action likely reuses this to drain
  the translation runner and reset state.
- ASR-engine speech-gate signal arrives via `apply.reason` /
  `apply.commit_reason` in [`_poll_asr_lane`](../app/runtime.py#L376);
  layer-1-A consumes this.
- Per-bubble Speak frontend affordance:
  [static/src/ui/render-turn.js](../static/src/ui/render-turn.js)
  `bubble-speak-button` — extend enabled state.

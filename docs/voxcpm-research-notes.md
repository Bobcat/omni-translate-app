# VoxCPM(2) — research notes

External research compiled by two web-crawling agents on 2026-05-17.
Scope: how to control TTS determinism (same input → same output), plus
anything practical from the docs and community that could inform our
project. We use two backends from this family: `voxcpm2` (upstream
runner) and `nanovllm_voxcpm` (the nano-vllm hosted variant), both
behind our internal TTS pool's OpenAI-style `/v1/responses` API.

---

## 1. Determinism — what knobs exist

### Upstream VoxCPM2 (`OpenBMB/VoxCPM`)

`_generate()` on `VoxCPM2Model` exposes only:

```
target_text, prompt_text, prompt_wav_path, reference_wav_path,
min_len=2, max_len=2000, inference_timesteps=10, cfg_value=2.0,
retry_badcase=False, retry_badcase_max_times=3,
retry_badcase_ratio_threshold=6.0, trim_silence_vad=False,
streaming=False, streaming_prefix_len=4
```

No `temperature`, `top_p`, `top_k`, `repetition_penalty`, no `seed`
parameter. Variance has two sources, neither user-exposed upstream:

1. **LM-side sampler** picking the next semantic embedding (likely
   `torch.multinomial` over softmax logits internally).
2. **CFM/diffusion initial noise** — the Euler steps in the decoder
   start from random `z` per call.

To get bit-identical output you must wrap the call with:

```python
torch.manual_seed(N)
torch.cuda.manual_seed_all(N)
# and optionally:
torch.use_deterministic_algorithms(True)
# plus env: CUBLAS_WORKSPACE_CONFIG=:4096:8
```

### `nanovllm_voxcpm` (what we actually use)

`add_request(...)` in `nanovllm_voxcpm/models/voxcpm2/server.py`
exposes per-request:

- `temperature: float = 1.0`
- `cfg_value: float = 1.0`  ← note: **upstream default is 2.0**

Still no `seed` / `top_p` / `top_k`. `temperature=0.0` → greedy LM
sampling (most deterministic LM-side); CFM diffusion noise still
varies per call unless the worker is seeded.

### Empirical signal: `seed=0` works "somewhere"

[HF discussion #3](https://huggingface.co/openbmb/VoxCPM2/discussions/3)
mentions users explicitly setting `seed=0` as a workaround for a
playback-speed bug. That implies a seed knob exists in *some* path
(Gradio demo, newer build, or wrapper) — even if the upstream
`_generate()` signature doesn't list it. Worth grepping our
`nanovllm_voxcpm` fork for `seed` / `manual_seed` / `Generator` to
see if it's reachable.

### Action items for our pool

1. Expose `temperature` and `cfg_value` per-request in our pool API;
   default `temperature=0.0`, `cfg_value=2.0`. The current nano-vllm
   default of `cfg_value=1.0` is "minimum guidance" and drifts from
   text more than upstream's `2.0`.
2. Add `retry_badcase=False` if available — `True` triggers silent
   regeneration on length anomaly, which adds non-determinism.
3. Per-request torch seed via the worker if we want bit-equal
   replays. (Requires worker-side change in our nano-vllm fork.)
4. Post-process RMS-normalize TTS output if amplitude jitter remains
   after the above — the AudioVAE V2 decoder + diffusion noise add
   amplitude variance that the LM-side knobs don't fix.

---

## 2. Reference audio — practitioner consensus

- **Length**: 5-30 s upstream; 5-10 s in community guides. Longer
  isn't better.
- **Sample rate**: 16 kHz input expected, 48 kHz output via
  asymmetric AudioVAE V2.
- **Denoising**: `denoise=False` if input is clean — preserves
  timbre. Only denoise dirty inputs.
- **"Ultimate cloning"**: pass the same WAV as both `prompt_wav_path`
  (with transcript via `prompt_text`) **and** `reference_wav_path`
  for max similarity. This is what our design doc calls "Hi-Fi
  cloning" (Phase 2b).
- **Quality bound**: output quality is bounded by reference quality
  — noisy reference yields cleaner-sounding but still degraded
  clones.

---

## 3. Style control — inline vs separate field

VoxCPM2's documented recipe puts style instructions **inline in the
text itself**:

```
"(young woman, gentle and sweet voice)Hello there"
"(slightly faster, cheerful tone)..."
```

Our app sends `voice.instructions` as a separate field, but the
tts-pool wraps it into the inline `(control)text` format before
calling `model.generate()` — see `_voxcpm2_text` in
`tts-pool/app/engine/voxcpm2.py`. Both `voxcpm2` and
`nanovllm_voxcpm` engines use the same helper. The model sees the
documented inline form; no change needed in our code.

---

## 4. Known issues from GitHub / HF

| Issue | Summary | Relevance |
|---|---|---|
| [#272](https://github.com/OpenBMB/VoxCPM/issues/272) | Reference-audio tail leaks through `prefix_feat_cond` → chirp/click at start of clips. Five mitigations tried, all partial. | If we hear ticks at clip start, this is the cause. |
| [#302](https://github.com/OpenBMB/VoxCPM/issues/302) | Voice identity drifts over long generations. Workaround: chunk + re-inject reference per chunk. | Low impact for our short translations. |
| [#191](https://github.com/OpenBMB/VoxCPM/issues/191) | Voice gender flips mid-clone. No maintainer fix. | UX may need a retry-affordance. |
| [#287](https://github.com/OpenBMB/VoxCPM/issues/287) | `/v1/audio/speech` occasionally returns blank 0.16 s WAV. | Server-side length sanity check worth adding. |
| [#301](https://github.com/OpenBMB/VoxCPM/issues/301), [#300](https://github.com/OpenBMB/VoxCPM/issues/300) | macOS M-series noise-only output / random crashes. | Only relevant if we evaluate on Mac. |
| [#107](https://github.com/OpenBMB/VoxCPM/issues/107) | Cannot run from background thread in 1.5. | Affects us only if we ever call from a non-main thread. |
| [HF #3](https://huggingface.co/openbmb/VoxCPM2/discussions/3) | Output plays 2-3× too fast in Ultimate mode with long reference. Empirical fix: `seed=0`, verify 16 kHz sample rate. | Direct evidence a seed knob exists somewhere. |
| [HF #14](https://huggingface.co/openbmb/VoxCPM2/discussions/14) | Ultimate Cloning produces source-language accent in target language. Control Instruction with explicit target-language tag works better. | Confirms our current instruction-prompt approach (we already say "Speak in {target_lang}"). |
| [HF #10](https://huggingface.co/openbmb/VoxCPM2/discussions/10) | Voice-Designed audio degrades when re-used as a clone prompt. | Not observed in our flow for the languages we actually use (en / it / de) — short TTS is consistently stable with our curated reference texts and samples. May surface in less-tested languages; listed for completeness. |
| [HF #11](https://huggingface.co/openbmb/VoxCPM2/discussions/11) | 30-language support advertised but quality outside Chinese/English is not guaranteed; team recommends fine-tuning. | Calibrates language expectations. |

---

## 5. Performance reference

- Vanilla on RTX 4090: RTF ~0.30.
- Nano-vLLM hosted: RTF ~0.13.
- VRAM: ~8 GB bf16.
- 2B params, MiniCPM-4 backbone, 30 languages, no language tag
  required in the input.

Source: [lilting.ch write-up](https://lilting.ch/en/articles/voxcpm2-tokenizer-free-local-tts).

---

## 6. Alternative production path

[`vllm-omni`](https://github.com/vllm-project/vllm-omni) exposes a
proper OpenAI-compatible `/v1/audio/speech` endpoint for VoxCPM2.
Could replace our custom `/v1/responses` shim. Larger change but
removes a piece of glue we maintain ourselves.

---

## 7. Competitive context

| Model | Cloning | Speed | License |
|---|---|---|---|
| Kokoro | No | Fastest | Open |
| F5-TTS | Strong | Mid | CC-BY-NC |
| VoxCPM2 | Yes | Slowest (RTF 0.13-0.30) | Apache-2.0 |
| Spark / Sesame | Varies | Varies | Mixed |

No strong reason to move off VoxCPM2 for our cloning-required use
case under a permissive license.

---

## 8. Top actionables for our project

1. **Grep our nano-vllm fork for a reachable seed path**
   (`grep -ri 'seed\|manual_seed\|Generator' nanovllm_voxcpm/`). If
   reachable, expose `seed` per-request in our pool. Lost
   determinism on replays drops to zero.
2. **Pass explicit `cfg_value=2.0` and `temperature=0.0-0.3`** in
   pool requests to nano-vllm. One-line fix; the current `cfg=1.0`
   default may already be costing us output stability and
   text-fidelity.

---

## 9. Sources

Official:
- [`OpenBMB/VoxCPM`](https://github.com/OpenBMB/VoxCPM) — repo, README, source.
- [voxcpm.readthedocs.io](https://voxcpm.readthedocs.io/en/latest/usage_guide.html) — usage guide.
- [huggingface.co/openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2) — model card + discussions tab.
- [arxiv 2509.24650](https://arxiv.org/abs/2509.24650) — tech report (VoxCPM-0.5B; no separate VoxCPM2 paper yet).

Nano-vLLM integration:
- [`a710128/nanovllm-voxcpm`](https://github.com/a710128/nanovllm-voxcpm) — `nanovllm_voxcpm/models/voxcpm2/{server,engine,runner}.py`, `deployment/README.md`.

Third-party write-ups:
- [lilting.ch — VoxCPM2 and OSS TTS in 2026](https://lilting.ch/en/articles/voxcpm2-tokenizer-free-local-tts)
- [themenonlab — Why throwing away the tokenizer changes everything](https://blog.themenonlab.com/blog/voxcpm-tokenizer-free-tts-voice-cloning)
- [DigitalOcean — F5-TTS / Kokoro / Spark / Sesame comparison](https://www.digitalocean.com/community/tutorials/best-text-to-speech-models)
- [Inferless — 12 best open-source TTS 2025](https://www.inferless.com/learn/comparing-different-text-to-speech---tts--models-part-2)
- [Medium — ElevenLabs vs Kokoro+VoxCPM](https://medium.com/@ap3617180/elevenlabs-99-mo-vs-kokoro-voxcpm-0-better-quality-%EF%B8%8F-4bce8fe2cb6f)
- [Medium — VoxCPM2 beats ElevenLabs on similarity, benchmark tells different story](https://medium.com/@tentenco/voxcpm2-the-open-source-voice-model-that-beats-elevenlabs-on-similarity-but-the-full-benchmark-ffe408b50b87)

---

## 10. Caveats

- Docs are thin on stochastic details: neither README, readthedocs,
  nor visible source explains *which* operation in the LM samples
  nondeterministically. The seed-knob discrepancy (upstream API has
  none; HF community references `seed=0`) needs in-fork
  verification.
- "Wisdom of the crowd" is sparse outside GitHub and HF discussions
  — no substantive Reddit / HN threads on VoxCPM. Don't rely on
  forum searches as a signal.
- Nano-vllm-voxcpm's `cfg_value=1.0` default contradicts upstream's
  `2.0`. Treat as a config bug to override explicitly per-request.

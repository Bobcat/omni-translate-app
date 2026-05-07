# Kokoro TTS Baseline

This note records the first local Kokoro baseline for the ASR -> Translate ->
TTS app. It is a practical reference for interpreting TTS metrics and cold-start
behavior, not a full benchmark suite.

## Snapshot

- Measured on: 2026-05-07
- App repo commit before this work: `9fefdf5`
- `realtime-tts-engine` commit before this work: `f3ca86e`
- Host: local development workstation
- CPU: Intel Core i7-14700KF, 20 cores / 28 threads
- System memory at measurement time: 31 GiB total, 17 GiB used, 14 GiB available
- GPU: NVIDIA GeForce RTX 5070 Ti
- GPU memory at measurement time: 16303 MiB total, 10001 MiB used, 5834 MiB free
- NVIDIA driver: 590.48.01
- Python package runtime: app `.venv`
- `torch`: `2.11.0+cu130`
- CUDA reported by torch: `13.0`
- `kokoro`: `0.9.4`
- Kokoro model root: local `kokoro-82m` model directory
- Kokoro model id: `hexgrad/Kokoro-82M`

The GPU was not isolated for a formal benchmark. These numbers are a local
development baseline under the app runtime used on the local workstation.

## Runtime Shape

- The app owns one app-wide `TTSBridge` singleton per Python process.
- The singleton owns one `TTSEngine`.
- The engine owns one `KokoroSynthesizer`.
- The synthesizer owns one shared Kokoro `KModel`.
- Kokoro `KPipeline` instances are cached per Kokoro language code, such as
  `a` for American English and `z` for Chinese.
- The app currently uses one global TTS synthesis lock, so max inflight TTS is
  1 per app process.
- TTS warmup loads supported configured conversation languages. Unsupported
  languages are skipped.

## Metric Scope

- `queue_wait_ms`: app-level time waiting for the TTS synthesis lock.
- `tts_total_wall_ms`: app-level wall time including queue wait, locked
  synthesis, and artifact write.
- `tts_synthesis_wall_ms`: app-level locked synthesis time, excluding queue wait
  and artifact write.
- `kokoro_total_wall_ms`: `KokoroSynthesizer.synthesize` wall time, excluding
  app queue wait and artifact write.
- `kokoro_pipeline_wall_ms`: wall time spent consuming the Kokoro `KPipeline`
  generator.
- `kokoro_model_inference_ms`: best-effort sum of `KPipeline` generator-step
  wall time. CUDA is synchronized before and after each step when running on
  CUDA, but Kokoro's generator also contains lazy G2P/chunking/result work. This
  is not pure kernel-only GPU time.
- `kokoro_preprocess_ms`: language, voice, model, and pipeline lookup before
  consuming the generator. Kokoro's lazy G2P/chunking is not fully included
  here.
- `kokoro_postprocess_ms`: audio tensor extraction plus concatenation and WAV
  encoding.
- `model_cold_start`, `pipeline_cold_start`, and `voice_cold_start`: explicit
  cold/warm flags, emitted as numeric metrics and metadata booleans.

## Cold And Warm Behavior

Short smoke sequence in one process:

| Request | Model cold | Pipeline cold | Voice cold | Total wall |
| --- | ---: | ---: | ---: | ---: |
| English first request | 1.0 | 1.0 | 1.0 | 3023.4 ms |
| English warm request | 0.0 | 0.0 | 0.0 | 36.5 ms |
| Chinese first request after English | 0.0 | 1.0 | 1.0 | 504.1 ms |
| Chinese warm request | 0.0 | 0.0 | 0.0 | 35.0 ms |

Interpretation:

- The first English request includes model load, English pipeline load, and voice
  load.
- The first Chinese request after English reuses the same `KModel`, but pays for
  Chinese pipeline and voice initialization.
- Fully warm English and Chinese requests are in the tens of milliseconds for
  short input on this host.

## Warm Longer Text

Both language pipelines were warmed before measuring these requests.

English input:

```text
This morning I walked to the station while the city was still quiet. I wanted to hear whether the new translation app could speak longer sentences smoothly and naturally.
```

Chinese input:

```text
今天早上，城市还很安静的时候，我步行去了车站。我想听听新的翻译应用能否流畅自然地朗读更长的句子。
```

| Metric | English | Chinese |
| --- | ---: | ---: |
| voice | `af_heart` | `zf_xiaobei` |
| language code | `a` | `z` |
| sample rate | 24000 Hz | 24000 Hz |
| input chars | 170 | 48 |
| audio duration | 10.725 s | 11.400 s |
| `tts_total_wall_ms` | 59.410 | 62.866 |
| `tts_synthesis_wall_ms` | 59.158 | 62.609 |
| `kokoro_total_wall_ms` | 59.128 | 62.585 |
| `kokoro_pipeline_wall_ms` | 58.892 | 62.323 |
| `kokoro_preprocess_ms` | 0.025 | 0.029 |
| `kokoro_model_inference_ms` | 58.866 | 62.301 |
| `kokoro_postprocess_ms` | 0.213 | 0.236 |
| `chunk_count` | 1 | 1 |
| `realtime_factor` | 0.0055 | 0.0055 |

Per-chunk timings:

| Language | Chunk | Step wall | Grapheme chars | Phoneme chars | Audio |
| --- | ---: | ---: | ---: | ---: | ---: |
| English | 1 | 58.866 ms | 170 | 168 | 10.725 s |
| Chinese | 1 | 62.301 ms | 48 | 192 | 11.400 s |

## Baseline Conclusion

On this workstation, Kokoro is comfortably faster than realtime when model,
pipeline, and voice are warm. The meaningful cold-start costs are:

- first model load: roughly 3 seconds in this local app process
- first non-English pipeline/voice after model load: roughly 500 ms for Chinese
- warm request wall time: roughly 35-65 ms for the tested short and longer
  clips

The current app-side global TTS lock is intentionally conservative. If later
throughput requires it, the next step is per-pipeline locking while preserving a
single shared `KModel`.

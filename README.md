# ASR Translate TTS

A browser app for live, turn-based speech translation.

You speak into one side, the app shows the recognized source text, translates it
into the selected target language, and can speak the translated result back.
While a session is running, you can also adjust voice options and tuning
controls for ASR/TTS behavior.

This repo contains the FastAPI backend and the static frontend. It coordinates
the session: recording, two language directions, turn state, translation timing,
speech playback, exported debug files, and the settings shown in the UI. The
ASR, LLM, and TTS pools do the model work; the app decides when and how to use
them.

## Index

- [What It Does](#what-it-does)
- [Repository Role](#repository-role)
- [Related Runtime Components](#related-runtime-components)
- [Code Map](#code-map)
- [Runtime Model](#runtime-model)
- [API Surface](#api-surface)
- [Configuration](#configuration)
- [Development](#development)
- [Tests](#tests)
- [Design Notes](#design-notes)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## What It Does

- Provides a mobile-first UI for a two-language conversation.
- Captures browser microphone audio and streams PCM audio to the backend.
- Runs live ASR through `realtime-asr-engine` and `asr-pool`.
- Runs translation through `realtime-translation-engine` and `llm-pool`.
- Sends translated text to `tts-pool`, stores the returned WAV, and plays it in
  the browser.
- Treats settings as two kinds: everyday options, such as TTS voice and speech
  sample choices, and tuning controls for ASR/TTS timing and behavior.
- Exports `.pc` transcript/debug files for offline review.
- Records TTS metrics from both the app and the pool.

## Repository Role

This repo is the app layer. It ties the browser UI, session state, and component
services together.

- FastAPI app, HTTP routes, and WebSocket session lifecycle
- browser UI, mobile state, and settings sheets
- two-lane turn state, active direction, and playback state
- bridges to ASR, translation, and TTS services/packages
- generated TTS artifacts and `.pc` transcript/debug exports
- app-level tests for turn behavior and integration boundaries

The ASR pool, LLM pool, TTS pool, and realtime engine packages live in their own
repos. This app calls them, but does not contain their model-serving or runner
internals.

## Related Runtime Components

During normal use, the app talks to these local packages and services:

- [`asr-pool-api`](https://github.com/Bobcat/asr-pool-api): client package
  used to submit ASR jobs
- [`realtime-asr-engine`](https://github.com/Bobcat/realtime-asr-engine): live
  ASR runner, rolling audio state, VAD, and commit logic
- [`realtime-translation-engine`](https://github.com/Bobcat/realtime-translation-engine):
  live source/target transcript state and LLM dispatch logic
- [`asr-pool`](https://github.com/Bobcat/asr-pool): service that runs configured
  speech recognition backends
- [`llm-pool`](https://github.com/Bobcat/llm-pool): service that runs configured
  language models
- [`tts-pool`](https://github.com/Bobcat/tts-pool): service that runs configured
  speech synthesis backends

## Code Map

```text
app/main.py              FastAPI app, static file serving, startup warmup
app/router.py            HTTP API routes
app/routes.py            WebSocket session entrypoint
app/runtime.py           live conversation runtime and turn state machine
app/asr_bridge.py        ASR pool integration
app/translation_bridge.py translation engine / LLM pool integration
app/tts_bridge.py        TTS pool integration, artifacts, metrics, TTS settings
app/live_settings.py     runtime ASR tuning schema and validation
app/asr_pc_export.py     `.pc` transcript/debug export formatting
app/sessions.py          short-lived in-memory session registry
app/protocol.py          protocol version and event helper
static/                  browser frontend
config/settings.json     public defaults
config/local.json        ignored machine-local overrides
docs/                    design notes and baseline measurements
tests/                   backend unit tests
```

## Runtime Model

The backend serves the frontend and opens one WebSocket per short-lived
conversation session. The frontend drives the session actions: start recording,
stop the mic, translate now, speak now, change direction, clear the current turn,
and finish the session.

Each session has two fixed language lanes. Each lane has its own ASR runner,
translation runner, translation bridge, and transcript state. Only the active
lane receives commands such as `speak_now`.

TTS runs out-of-process through `tts-pool`. `app/tts_bridge.py` posts synthesis
requests to the pool's `/v1/responses` endpoint, stores returned WAV audio under
`data/tts`, and returns an artifact URL to the frontend. For VoxCPM-family
backends, the app builds the voice instruction prompt, can include the latest
eligible ASR WAV chunk as a speech sample, and clips that sample locally to the
configured maximum duration before upload.

Settings can be changed from the frontend during a session. The app-level
settings are split conceptually into options and tuning controls: options are
the choices an end user should understand, while tuning controls are for
developer/debug work such as ASR responsiveness, commit behavior, and TTS timing.
Model-serving settings stay in the component services.

## API Surface

HTTP:

- `GET /api/health`
- `GET /api/config`
- `POST /api/tts-settings`
- `POST /api/sessions`
- `GET /api/sessions/{session_id}/tts/{artifact_id}`
- `GET /api/sessions/{session_id}/transcript.pc`

WebSocket:

- `GET /ws/sessions/{session_id}`

Static frontend:

- `/`

The WebSocket event schema is versioned with
`protocol_version = "asr_translate_tts_v1"`.

## Configuration

Defaults live in `config/settings.json`.

Machine-local values belong in ignored `config/local.json`. Use that file for
local service URLs, VAD environment paths, and local model names.

Common settings:

- `service.root_path`: optional mount prefix for reverse-proxy deployments
- `asr_pool.base_url`: ASR pool service base URL
- `tts_pool.base_url`: TTS pool service base URL
- `tts_pool.timeout_s`: TTS pool HTTP request timeout
- `live.audio.*`: browser audio format expected by the backend
- `live.asr.*`: ASR backend and decode parameters exposed through live tuning
- `live.rolling.vad.*`: backend VAD settings
- `live.rolling.pacing.*`: ASR dispatch pacing settings
- `live.rolling.speech_gate.*`: speech gate settings for dispatch behavior
- `translation.model`: LLM pool model id
- `translation.request_format`: translation payload format
- `translation.source_language` / `translation.target_language`: default
  session languages
- `tts.enabled`: enables or disables TTS
- `tts.backend`: selected TTS engine exposed through `tts-pool`
- `tts.voxcpm2_use_asr_reference_wav`: whether VoxCPM2 receives the last ASR
  speech sample
- `tts.voxcpm2_reference_max_duration_s`: max speech-sample duration sent to
  VoxCPM2
- `tts.voxcpm2_reference_match`: whether the app adds a voice-only or
  voice-plus-pace instruction when sending a speech sample
- `tts.voxcpm2_voice_presets`: language-specific app-side voice description
  presets for VoxCPM-family backends

The four `tts.voxcpm2_*` keys above describe the **current** behavior. They
are scheduled to be replaced by a per-language voice configuration in Phase 1
of the [VoxCPM Options Redesign](docs/voxcpm-options-redesign.md).

## Development

Create the app environment:

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -e .
```

Install the local component packages:

```bash
./.venv/bin/python -m pip install -e ../asr-pool-api
./.venv/bin/python -m pip install -e ../realtime-asr-engine
./.venv/bin/python -m pip install -e ../realtime-translation-engine
```

Create `config/local.json` for machine-local settings. Example:

```json
{
  "live": {
    "rolling": {
      "vad": {
        "enabled": true,
        "venv": "/path/to/vad-venv"
      }
    }
  },
  "tts_pool": {
    "base_url": "http://127.0.0.1:8020",
    "timeout_s": 300
  },
  "tts": {
    "enabled": true,
    "backend": "voxcpm2",
    "voxcpm2_use_asr_reference_wav": true,
    "voxcpm2_reference_max_duration_s": 8,
    "voxcpm2_reference_match": "voice"
  }
}
```

Start the app:

```bash
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8003
```

Open:

```text
http://127.0.0.1:8003/
```

ASR, translation, and TTS calls require running ASR pool, LLM pool, and TTS pool
services.

## Tests

Run the app tests:

```bash
./.venv/bin/python -m unittest discover -s tests
```

Syntax checks used during development:

```bash
node --input-type=module --check < static/src/app.js
./.venv/bin/python -m py_compile app/main.py app/asr_bridge.py app/router.py app/runtime.py app/sessions.py app/tts_bridge.py app/live_settings.py app/asr_pc_export.py
git diff --check
```

## Design Notes

The repo also includes design notes and trackers in various stages of completion:

- [notes-timeline.md](docs/notes-timeline.md)
  Tracks the order, implementation status, and current code relation of the design notes.
- [MVP Turn-Taking Design](docs/mvp-turn-taking-design.md)
  Captures the baseline two-lane ASR -> Translate -> TTS turn-taking architecture.
- [Turn State Machine Next](docs/turn-state-machine-next.md)
  Captures the current app-level turn and `turn_part` state model.
- [View Modes And Session Lifecycle](docs/view-modes-session-lifecycle.md)
  Captures setup, running, mic-off, finished, and view-mode behavior.
- [Translate Now Design](docs/translate-now-design.md)
  Defines the manual translation action used in the turn-based workflow.
- [VoxCPM Options Redesign](docs/voxcpm-options-redesign.md)
  Design contract for the next phase of VoxCPM2 / NanoVLLM-VoxCPM voice
  settings: per-language modes, Hi-Fi cloning, Stable Generated library,
  guided own-voice setup.
- [Kokoro TTS Baseline](docs/kokoro-tts-baseline.md)
  Historical Kokoro timing baseline.

## Acknowledgments

- [Kokoro](https://github.com/hexgrad/kokoro) for the local TTS model and Python pipeline.
- [VoxCPM2](https://huggingface.co/openbmb/VoxCPM2) for multilingual reference-audio TTS.
- [NanoVLLM-VoxCPM](https://github.com/a710128/nanovllm-voxcpm) for high-throughput VoxCPM serving.

## License

No license file is currently included.

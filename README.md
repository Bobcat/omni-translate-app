# ASR Translate TTS

Mobile-first web app for live turn-based speech translation:

```text
browser audio -> realtime ASR -> LLM translation -> Kokoro TTS playback
```

The repository contains a small FastAPI backend and the static browser frontend
it serves. The app is built as a fast development target for a future mobile
experience, with one core workflow: capture speech, recognize it, translate it,
and optionally play the translated text as speech.

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

## What It Does

- Serves a mobile-first browser UI for a turn-based translation conversation.
- Captures microphone audio in the browser and streams PCM audio to the backend.
- Routes live audio through a realtime ASR runner and ASR pool service.
- Sends committed source text through a realtime translation engine and LLM pool.
- Generates target-language audio with Kokoro through `realtime-tts-engine`.
- Keeps app-level turn state, active direction, spoken/unspoken text, and visible
  source/target text in this repository.
- Emits TTS metrics that separate queue wait, synthesis wall time, Kokoro
  pipeline time, cold/warm state, chunk count, audio duration, and realtime
  factor.

## Repository Role

This repo is the application integration layer. It owns:

- the FastAPI app and WebSocket session lifecycle
- the frontend control surface and mobile-first UI state
- turn-taking behavior
- ASR -> Translate -> TTS orchestration
- generated TTS artifacts for active sessions
- app-level tests for turn state and integration boundaries

It does not own:

- ASR model serving
- LLM model serving
- reusable ASR, translation, or TTS engine package internals
- long-term conversation history storage
- production deployment infrastructure

## Related Runtime Components

The app expects these components to be available as installed packages or
reachable services:

- [`asr-pool-api`](https://github.com/Bobcat/asr-pool-api): client package
  used to submit ASR jobs
- [`realtime-asr-engine`](https://github.com/Bobcat/realtime-asr-engine): live
  ASR runner, rolling audio state, VAD, and commit logic
- [`realtime-translation-engine`](https://github.com/Bobcat/realtime-translation-engine):
  live source/target transcript state and LLM dispatch logic
- [`realtime-tts-engine`](https://github.com/Bobcat/realtime-tts-engine): TTS
  package with Kokoro integration
- [`asr-pool`](https://github.com/Bobcat/asr-pool): ASR service
- [`llm-pool`](https://github.com/Bobcat/llm-pool): LLM service

## Code Map

```text
app/main.py              FastAPI app, static file serving, startup warmup
app/router.py            HTTP API routes
app/routes.py            WebSocket session entrypoint
app/runtime.py           live conversation runtime and turn state machine
app/asr_bridge.py        ASR pool integration
app/translation_bridge.py translation engine / LLM pool integration
app/tts_bridge.py        Kokoro TTS integration, artifacts, metrics
app/sessions.py          short-lived in-memory session registry
app/protocol.py          protocol version and event helper
static/                  browser frontend
config/settings.json     public defaults
config/local.json        ignored machine-local overrides
docs/                    design notes and baseline measurements
tests/                   backend unit tests
```

## Runtime Model

The backend serves the static frontend and accepts one WebSocket per short-lived
conversation session. The frontend controls when recording starts, when the mic
is stopped, when the current turn is spoken, when the direction changes, and
when the session finishes.

The backend keeps two fixed language lanes for the session. Each lane has its
own ASR runner, translation runner, translation bridge, and transcript state.
Only the active lane receives user commands such as `speak_now`.

Kokoro TTS runs through one app-wide `TTSBridge` singleton per Python process.
That singleton owns one `TTSEngine` and one `KokoroSynthesizer`. The synthesizer
uses one shared Kokoro `KModel` and caches one `KPipeline` per Kokoro language
code. Metrics and cold/warm timings are recorded in
[docs/kokoro-tts-baseline.md](docs/kokoro-tts-baseline.md).

## API Surface

HTTP:

- `GET /api/health`
- `GET /api/config`
- `POST /api/sessions`
- `GET /api/sessions/{session_id}/tts/{artifact_id}`

WebSocket:

- `GET /ws/sessions/{session_id}`

Static frontend:

- `/`

The WebSocket event schema is versioned with
`protocol_version = "asr_translate_tts_v1"`.

## Configuration

Defaults live in `config/settings.json`.

Machine-local values belong in ignored `config/local.json`. Use that file for
local service URLs, VAD environment paths, Kokoro model paths, and local model
names.

Common settings:

- `service.root_path`: optional mount prefix for reverse-proxy deployments
- `asr_pool.base_url`: ASR pool service base URL
- `live.audio.*`: browser audio format expected by the backend
- `live.rolling.vad.*`: backend VAD settings
- `translation.model`: LLM pool model id
- `translation.request_format`: translation payload format
- `translation.source_language` / `translation.target_language`: default
  session languages
- `tts.enabled`: enables or disables TTS
- `tts.kokoro_model_root`: local Kokoro model directory
- `tts.warmup_language` / `tts.warmup_text`: fallback TTS warmup request

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
./.venv/bin/python -m pip install -e '../realtime-tts-engine[kokoro]'
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
  "tts": {
    "enabled": true,
    "kokoro_model_root": "/path/to/kokoro-82m"
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

The ASR and translation calls require running ASR pool and LLM pool services.

## Tests

Run the app tests:

```bash
./.venv/bin/python -m unittest discover -s tests
```

Syntax checks used during development:

```bash
node --input-type=module --check < static/src/app.js
./.venv/bin/python -m py_compile app/main.py app/router.py app/runtime.py app/tts_bridge.py
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
- [Kokoro TTS Baseline](docs/kokoro-tts-baseline.md)
  Captures the current Kokoro runtime shape, metrics scope, hardware, and cold/warm baseline timings.

## Acknowledgments

- [Kokoro](https://github.com/hexgrad/kokoro) for the local TTS model and Python pipeline.

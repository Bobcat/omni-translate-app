# Omni Translate

Omni Translate is a mobile-first FastAPI and browser app for live translation
workflows. It supports speech translation, translated speech playback, image
translation, and app-managed voice-reference samples.

This repository is the app layer. It serves the web UI, owns visible workflow
state, coordinates short-lived sessions, and proxies model work to separate ASR,
translation, TTS, and image-translation services.

## Index

- [What It Does](#what-it-does)
- [Repository Role](#repository-role)
- [Related Repositories And Services](#related-repositories-and-services)
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

- Provides a mobile-first UI for a two-language live conversation.
- Captures browser microphone audio and streams PCM chunks to the backend.
- Runs live ASR through `realtime-asr-engine` and an ASR pool service.
- Runs source-to-target translation through `realtime-translation-engine` and an
  LLM pool service.
- Sends translated text to a TTS pool, stores received WAV artifacts, and plays
  speech in the browser.
- Supports image translation from file upload or camera capture, with
  original/translated image toggling and target-language retranslation.
- Provides TTS settings for Kokoro, VoxCPM2, and NanoVLLM VoxCPM-style engines.
- Manages a stable generated voice library: generate, preview, keep, discard,
  and serve per-language voice-reference WAV samples.
- Exposes ASR tuning, microphone, TTS, history, voice library, and developer
  controls through settings sheets.
- Exports `.pc` transcript/debug files for offline review.

## Repository Role

This repo owns app-level behavior:

- FastAPI app setup, HTTP routes, and WebSocket session lifecycle
- browser UI, responsive workflow state, and settings screens
- setup, speech-session, and image-translation modes
- two-lane conversation state, active direction, visible transcript, and playback state
- bridges to ASR, translation, TTS, and image-translation services/packages
- local TTS artifacts, generated voice-library samples, and `.pc` exports
- app-level tests for runtime behavior and integration boundaries

This repo does not own model serving. ASR, LLM, TTS, and image translation are
implemented by separate packages or services.

## Related Repositories And Services

- [`asr-pool-api`](https://github.com/Bobcat/asr-pool-api): ASR pool client
  package used by the app bridge.
- [`realtime-asr-engine`](https://github.com/Bobcat/realtime-asr-engine):
  rolling audio state, VAD, ASR pacing, and transcript commit logic.
- [`realtime-translation-engine`](https://github.com/Bobcat/realtime-translation-engine):
  live source/target transcript state and LLM dispatch logic.
- [`asr-pool`](https://github.com/Bobcat/asr-pool): speech-recognition service.
- [`llm-pool`](https://github.com/Bobcat/llm-pool): translation model service.
- [`tts-pool`](https://github.com/Bobcat/tts-pool): speech-synthesis service.
- `translation-services`: image OCR, translation, and rendered-image service.

## Code Map

```text
app/main.py                    FastAPI app, static serving, startup warmup
app/router.py                  HTTP API routes
app/routes.py                  WebSocket session entrypoint
app/runtime.py                 live conversation runtime and transcript state machine
app/asr_bridge.py              ASR pool integration
app/translation_bridge.py      translation engine / LLM pool integration
app/tts_bridge.py              TTS pool integration, artifacts, TTS settings
app/image_translation_bridge.py image-translation service proxy
app/voice_library.py           generated stable voice-reference sample library
app/live_settings.py           runtime ASR tuning schema and validation
app/asr_pc_export.py           `.pc` transcript/debug export formatting
app/sessions.py                short-lived in-memory session registry
app/protocol.py                protocol version and event helper

static/index.html              browser shell and settings sheet markup
static/src/app.js              frontend composition root
static/src/image/              image-translation workflow
static/src/session/            speech-session lifecycle, actions, messages
static/src/settings/           audio, ASR tuning, TTS, voice library, dev tools
static/src/ui/                 rendering and sheet helpers
static/src/domain/             lanes, languages, storage, transcript helpers
static/src/shared/             capture, playback, cue, constants, utilities

config/settings.json           public defaults
config/local.json              ignored machine-local overrides
config/voice_reference_texts/  seed text for generated voice samples
data/                          local artifacts and generated samples
docs/                          current and archived design notes
tests/                         backend unit tests
```

## Runtime Model

The backend serves the static frontend and exposes a JSON/HTTP API plus one
WebSocket per live speech session. Sessions are short-lived and stored in memory.
The frontend creates a session, opens the WebSocket, sends PCM audio chunks, and
drives explicit actions such as translate now, speak now, mic on/off, direction
swap, continue, and finish.

Each live session has two fixed language lanes. Each lane has its own ASR runner,
translation runner, transcript state, and pending TTS state. The frontend chooses
the active lane; the backend applies commands to that lane.

TTS is out-of-process. The app posts synthesis requests to `tts-pool`, stores
generated WAV files under `data/tts`, and provides artifact URLs to the browser.
For VoxCPM-family backends, the app can use generated stable samples or recent
speech as reference audio, depending on the active TTS settings.

Image translation is a separate mode, not a WebSocket session. The frontend sends
the selected image to `/api/image-translation`; the backend submits the request
to `translation-services`, waits for completion, and provides the rendered image.
Changing the target language can retranslate the same source request.

The frontend persists some user-facing preferences in `localStorage`, including
recent languages, global TTS choices, per-language VoxCPM voice configuration,
developer-tool visibility, and setup languages. The server owns generated voice
library WAVs and metadata.

## API Surface

HTTP:

- `GET /api/health`
- `GET /api/config`
- `POST /api/image-translation`
- `POST /api/image-translation/{source_request_id}/retranslate`
- `POST /api/voice-library/stable`
- `POST /api/voice-library/stable/{language}/{gender}/keep-pending`
- `POST /api/voice-library/stable/{language}/{gender}/discard-pending`
- `GET /api/voice-library/stable/{language}/{gender}/audio.wav`
- `GET /api/voice-library/stable/{language}/{gender}/audio.pending.wav`
- `POST /api/sessions`
- `GET /api/sessions/{session_id}/tts/{artifact_id}`
- `GET /api/sessions/{session_id}/transcript.pc`

WebSocket:

- `/ws/sessions/{session_id}`

Static frontend:

- `/`

The WebSocket event schema is versioned with
`protocol_version = "asr_translate_tts_v1"`.

## Configuration

Defaults live in `config/settings.json`. Machine-local values belong in ignored
`config/local.json`.

Important settings:

- `service.root_path`: optional mount prefix for reverse-proxy deployments
- `asr_pool.base_url` / `asr_pool.token`: ASR pool connection
- `tts_pool.base_url` / `tts_pool.timeout_s`: TTS pool connection
- `image_translation.base_url`: translation-services base URL
- `image_translation.request_timeout_s`: image request timeout
- `image_translation.poll_interval_s`: image request polling interval
- `live.session_ttl_s`: in-memory session lifetime
- `live.audio.*`: browser audio format expected by the backend
- `live.asr.*`: ASR backend and decode parameters
- `live.rolling.*`: ASR dispatch, commit, VAD, and speech-gate tuning
- `translation.model`: LLM pool model id
- `translation.request_format`: translation payload format
- `translation.source_language` / `translation.target_language`: default setup
  languages
- `translation.preview.*`: optional translation preview thresholds
- `tts.enabled`: enables or disables TTS
- `tts.backend`: selected TTS engine exposed by `tts-pool`
- `tts.voxcpm2.ultimate_cloning.*`: reference-audio source behavior for
  VoxCPM-family backends
- `config/voice_reference_texts/*.txt`: source text used when generating stable
  voice-library samples

Example `config/local.json`:

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
  "image_translation": {
    "base_url": "http://127.0.0.1:8030"
  },
  "tts": {
    "enabled": true,
    "backend": "nanovllm_voxcpm"
  }
}
```

## Development

Create the app environment:

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -e .
```

Install the local component packages used by the app:

```bash
./.venv/bin/python -m pip install -e ../asr-pool-api
./.venv/bin/python -m pip install -e ../realtime-asr-engine
./.venv/bin/python -m pip install -e ../realtime-translation-engine
```

Start the app:

```bash
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8003
```

Open:

```text
http://127.0.0.1:8003/
```

ASR, translation, TTS, and image-translation workflows require their component
services to be running and reachable from the configured URLs.

## Tests

Run the app tests:

```bash
./.venv/bin/python -m unittest discover -s tests
```

Syntax and patch checks commonly used during development:

```bash
node --input-type=module --check < static/src/app.js
./.venv/bin/python -m py_compile app/main.py
git diff --check
```

## Design Notes

Current integration notes:

- [Image Translation Integration](docs/image-translation-integration.md)

Archived design notes:

- [View Modes And Session Lifecycle](docs/archived/view-modes-session-lifecycle.md)
- [Translate Now Design](docs/archived/translate-now-design.md)
- [VoxCPM Options Redesign](docs/archived/voxcpm-options-redesign.md)
- [VoxCPM Options Redesign Implementation Log](docs/archived/voxcpm-options-redesign-implementation-log.md)
- [Kokoro TTS Baseline](docs/archived/kokoro-tts-baseline.md)

## Acknowledgments

- [Kokoro](https://github.com/hexgrad/kokoro) for local TTS model tooling.
- [VoxCPM2](https://huggingface.co/openbmb/VoxCPM2) for multilingual
  reference-audio TTS.
- [NanoVLLM-VoxCPM](https://github.com/a710128/nanovllm-voxcpm) for
  high-throughput VoxCPM serving.

## License

No license file is currently included.

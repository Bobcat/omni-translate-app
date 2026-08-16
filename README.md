# Omni Translate

Omni Translate is a self-hosted translation app for typed text, live voice,
images, and PDFs. It combines a FastAPI backend with separate desktop and mobile
browser interfaces. Model inference runs in dedicated ASR, LLM, TTS, and
document-processing services.

This repository contains the application layer. It owns the user workflows,
short-lived voice sessions, resumable document operations, authentication and
anonymous identity handling, entitlements, usage accounting, and service
orchestration.

## Index

- [What It Does](#what-it-does)
- [Web Interfaces](#web-interfaces)
- [Repository Role](#repository-role)
- [Related Repositories And Services](#related-repositories-and-services)
- [Code Map](#code-map)
- [Runtime Model](#runtime-model)
- [API Surface](#api-surface)
- [Configuration](#configuration)
- [Development](#development)
- [Tests](#tests)
- [Build And Deploy](#build-and-deploy)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## What It Does

- Translates typed or pasted text with explicit source and target languages.
- Runs turn-based voice translation: browser audio to ASR, translated text, and
  optional spoken output.
- Translates text inside PNG, JPEG, and WebP images and renders the translation
  back into the image.
- Translates born-digital, scanned, and mixed PDFs while preserving page
  structure as far as the source permits.
- Shows progress for image and PDF jobs and supports cancellation, retranslation,
  rerendering, and result downloads where applicable.
- Recovers pending image and PDF operations after a reload by storing an
  operation reference, not the uploaded document bytes, in the browser.
- Supports optional Google sign-in through Supabase. Without configured auth,
  the app uses a signed anonymous browser identity.
- Applies plan entitlements and workflow-specific limits. Image and PDF
  operations also use quota reservations and usage accounting.

## Web Interfaces

The same URL serves two plain-JavaScript frontends:

- **Desktop** — a workbench-style sidebar app with separate text, voice, image,
  PDF, account, settings, and information views.
- **Mobile** — a turn-focused conversation interface with image translation and
  settings sheets for the smaller screen.

The server selects the interface from the user agent. `?desktop` and `?mobile`
force a variant. `/desktop/` remains available as a direct desktop path.

There is no frontend framework build step. The desktop app uses a vendored copy
of `spa-foundation`; both interfaces use browser-native ES modules.

## Repository Role

This repository owns:

- FastAPI composition, HTTP routes, and the live-session WebSocket
- desktop and mobile workflow state and rendering
- text, voice, image, and PDF orchestration
- operation identity, ownership checks, cancellation, and recovery metadata
- application-level authentication, principals, entitlements, quotas, and usage
- local voice-reference samples, temporary TTS artifacts, and transcript exports
- tests for app behavior and upstream integration boundaries

It does not serve inference models or implement the document translation
pipeline itself. Those responsibilities remain in the pool and translation
services listed below.

The `saas/` package is intentionally domain-free. It contains reusable principal,
entitlement, quota, usage-ledger, and resource-ownership primitives. Omni
Translate-specific wiring belongs in `app/saas_setup.py` and
`config/settings.json`.

## Related Repositories And Services

- [`asr-pool-api`](https://github.com/Bobcat/asr-pool-api) — typed client for the
  speech-recognition pool.
- [`realtime-asr-engine`](https://github.com/Bobcat/realtime-asr-engine) — live
  audio ingest, ASR scheduling, and transcript state.
- [`realtime-translation-engine`](https://github.com/Bobcat/realtime-translation-engine)
  — incremental translation scheduling and live translation state.
- [`asr-pool`](https://github.com/Bobcat/asr-pool) — queued WhisperX speech
  recognition.
- [`llm-pool`](https://github.com/Bobcat/llm-pool) — local and OpenAI-compatible
  language-model inference.
- [`tts-pool`](https://github.com/Bobcat/tts-pool) — queued speech synthesis and
  model management.
- `translation-services` — text translation plus OCR, layout analysis,
  translation, and rendering for images and PDFs.

## Code Map

```text
app/main.py                     FastAPI composition, frontend selection, static serving
app/router.py                   application HTTP endpoints
app/routes.py                   live-session WebSocket endpoint
app/runtime.py                  live conversation runtime and transcript state
app/voice/                      voice-session tasks, lifecycle, and TTS delivery
app/asr_bridge.py               ASR pool integration
app/translation_bridge.py       live LLM and text-translation integration
app/tts_bridge.py               TTS settings and artifact handling
app/image_translation_bridge.py image-operation client
app/pdf_translation_bridge.py   PDF-operation client
app/image_*                     image validation, admission, ownership, and quota handling
app/pdf_*                       PDF options, ownership, quota, and reconciliation
app/upstreams/                  shared HTTP client and generated TTS gRPC client
app/saas_setup.py               host-specific SaaS composition

saas/                           principals, entitlements, admission, quota, and usage ledger

static/desktop/                 desktop sidebar application
static/src/                     mobile application modules
static/shared/                  browser modules shared by both interfaces
static/foundation/              vendored spa-foundation package
static/styles/                  mobile styles

config/settings.json            checked-in defaults and plan definitions
config/local.json               ignored machine-local overrides
config/voice_reference_texts/   seed text for generated voice samples
data/                           ignored runtime state and generated artifacts

tests/                          Python backend tests
tests/js/                       DOM-independent frontend tests
```

## Runtime Model

### Text

Typed text translation is a stateless request-response workflow. The browser
sends the complete current text to `POST /api/text-translation` and ensures that
only the newest result reaches the screen. The backend applies entitlement,
length, rate, and concurrency checks before calling `translation-services`.

### Voice

A voice workflow starts an in-memory session and opens one WebSocket. The browser
sends PCM audio and explicit turn actions. Each language lane has its own ASR,
translation, transcript, and pending-TTS state.

ASR work goes to `asr-pool`; live translation goes through
`realtime-translation-engine` and `llm-pool`. TTS is submitted to `tts-pool` over
gRPC. The app stores the returned WAV temporarily and serves it back to the
browser.

### Images And PDFs

Image and PDF translation use operation IDs and separate upstream jobs in
`translation-services`. The app validates ownership before status, artifact,
retranslation, rerender, or cancellation requests.

The frontends retain one pending operation reference per account identity. A
reload can resume polling without storing or re-uploading the original file.
Generated documents are temporary; users should download completed results.

PDF quota reservations are settled from the upstream terminal state. A
background reconciler handles operations that outlive the browser request.

### Identity And Usage

Principal resolution follows this order:

1. a valid bearer token from the configured external auth provider;
2. a signed anonymous identity cookie.

Plan definitions live in `config/settings.json`. The current implementation
stores principals, ownership records, quota reservations, and usage events in
SQLite. Auth is optional; when it is not configured, account controls stay
hidden and the anonymous path remains available.

## API Surface

Core:

- `GET /api/health`
- `GET /api/config`
- `POST /api/text-translation`

Image operations:

- `POST /api/image-translation`
- `GET /api/image-translation/requests/{operation_id}`
- `GET /api/image-translation/requests/{operation_id}/artifact`
- `POST /api/image-translation/requests/{operation_id}/cancel`
- `POST /api/image-translation/{source_request_id}/retranslate`
- `POST /api/image-translation/{source_request_id}/rerender`

PDF operations:

- `POST /api/pdf-translation/requests`
- `GET /api/pdf-translation/requests/{request_id}`
- `GET /api/pdf-translation/requests/{request_id}/artifacts/{artifact_name}`
- `POST /api/pdf-translation/requests/{request_id}/cancel`
- `POST /api/pdf-translation/requests/{source_request_id}/rerender`

Identity and usage:

- `GET /api/me`
- `GET /api/entitlements`
- `GET /api/usage`

Voice and voice library:

- `POST /api/sessions`
- `GET /api/sessions/{session_id}/tts/{artifact_id}`
- `GET /api/sessions/{session_id}/transcript.pc`
- `POST /api/voice-library/stable`
- `POST /api/voice-library/stable/{language}/{gender}/keep-pending`
- `POST /api/voice-library/stable/{language}/{gender}/discard-pending`
- `GET /api/voice-library/stable/{language}/{gender}/audio.wav`
- `GET /api/voice-library/stable/{language}/{gender}/audio.pending.wav`

WebSocket:

- `/ws/sessions/{session_id}`

The WebSocket event schema uses
`protocol_version = "asr_translate_tts_v1"`.

## Configuration

Defaults live in `config/settings.json`. Put machine-local URLs, credentials,
and auth-provider settings in ignored `config/local.json`.

Important configuration groups:

- `service.*` — reverse-proxy mount path
- `saas.auth.*` — optional external JWT and browser sign-in configuration
- `saas.plans.*` / `saas.usage_metrics` — entitlements and usage limits
- `asr_pool.*` — speech-recognition service
- `tts_pool.*` — TTS control API, gRPC target, and message limits
- `translation_services.*` — typed-text translation client
- `image_translation.*` — image service URL, polling, and reconciliation
- `pdf_translation.*` — PDF service URL and reconciliation
- `upstream_http.*` — shared HTTP connection limits
- `text_translation.*` — quality profile and short-lived success cache
- `live.*` — session lifetime, audio, ASR, VAD, and turn timing
- `translation.*` — live translation defaults
- `tts.*` — selected speech backend and reference-audio behavior

Minimal local service overrides can look like this:

```json
{
  "asr_pool": {
    "base_url": "http://127.0.0.1:8090"
  },
  "tts_pool": {
    "control_base_url": "http://127.0.0.1:8020",
    "grpc_target": "127.0.0.1:8021"
  },
  "translation_services": {
    "base_url": "http://127.0.0.1:8030"
  },
  "image_translation": {
    "base_url": "http://127.0.0.1:8030"
  },
  "pdf_translation": {
    "base_url": "http://127.0.0.1:8030"
  }
}
```

## Development

Create the app environment:

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -e .
```

Install the local component packages used by live voice translation:

```bash
./.venv/bin/python -m pip install -e ../asr-pool-api
./.venv/bin/python -m pip install -e ../realtime-asr-engine
./.venv/bin/python -m pip install -e ../realtime-translation-engine
```

Start the app:

```bash
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8003
```

Open `http://127.0.0.1:8003/`. Add `?desktop` or `?mobile` to force an
interface.

Only the workflows whose upstream services are running will be functional.

## Tests

Run the backend and frontend suites:

```bash
./.venv/bin/python -m unittest discover -s tests
node --test tests/js/
```

Syntax and patch checks used during development:

```bash
node --input-type=module --check < static/src/app.js
./.venv/bin/python -m py_compile app/main.py
git diff --check
```

## Build And Deploy

There is no JavaScript build step. FastAPI serves the checked-in HTML, CSS,
JavaScript modules, icons, and manifest directly.

Run one application worker. The current per-principal rate and concurrency
controllers are process-local; they have not yet moved to a shared store.
Public deployments should place the app behind a TLS reverse proxy and keep
model services on trusted network interfaces.

## Acknowledgments

- [Kokoro](https://github.com/hexgrad/kokoro) for local TTS model tooling.
- [VoxCPM2](https://huggingface.co/openbmb/VoxCPM2) for multilingual
  reference-audio TTS.
- [NanoVLLM-VoxCPM](https://github.com/a710128/nanovllm-voxcpm) for
  high-throughput VoxCPM serving.

## License

No license file is currently included.

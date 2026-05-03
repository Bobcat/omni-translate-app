# ASR Translate TTS

Small mobile-first web app for one workflow:

```text
live audio -> ASR -> translation -> TTS
```

The backend is the integration layer. It serves the static frontend from
`static/`, accepts live PCM audio over a WebSocket, uses the reusable realtime
ASR and translation engines, and renders committed target text through the TTS
engine.

## Local Development

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -e .
./.venv/bin/python -m pip install -e ../asr-pool-api-dev
./.venv/bin/python -m pip install -e ../realtime-asr-engine
./.venv/bin/python -m pip install -e ../realtime-translation-engine
./.venv/bin/python -m pip install -e ../realtime-tts-engine
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8003
```

Open:

```text
http://127.0.0.1:8003/
```

The ASR and translation calls expect local `asr-pool` and `llm-pool` services.
Defaults live in `config/settings.json`; machine-local overrides go in
`config/local.json`.


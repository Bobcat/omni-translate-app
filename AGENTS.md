# Agent Instructions (Omni Translate Dev)

## Scope

- This repository contains the ASR -> Translate -> TTS app backend and frontend.
- Keep changes scoped to this repo unless the task explicitly names another repo.
- Do not change ASR, translation, or TTS component/service repos from here unless explicitly requested.
- This app is the owner of app-level UX state, turn handling, local history decisions, and visible workflow behavior.

## Architecture Rules

- The frontend is the controlling surface for reachable backend code paths.
- Do not add fallback, compatibility, or "just in case" paths unless explicitly requested.
- Do not leave obsolete UX or protocol paths in place after replacing them.
- Keep app state in the app layer. Do not push app reset/local-history/turn UX responsibilities into runner/package state.
- Treat the MVP as turn-based: explicit user actions, active lane, clear turn, speak now, finish.
- Backend changes should map directly to current frontend-reachable behavior.

## UI Rules

- The current mobile-first turn UI is the target surface.
- Do not revive earlier layout experiments without explicit instruction.
- Keep CSS lean: remove stale selectors, unused variables, and half-retained experiments when touched.
- If changing static CSS or JS behavior, update the cache-busting query in `static/index.html`.
- Settings use mobile sheet semantics: top-level closes with a down chevron; subpages return with a left arrow.
- Preserve accessibility labels when replacing text buttons with icon buttons.

## Local Run

```bash
cd /home/gunnar/projects/asr-translate-tts-dev
source .venv/bin/activate
python -m uvicorn app.main:app --host 127.0.0.1 --port 8003
```

Public dev testing uses `https://translate.omniscripta.com`, routed through Cloudflare to local port `8003`.

## Checks

Run the relevant subset before handing back changes. For normal frontend/backend edits, run:

```bash
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
python -m unittest discover -s tests
git diff --check
```

## Git Discipline

- Do not commit, push, tag, merge, rebase, or create PRs without explicit permission.
- Keep commits scoped: separate cleanup from UI/behavior changes.
- Before committing, run checks and inspect `git status --short`.
- Never revert user changes unless explicitly requested.

## Out Of Scope By Default

- Broad frontend restructuring.
- Component package changes.
- Service repo changes.
- New protocol variants.
- Legacy compatibility paths.

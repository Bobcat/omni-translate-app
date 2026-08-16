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
- `saas/` is the domain-free SaaS control layer (principals, entitlements, quota, usage ledger, resource ownership), built to be extractable into a standalone package/service later. Keep translation/image/PDF vocabulary out of it; host wiring lives in `app/saas_setup.py` and plan values in `config/settings.json` under `saas.*`. Working docs are in `plan/` (gitignored). The image-translation routes resolve the caller's principal and entitlements via `app/saas_setup.resolve_request_context`. Translate uploads get bounded byte, content-MIME, dimension, and pixel validation before service work. Translate, retranslate, and rerender share process-local per-principal rate and concurrency admission; this assumes one app worker until the controller moves to a shared store. Every successful image action records its translation-services request ID with the principal. Retranslate and rerender require ownership of their source request ID before service work. Both frontends clear image state when the authenticated account changes. Initial translation also forwards the plan's per-image character ceiling to translation-services as the generic `max_source_characters` request field; its `SOURCE_CHARACTER_LIMIT_EXCEEDED` rejection comes back as a structured 422 detail. The PDF-translation submit goes through `app/pdf_quota.py`: it counts source pages with pypdf. Plans without `pdf_translation.preview_first_pages` enforce `max_pages_per_job` as a hard cap. Preview plans send only the first `max_pages_per_job` pages upstream and reserve `pdf_translation.pages` for the submitted page count. The anonymous plan ships with two preview pages per job and six pages per month; the free plan keeps 25 pages per job and 50 per month. Poll/cancel routes and the background reconciler share one settlement policy: completed and accepted-cancelled jobs consume; only `REQUEST_FAILED` and `REQUEST_INTERRUPTED_BY_RESTART` release; an upstream 404 consumes after a 24-hour grace period; temporary upstream errors keep the reservation. The desktop PDF view shows the remaining balance and preview scope. It stores one pending operation ID plus recovery metadata per account owner key, including anonymous; reload resumes by status lookup without storing or re-uploading PDF bytes, and an account switch removes the previous account's local reference. Principal resolution order: a valid bearer JWT (Supabase; verifier config in `saas.auth.*`, off when `issuer` is empty) → user principal, else the signed anonymous cookie. Both frontends have an `auth.js` (Supabase SDK via CDN; Google sign-in via Google Identity Services — the Google-rendered button opens a popup and the resulting ID token is exchanged with `signInWithIdToken`, so there is no page redirect and no return-URL handling anywhere) plus shared `auth-headers.js` bearer plumbing; account UI hides entirely when `/api/config` → `auth.configured` is false (which needs `saas.auth.google_client_id` alongside the Supabase url/publishable key).

## UI Rules

- The current mobile-first turn UI is the target surface.
- Do not revive earlier layout experiments without explicit instruction.
- Keep CSS lean: remove stale selectors, unused variables, and half-retained experiments when touched.
- If changing static CSS or JS behavior, update the cache-busting query in `static/index.html`.
- Settings use mobile sheet semantics: top-level closes with a down chevron; subpages return with a left arrow.
- Preserve accessibility labels when replacing text buttons with icon buttons.

## Desktop Variant

- `static/desktop/` is the desktop frontend: a workbench-style sidebar SPA. The landing route `GET /` (app/main.py) serves it to desktop user agents and the mobile-first app to mobile ones, so both live on the same URL; `?desktop` / `?mobile` force a variant, and `/desktop/` keeps working as a direct path.
- It is built on the vendored spa-foundation package at `static/foundation/spa-foundation/` (a plain copy from the `spa-foundation` repo, same layout as the LLM Workbench vendor copy; update by re-copying — no build step).
- Sidebar views live under `static/desktop/src/views/` (text, voice, image, pdf, settings), mounted via hash routes (`#text`, `#voice`, `#image`, `#pdf`, `#settings`). The text view is wired to `POST /api/text-translation` (stateless one-shot; the view owns the debounce+ceiling timing policy and guards freshness newest-wins). The image and pdf views are wired to the backend (`/api/image-translation`, `/api/pdf-translation/requests`); the voice view is wired to the same session backend as the mobile app (`POST /api/sessions` + websocket, protocol state machine in `views/voice/session.js`, reusing the mobile `SessionSocket`/`AudioCapture`/`AudioQueue` modules; live/TTS settings stay at server defaults). A live voice session survives view switches (keep-alive) and marks its sidebar entry via view-busy. Settings remains UI-only until wiring is explicitly requested.
- The desktop app must stay lean/user-facing: do not port dev tools, tuning, or debug controls into it.
- Cache-busting: when changing desktop CSS or JS, update the `?v=` query in `static/desktop/index.html` (same convention as the mobile `static/index.html`).

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
node --test tests/js/
git diff --check
```

`tests/js/` holds `node --test` suites for DOM-less frontend modules (e.g. the desktop text view's translation runner). `static/package.json` exists only to mark all browser JS under `static/` as ES modules for Node; it declares no dependencies and there is no build step.

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

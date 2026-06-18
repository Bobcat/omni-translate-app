# Image & Camera Translation — Integration Inventory

How to replace the simulated image-translation flow with the real
`translation-services` backend (image OCR + translate + re-render). This is an
inventory and a recommended approach, not an implementation plan yet — the open
decisions at the end gate the build.

Last updated: 2026-06-16.

---

## Current state (the simulation)

The image/camera flow lives entirely in the frontend and is deliberately not
wired to a backend yet (`static/src/image/lifecycle.js`, top comment:
"Backend integration is intentionally out of scope for this phase"). The
"translation" is a single timer:

- `setSelectedImage()` sets `translatedUrl = previewUrl` (the same picture),
  then after `FAKE_TRANSLATION_DELAY_MS = 3000` flips `translatedReady = true`
  and shows the "translated" view — which is just the original.

Both entry points (`#imageFileInput`, `#cameraFileInput`) feed the same
`handleImageFileChange → setSelectedImage` path
(`static/src/app.js` event wiring).

## What already exists and is reusable

| Building block | Location | Reuse |
|---|---|---|
| UI surface (preview, busy indicator, Original/Translated toggle) | `static/index.html` image-translation-view, `renderImageTranslation()` | Only `translatedUrl` needs to become real instead of a copy |
| Two inputs | `#imageFileInput` (`image/jpeg,png,webp`), `#cameraFileInput` (`image/*` `capture="environment"`) | Both already route to `setSelectedImage` |
| Language state | `state.sideALanguage` / `state.sideBLanguage` (names, e.g. "Dutch") | Source/target for the translation |
| Name→ISO map | `_TRANSLATION_LANGUAGE_CODES` in `app/translation_bridge.py` | Dutch→`nl`, English→`en` for the API |
| `/api` router + FileResponse/proxy pattern | `app/router.py` (`get_tts_artifact`) | Template for an image-translate endpoint |
| Config URL pattern | `asr_pool.base_url`, `tts_pool.base_url` in `config/settings.json` (+ `local.json` override to `dc2:…`) | Same for the translation-services URL |

## The real API (translation-services, dc1:8030)

- `POST /v1/requests` — multipart: `request_json={task:"translate_image",
  source_lang_code, target_lang_code}` + `image_file`. → `request_id`,
  `state:"queued"`. **`source_lang_code` is required.**
- `GET /v1/requests/{id}` — poll until `state:"completed"` (or `failed`).
- `GET /v1/requests/{id}/artifacts/rendered.png` — the translated image.
- Formats: jpeg/png/webp (webp works since the stb_image transcode fix on the
  service side).

## Recommended integration

**Proxy through the app backend, not directly from the browser** — avoids CORS
and does not expose dc1 to the client. The browser talks same-origin to
`/api/...`; the app backend talks to translation-services.

Two variants:

- **A — synchronous proxy (smallest first step):** a new
  `POST /api/image-translation` takes the file + source/target language, submits
  to translation-services, polls server-side until done, fetches `rendered.png`
  and streams it back. The frontend replaces the fake timer in
  `setSelectedImage` with this call and sets `translatedUrl` to the result. Maps
  1:1 onto the existing busy→translated UX.
- **B — async job + poll (more scalable):** the backend returns a `job_id`
  immediately; the frontend polls `/api/image-translation/{job_id}`. Better for
  slow OCR / camera shots and a real progress indicator, but more moving parts.
  Mirrors translation-services' own job model.

Recommendation: **A** for the first working version; **B** later if latency or
robustness demands it.

## Concrete change points (implementation phase)

1. `config/settings.json` + `local.json`: `image_translation.base_url`
   (dc1:8030 via tunnel) + a timeout.
2. **New** `app/image_translation_bridge.py`: httpx client (submit / poll /
   fetch), reusing the name→ISO map.
3. `app/router.py`: the `/api/image-translation` endpoint.
4. `static/src/api-client.js`: `api.translateImage(file, {source, target})`.
5. `static/src/image/lifecycle.js`: replace the fake timer (the `setTimeout`
   block in `setSelectedImage`) with the real call plus an error path.

## Open decisions (gate the build)

1. **Language direction.** The source is the language *in* the image. Is that
   `sideB → sideA` (foreign menu → your language), a fixed choice, or a separate
   selector in the image view?
2. **Sync (A) or async (B)** for the first version?
3. **Reachability.** This webapp runs on dc2, translation-services on dc1 — is
   there already a tunnel/host the app backend can use to reach dc1:8030, or does
   that still need to be set up?

## Risks / watch-outs

- **Camera format:** `cameraFileInput` is `image/*` → iOS may hand back **HEIC**,
  which translation-services does not decode. Either narrow to `image/jpeg`
  (capture usually yields JPEG) or transcode client-side to JPEG/PNG.
- **File size:** camera photos are several MB → set an upload limit / timeout in
  the proxy.
- **Latency:** real OCR+VLM+render takes seconds up to ~tens of seconds (not a
  fixed 3s); the busy indicator must tolerate that, and variant A needs a
  generous server-side timeout.
- **Failure path:** there is no failure UX today; a real call must surface
  `failed`/timeout cleanly instead of an endless "busy".

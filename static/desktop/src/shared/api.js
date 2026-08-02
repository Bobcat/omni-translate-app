// Backend API for the desktop workflows. Thin fetch wrappers; errors surface the
// server's `detail` message so views can show it as-is.

import { authHeaders } from './auth-headers.js';

export { setAuthTokenProvider } from './auth-headers.js';

const MAX_ERROR_DETAIL_LENGTH = 240;

async function ensureOk(response) {
  if (response.ok) return;
  const detail = await errorDetail(response);
  throw new Error(detail || `HTTP ${response.status}`);
}

async function errorDetail(response) {
  const text = await response.text();
  if (!text) return '';
  try {
    const payload = JSON.parse(text);
    const detail = payload?.detail;
    if (typeof detail === 'string') return detail.slice(0, MAX_ERROR_DETAIL_LENGTH);
    if (typeof detail?.message === 'string') return detail.message.slice(0, MAX_ERROR_DETAIL_LENGTH);
  } catch {
    return text.slice(0, MAX_ERROR_DETAIL_LENGTH);
  }
  return '';
}

export async function getConfig() {
  const response = await fetch('/api/config', { headers: authHeaders({ Accept: 'application/json' }) });
  await ensureOk(response);
  return response.json();
}

export async function getMe() {
  const response = await fetch('/api/me', { headers: authHeaders({ Accept: 'application/json' }) });
  await ensureOk(response);
  return response.json();
}

// Voice sessions only pin the language pair; live/TTS settings stay at the
// server defaults (the desktop app has no tuning UI).
export async function createVoiceSession({ sideA, sideB }) {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({
      side_a_language: String(sideA || ''),
      side_b_language: String(sideB || ''),
    }),
  });
  await ensureOk(response);
  return response.json();
}

// One-shot text translation: stateless, the client re-sends the full current
// text and guards freshness itself (runToken in the view).
export async function translateText({ source, target, text, final = false }) {
  const response = await fetch('/api/text-translation', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({
      source_language: String(source || ''),
      target_language: String(target || ''),
      text: String(text || ''),
      final: Boolean(final),
    }),
  });
  await ensureOk(response);
  return response.json();
}

export async function translateImage(file, { source, target }) {
  const form = new FormData();
  form.append('image', file);
  form.append('source_language', String(source || 'auto'));
  form.append('target_language', String(target || ''));
  const response = await fetch('/api/image-translation', { method: 'POST', body: form, headers: authHeaders() });
  return imagePayload(response);
}

export async function retranslateImage(requestId, { target }) {
  const form = new FormData();
  form.append('target_language', String(target || ''));
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/image-translation/${safeId}/retranslate`, { method: 'POST', body: form, headers: authHeaders() });
  return imagePayload(response);
}

async function imagePayload(response) {
  await ensureOk(response);
  const requestId = response.headers.get('X-Image-Translation-Request-Id') || '';
  if (!requestId) throw new Error('image translation request id missing');
  return { blob: await response.blob(), requestId };
}

export async function submitPdf(file, { target }) {
  const form = new FormData();
  form.append('document_file', file);
  form.append('target_language', String(target || ''));
  const response = await fetch('/api/pdf-translation/requests', { method: 'POST', body: form, headers: authHeaders() });
  await ensureOk(response);
  return response.json();
}

export async function getPdfRequest(requestId) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/pdf-translation/requests/${safeId}`, {
    headers: authHeaders({ Accept: 'application/json' }),
  });
  await ensureOk(response);
  return response.json();
}

export async function cancelPdf(requestId) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/pdf-translation/requests/${safeId}/cancel`, {
    method: 'POST',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  await ensureOk(response);
  return response.json();
}

export function pdfArtifactUrl(requestId, artifactName) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const safeName = encodeURIComponent(String(artifactName || ''));
  return `/api/pdf-translation/requests/${safeId}/artifacts/${safeName}`;
}

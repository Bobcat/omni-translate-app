// Backend API for the desktop workflows. Thin fetch wrappers; errors surface the
// server's `detail` message so views can show it as-is.

import { authHeaders } from './auth-headers.js';

export { setAuthTokenProvider } from './auth-headers.js';

const MAX_ERROR_DETAIL_LENGTH = 240;

async function ensureOk(response) {
  if (response.ok) return;
  const detail = await errorDetail(response);
  const error = new Error(detail || `HTTP ${response.status}`);
  error.status = response.status;
  throw error;
}

async function errorDetail(response) {
  const text = await response.text();
  if (!text) return '';
  try {
    const payload = JSON.parse(text);
    const detail = payload?.detail;
    if (typeof detail === 'string') return detail.slice(0, MAX_ERROR_DETAIL_LENGTH);
    if (typeof detail?.message === 'string') return detail.message.slice(0, MAX_ERROR_DETAIL_LENGTH);
    // Control-layer errors (entitlements, quota) carry { error: {...} }.
    const controlError = payload?.error;
    if (typeof controlError?.message === 'string') return controlError.message.slice(0, MAX_ERROR_DETAIL_LENGTH);
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

export async function getUsage() {
  const response = await fetch('/api/usage', { headers: authHeaders({ Accept: 'application/json' }) });
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

async function submitPdfOnce(file, { target, headers }) {
  const form = new FormData();
  form.append('document_file', file);
  form.append('target_language', String(target || ''));
  return fetch('/api/pdf-translation/requests', {
    method: 'POST',
    body: form,
    headers,
  });
}

export async function submitPdf(file, { target, operationId }) {
  if (!operationId) throw new Error('PDF operation id missing');
  // One operation belongs to the account that started it. Pin its bearer
  // header so an account switch cannot move a retry or status lookup.
  const headers = authHeaders({ 'Idempotency-Key': String(operationId) });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await submitPdfOnce(file, { target, headers });
    } catch (err) {
      // The request may have reached the app before the connection failed. One
      // replay with the same operation id is safe across quota and GPU work.
      if (attempt === 0) continue;
      return getPdfRequestWithHeaders(operationId, headers);
    }
    if (response.status === 408 || response.status >= 500) {
      if (attempt === 0) continue;
      return getPdfRequestWithHeaders(operationId, headers);
    }
    await ensureOk(response);
    return response.json();
  }
  throw new Error('PDF submit retry failed');
}

async function getPdfRequestWithHeaders(requestId, headers) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/pdf-translation/requests/${safeId}`, {
    headers: { Accept: 'application/json', ...headers },
  });
  await ensureOk(response);
  return response.json();
}

export async function getPdfRequest(requestId) {
  return getPdfRequestWithHeaders(requestId, authHeaders());
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

export async function getPdfArtifact(requestId, artifactName) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const safeName = encodeURIComponent(String(artifactName || ''));
  const response = await fetch(`/api/pdf-translation/requests/${safeId}/artifacts/${safeName}`, {
    headers: authHeaders(),
  });
  await ensureOk(response);
  return response.blob();
}

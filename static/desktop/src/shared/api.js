// Backend API for the desktop workflows. Thin fetch wrappers; errors surface the
// server's `detail` message so views can show it as-is.

import { authHeaders } from './auth-headers.js';

export { setAuthTokenProvider } from './auth-headers.js';

const MAX_ERROR_DETAIL_LENGTH = 240;

async function ensureOk(response) {
  if (response.ok) return;
  const detail = await errorDetail(response);
  const error = new Error(detail.message || `HTTP ${response.status}`);
  error.status = response.status;
  error.code = detail.code || '';
  error.details = detail.details || {};
  throw error;
}

async function errorDetail(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    const payload = JSON.parse(text);
    const detail = payload?.detail;
    if (typeof detail === 'string') return { message: detail.slice(0, MAX_ERROR_DETAIL_LENGTH) };
    if (typeof detail?.message === 'string') {
      return {
        message: detail.message.slice(0, MAX_ERROR_DETAIL_LENGTH),
        code: String(detail.code || ''),
        details: detail.details && typeof detail.details === 'object' ? detail.details : {},
      };
    }
    // Control-layer errors (entitlements, quota) carry { error: {...} }.
    const controlError = payload?.error;
    if (typeof controlError?.message === 'string') {
      return {
        message: controlError.message.slice(0, MAX_ERROR_DETAIL_LENGTH),
        code: String(controlError.code || ''),
        details: controlError.details && typeof controlError.details === 'object'
          ? controlError.details
          : {},
      };
    }
  } catch {
    return { message: text.slice(0, MAX_ERROR_DETAIL_LENGTH) };
  }
  return {};
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

export async function getCredits() {
  const response = await fetch('/api/credits', {
    headers: authHeaders({ Accept: 'application/json' }),
  });
  await ensureOk(response);
  return response.json();
}

// Voice sessions pin the language pair and the voice view's product choices.
// Other live/TTS settings stay at server defaults.
export async function createVoiceSession({
  sideA,
  sideB,
  autoSpeak = true,
  voiceMode = null,
}) {
  const selectedVoice = String(voiceMode || '').trim();
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({
      side_a_language: String(sideA || ''),
      side_b_language: String(sideB || ''),
      tts_settings: { auto_speak: Boolean(autoSpeak) },
      ...(selectedVoice ? { voice_mode: selectedVoice } : {}),
    }),
  });
  await ensureOk(response);
  return response.json();
}

// One-shot text translation: stateless, the client re-sends the full current
// text and guards freshness itself (runToken in the view).
export async function translateText({ source, target, text }) {
  const response = await fetch('/api/text-translation', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({
      source_language: String(source || ''),
      target_language: String(target || ''),
      text: String(text || ''),
    }),
  });
  await ensureOk(response);
  return response.json();
}

export async function translateImage(file, { source, target, operationId }) {
  if (!operationId) throw new Error('Image operation id missing');
  const form = new FormData();
  form.append('image', file);
  form.append('source_language', String(source || 'auto'));
  form.append('target_language', String(target || ''));
  const response = await submitImageOperation('/api/image-translation', form, operationId);
  return imagePayload(response);
}

export async function retranslateImage(requestId, { target, operationId }) {
  if (!operationId) throw new Error('Image operation id missing');
  const form = new FormData();
  form.append('target_language', String(target || ''));
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await submitImageOperation(
    `/api/image-translation/${safeId}/retranslate`,
    form,
    operationId,
  );
  return imagePayload(response);
}

export async function getImageRequest(operationId) {
  const safeId = encodeURIComponent(String(operationId || ''));
  const response = await fetch(`/api/image-translation/requests/${safeId}`, {
    headers: authHeaders({ Accept: 'application/json' }),
  });
  await ensureOk(response);
  return response.json();
}

export async function getImageArtifact(operationId) {
  const safeId = encodeURIComponent(String(operationId || ''));
  const response = await fetch(`/api/image-translation/requests/${safeId}/artifact`, {
    headers: authHeaders(),
  });
  await ensureOk(response);
  return response.blob();
}

export async function cancelImage(operationId) {
  const safeId = encodeURIComponent(String(operationId || ''));
  const response = await fetch(`/api/image-translation/requests/${safeId}/cancel`, {
    method: 'POST',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  await ensureOk(response);
  return response.json();
}

async function imagePayload(response) {
  await ensureOk(response);
  const requestId = response.headers.get('X-Image-Translation-Request-Id') || '';
  if (!requestId) throw new Error('image translation request id missing');
  return { blob: await response.blob(), requestId };
}

async function submitImageOperation(url, form, operationId) {
  const headers = authHeaders({ 'Idempotency-Key': String(operationId) });
  await ensureAnonymousPrincipal(headers);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', body: form, headers });
      if (attempt === 0 && (response.status === 408 || response.status >= 500)) continue;
      return response;
    } catch (err) {
      if (attempt === 0) continue;
      throw err;
    }
  }
  throw new Error('Image submit retry failed');
}

let anonymousPrincipalReady = null;

async function ensureAnonymousPrincipal(headers) {
  if (headers.Authorization) return;
  if (!anonymousPrincipalReady) {
    anonymousPrincipalReady = fetch('/api/me', {
      headers: { ...headers, Accept: 'application/json' },
    }).then(async (response) => {
      await ensureOk(response);
    }).catch((err) => {
      anonymousPrincipalReady = null;
      throw err;
    });
  }
  await anonymousPrincipalReady;
}

async function preparePdfOnce(file, headers) {
  const form = new FormData();
  form.append('document_file', file);
  return fetch('/api/pdf-translation/requests', {
    method: 'POST',
    body: form,
    headers,
  });
}

export async function preparePdf(file, { operationId }) {
  if (!operationId) throw new Error('PDF operation id missing');
  // One operation belongs to the account that started it. Pin its bearer
  // header so an account switch cannot move a retry or status lookup.
  const headers = authHeaders({ 'Idempotency-Key': String(operationId) });
  await ensureAnonymousPrincipal(headers);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await preparePdfOnce(file, headers);
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
  throw new Error('PDF preparation retry failed');
}

export async function quotePdf(requestId, { target }) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/pdf-translation/requests/${safeId}/quote`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ target_language: String(target || '') }),
  });
  await ensureOk(response);
  return response.json();
}

export async function confirmPdf(requestId, { quoteId, target }) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/pdf-translation/requests/${safeId}/confirm`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({
      quote_id: String(quoteId || ''),
      target_language: String(target || ''),
    }),
  });
  await ensureOk(response);
  return response.json();
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

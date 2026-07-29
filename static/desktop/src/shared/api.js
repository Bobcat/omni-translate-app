// Backend API for the desktop workflows. Thin fetch wrappers; errors surface the
// server's `detail` message so views can show it as-is.

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

export async function translateImage(file, { source, target }) {
  const form = new FormData();
  form.append('image', file);
  form.append('source_language', String(source || 'auto'));
  form.append('target_language', String(target || ''));
  const response = await fetch('/api/image-translation', { method: 'POST', body: form });
  return imagePayload(response);
}

export async function retranslateImage(requestId, { target }) {
  const form = new FormData();
  form.append('target_language', String(target || ''));
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/image-translation/${safeId}/retranslate`, { method: 'POST', body: form });
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
  const response = await fetch('/api/pdf-translation/requests', { method: 'POST', body: form });
  await ensureOk(response);
  return response.json();
}

export async function getPdfRequest(requestId) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/pdf-translation/requests/${safeId}`, {
    headers: { Accept: 'application/json' },
  });
  await ensureOk(response);
  return response.json();
}

export async function cancelPdf(requestId) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const response = await fetch(`/api/pdf-translation/requests/${safeId}/cancel`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  await ensureOk(response);
  return response.json();
}

export function pdfArtifactUrl(requestId, artifactName) {
  const safeId = encodeURIComponent(String(requestId || ''));
  const safeName = encodeURIComponent(String(artifactName || ''));
  return `/api/pdf-translation/requests/${safeId}/artifacts/${safeName}`;
}

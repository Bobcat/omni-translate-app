import { authHeaders } from './shared/auth-headers.js';

export { setAuthTokenProvider } from './shared/auth-headers.js';

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: authHeaders({
      Accept: 'application/json',
      ...options.headers,
    }),
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return response.json();
}

export const api = {
  getConfig() {
    return fetchJson('/api/config');
  },

  getMe() {
    return fetchJson('/api/me');
  },

  getEntitlements() {
    return fetchJson('/api/entitlements');
  },

  async translateImage(file, { source, target, operationId, renderOptions = {} }) {
    if (!operationId) throw new Error('Image operation id missing');
    const form = new FormData();
    form.append('image', file);
    form.append('source_language', String(source || ''));
    form.append('target_language', String(target || ''));
    for (const [key, value] of Object.entries(renderOptions)) {
      if (value) form.append(key, String(value));
    }
    const response = await submitImageOperation('/api/image-translation', form, operationId);
    return imageTranslationPayload(response);
  },

  async retranslateImage(requestId, { target, operationId }) {
    if (!operationId) throw new Error('Image operation id missing');
    const form = new FormData();
    form.append('target_language', String(target || ''));
    const safeRequestId = encodeURIComponent(String(requestId || ''));
    const response = await submitImageOperation(
      `/api/image-translation/${safeRequestId}/retranslate`,
      form,
      operationId,
    );
    return imageTranslationPayload(response);
  },

  getImageRequest(operationId) {
    const safeId = encodeURIComponent(String(operationId || ''));
    return fetchJson(`/api/image-translation/requests/${safeId}`);
  },

  async getImageArtifact(operationId) {
    const safeId = encodeURIComponent(String(operationId || ''));
    const response = await fetch(`/api/image-translation/requests/${safeId}/artifact`, {
      headers: authHeaders(),
    });
    if (!response.ok) throw await responseError(response);
    return response.blob();
  },

  cancelImage(operationId) {
    const safeId = encodeURIComponent(String(operationId || ''));
    return fetchJson(`/api/image-translation/requests/${safeId}/cancel`, { method: 'POST' });
  },

  // Re-render a prior image request with new render flags — reuses the cached translations,
  // no new translation. `renderOptions` keys are the render_*/erase_*/size_*/width_* flags;
  // empty values are dropped so the service keeps the source run's value.
  async rerenderImage(requestId, renderOptions = {}, operationId = '') {
    if (!operationId) throw new Error('Image operation id missing');
    const form = new FormData();
    for (const [key, value] of Object.entries(renderOptions)) {
      if (value) form.append(key, String(value));
    }
    const safeRequestId = encodeURIComponent(String(requestId || ''));
    const response = await submitImageOperation(
      `/api/image-translation/${safeRequestId}/rerender`,
      form,
      operationId,
    );
    return imageTranslationPayload(response);
  },

  createSession({ sideALanguage, sideBLanguage, liveSettings, ttsSettings, voiceMode }) {
    return fetchJson('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        side_a_language: sideALanguage,
        side_b_language: sideBLanguage,
        live_settings: liveSettings || undefined,
        tts_settings: ttsSettings || undefined,
        voice_mode: voiceMode || undefined,
      }),
    });
  },

  generateStableVoiceSample({ language, gender, engine }) {
    return fetchJson('/api/voice-library/stable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: String(language || ''),
        gender: String(gender || ''),
        engine: String(engine || ''),
      }),
    });
  },

  keepPendingStableVoiceSample({ language, gender }) {
    const tag = encodeURIComponent(String(language || ''));
    const genderKey = encodeURIComponent(String(gender || ''));
    return fetchJson(`/api/voice-library/stable/${tag}/${genderKey}/keep-pending`, {
      method: 'POST',
    });
  },

  discardPendingStableVoiceSample({ language, gender }) {
    const tag = encodeURIComponent(String(language || ''));
    const genderKey = encodeURIComponent(String(gender || ''));
    return fetchJson(`/api/voice-library/stable/${tag}/${genderKey}/discard-pending`, {
      method: 'POST',
    });
  },

  async getSessionPcExport(sessionId) {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript.pc`, {
      headers: authHeaders({ Accept: 'text/plain' }),
    });
    if (!response.ok) {
      throw new Error(await response.text() || `HTTP ${response.status}`);
    }
    return {
      blob: await response.blob(),
      filename: filenameFromContentDisposition(response.headers.get('content-disposition')) || `${sessionId}.pc`,
    };
  },
};

async function submitImageOperation(url, form, operationId) {
  const headers = authHeaders({ 'Idempotency-Key': String(operationId) });
  await ensureAnonymousImagePrincipal(headers);
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

let anonymousImagePrincipalReady = null;

async function ensureAnonymousImagePrincipal(headers) {
  if (headers.Authorization) return;
  if (!anonymousImagePrincipalReady) {
    anonymousImagePrincipalReady = fetch('/api/me', {
      headers: { ...headers, Accept: 'application/json' },
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(await errorDetailFromResponse(response) || `HTTP ${response.status}`);
      }
    }).catch((err) => {
      anonymousImagePrincipalReady = null;
      throw err;
    });
  }
  await anonymousImagePrincipalReady;
}

async function imageTranslationPayload(response) {
  if (!response.ok) {
    throw await responseError(response);
  }
  const requestId = response.headers.get('X-Image-Translation-Request-Id') || '';
  if (!requestId) throw new Error('image translation request id missing');
  return {
    blob: await response.blob(),
    requestId,
  };
}

async function responseError(response) {
  const detail = await errorDetailFromResponse(response);
  const error = new Error(detail || `HTTP ${response.status}`);
  error.status = response.status;
  return error;
}

const MAX_ERROR_DETAIL_LENGTH = 240;

async function errorDetailFromResponse(response) {
  const text = await response.text();
  if (!text) return '';
  const known = knownErrorMessage(text);
  if (known) return known;
  if (looksLikeHtmlError(text)) return `Server returned an error page (HTTP ${response.status}).`;
  try {
    const payload = JSON.parse(text);
    const detail = errorDetailFromPayload(payload);
    return boundedErrorDetail(knownErrorMessage(detail) || detail);
  } catch {
    return boundedErrorDetail(text);
  }
}

function errorDetailFromPayload(payload) {
  const detail = payload?.detail || payload?.error || payload;
  if (typeof detail === 'string') return detail;
  if (typeof detail?.message === 'string') return detail.message;
  if (typeof detail?.code === 'string') return detail.code;
  try {
    return JSON.stringify(detail || payload);
  } catch {
    return '';
  }
}

function knownErrorMessage(detail) {
  const text = String(detail || '');
  if (text.includes('model_loading')) return 'Translation model is still loading. Try again in a moment.';
  if (text.includes('model_not_loaded')) return 'Translation model is not loaded.';
  return '';
}

function looksLikeHtmlError(text) {
  const sample = String(text || '').trim().slice(0, 300).toLowerCase();
  return sample.startsWith('<!doctype') || sample.startsWith('<html') || sample.includes('<script');
}

function boundedErrorDetail(detail) {
  const text = String(detail || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_ERROR_DETAIL_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_DETAIL_LENGTH - 1)}…`;
}

function filenameFromContentDisposition(value) {
  const match = String(value || '').match(/filename="?([^"]+)"?/i);
  return match ? match[1] : '';
}

export class SessionSocket {
  constructor(url, onMessage, onClose) {
    this.url = url;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        this.onMessage(JSON.parse(event.data));
      });
      ws.addEventListener('error', () => reject(new Error('WebSocket error')));
      ws.addEventListener('close', () => {
        this.onClose?.();
      });
    });
  }

  startListening() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'start_listening' }));
    return true;
  }

  finishListening() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'pause_listening' }));
    return true;
  }

  speakNow() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'speak_now' }));
    return true;
  }

  speakPart(partId) {
    if (!this.isOpen()) return false;
    const id = String(partId || '').trim();
    if (!id) return false;
    this.ws.send(JSON.stringify({ type: 'speak_part', part_id: id }));
    return true;
  }

  translateNow() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'translate_now' }));
    return true;
  }

  discardInflight() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'discard_inflight' }));
    return true;
  }

  updateLiveSettings(settings) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'update_live_settings', settings: settings || {} }));
    return true;
  }

  updateTtsSettings(settings) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'update_tts_settings', settings: settings || {} }));
    return true;
  }

  updateVoiceMode(mode) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'update_voice_mode', mode: String(mode || '') }));
    return true;
  }

  nextTurn(laneId) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'next_turn', lane_id: laneId }));
    return true;
  }

  replayTts({ laneId, partId }) {
    if (!this.isOpen()) return false;
    const id = String(partId || '').trim();
    if (!id) return false;
    this.ws.send(JSON.stringify({
      type: 'replay_tts',
      lane_id: laneId,
      part_id: id,
    }));
    return true;
  }

  stopTts({ laneId, turnId, artifactId }) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({
      type: 'stop_tts',
      lane_id: String(laneId || ''),
      turn_id: String(turnId || ''),
      artifact_id: String(artifactId || ''),
    }));
    return true;
  }

  ttsPlaybackComplete({ laneId, turnId, artifactId }) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({
      type: 'tts_playback_complete',
      lane_id: laneId,
      turn_id: turnId,
      artifact_id: artifactId,
    }));
    return true;
  }

  sendAudio(buffer) {
    if (!this.isOpen()) return false;
    this.ws.send(buffer);
    return true;
  }

  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    if (!this.ws) return;
    try {
      this.ws.close(1000, 'client_close');
    } catch {}
    this.ws = null;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail || payload);
    } catch {
      detail = await response.text();
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json();
}

export const api = {
  getConfig() {
    return fetchJson('/api/config');
  },

  createSession({ sourceLanguage, targetLanguage }) {
    return fetchJson('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_language: sourceLanguage,
        target_language: targetLanguage,
      }),
    });
  },
};

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

  pauseListening() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'pause_listening' }));
    return true;
  }

  speakNow() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'speak_now' }));
    return true;
  }

  setDirection({ sourceLanguage, targetLanguage }) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({
      type: 'set_direction',
      source_language: sourceLanguage,
      target_language: targetLanguage,
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

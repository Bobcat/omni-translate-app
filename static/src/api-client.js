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

  updateTtsSettings(settings) {
    return fetchJson('/api/tts-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: settings || {} }),
    });
  },

  createSession({ sideALanguage, sideBLanguage, liveSettings }) {
    return fetchJson('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        side_a_language: sideALanguage,
        side_b_language: sideBLanguage,
        live_settings: liveSettings || undefined,
      }),
    });
  },

  async getSessionPcExport(sessionId) {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript.pc`, {
      headers: { Accept: 'text/plain' },
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

  translateNow() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'translate_now' }));
    return true;
  }

  updateLiveSettings(settings) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'update_live_settings', settings: settings || {} }));
    return true;
  }

  nextTurn(laneId) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'next_turn', lane_id: laneId }));
    return true;
  }

  clearTurn() {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type: 'clear_turn' }));
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

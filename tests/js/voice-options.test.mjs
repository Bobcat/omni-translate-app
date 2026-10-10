// Mobile voice options: the mode, the automatic-speaking choice and the
// per-lane cloning status. The rules themselves are shared with desktop, so
// these cases cover the mobile wiring: persistence, socket updates and what the
// session messages do to the local state.
import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
// The session module reaches settings/tts.js for the capability check, and that
// module reads els.js at import time.
const elementStub = () => new Proxy({
  hidden: false, textContent: '', value: '', checked: false, disabled: false,
  children: [], dataset: {}, style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, removeEventListener() {}, append() {}, replaceChildren() {},
  querySelector: () => elementStub(), querySelectorAll: () => [], closest: () => null,
}, { get: (o, k) => (k in o ? o[k] : () => undefined) });
globalThis.document = {
  querySelector: () => elementStub(),
  querySelectorAll: () => [],
  createElement: () => elementStub(),
  createDocumentFragment: () => elementStub(),
  addEventListener() {},
};
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US', languages: ['en-US'] },
  configurable: true,
  writable: true,
});
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const { state } = await import('../../static/src/state.js');
const voice = await import('../../static/src/session/voice-options.js');

/** A backend the product voice modes are available on. */
function useVoiceCapableBackend() {
  state.ttsCapabilities = { voice_selection: true };
  state.ttsSettings.backend = 'nanovllm_voxcpm';
}

/** A backend that speaks but cannot select a voice mode. */
function usePlainBackend() {
  state.ttsCapabilities = { voice_selection: true };
  state.ttsSettings.backend = 'kokoro';
}

function fakeSocket() {
  const sent = [];
  return {
    sent,
    isOpen: () => true,
    updateVoiceMode: (mode) => sent.push({ type: 'update_voice_mode', mode }),
    updateTtsSettings: (settings) => sent.push({ type: 'update_tts_settings', settings }),
  };
}

test.beforeEach(() => {
  store.clear();
  state.socket = null;
  state.ttsSettings.auto_speak = true;
  state.ttsSettings.enabled = true;
  useVoiceCapableBackend();
  voice.configureVoiceOptions({});
});

test('a backend without voice selection offers no modes and sends none', () => {
  usePlainBackend();
  assert.equal(voice.voiceModeAvailable(), false);
  voice.setVoiceMode('male');
  assert.equal(voice.voiceMode(), 'female');
  // The server rejects an explicit mode it cannot honour, so it must be omitted.
  assert.equal(voice.sessionVoiceMode(), null);
});

test('a voice-capable backend sends the chosen mode', () => {
  voice.setVoiceMode('male');
  assert.equal(voice.sessionVoiceMode(), 'male');
});

test('a stored choice is restored on a fresh load', () => {
  store.set('voice_mode', JSON.stringify({ mode: 'male' }));
  voice.configureVoiceOptions({});
  assert.equal(voice.voiceMode(), 'male');
  assert.equal(voice.sessionVoiceMode(), 'male');

  store.set('voice_mode', JSON.stringify({ mode: 'speaker_clone' }));
  voice.configureVoiceOptions({});
  assert.equal(voice.voiceMode(), 'speaker_clone');
});

test('a malformed stored choice falls back to the default', () => {
  store.set('voice_mode', JSON.stringify({ mode: 'nonsense' }));
  voice.configureVoiceOptions({});
  assert.equal(voice.voiceMode(), 'female');
});

test('enabling automatic speaking unlocks playback inside the tap', () => {
  const queue = { prepared: 0, preparePcmPlayback() { this.prepared += 1; } };
  voice.configureVoiceOptions({ audioQueue: queue });
  state.ttsSettings.auto_speak = false;

  voice.setAutoSpeak(true);
  assert.equal(queue.prepared, 1, 'enabling prepares playback');

  voice.setAutoSpeak(false);
  voice.setAutoSpeak(false);
  assert.equal(queue.prepared, 1, 'disabling and repeats do not prepare');
});

test('a session teardown keeps the stored choice for the next session', () => {
  voice.setVoiceMode('male');
  voice.applyVoiceSessionReady({ voice_mode: 'speaker_clone' });
  voice.resetVoiceOptions();

  assert.equal(voice.voiceMode(), 'male');
  assert.deepEqual(voice.voiceCloningStatus(), {});
});

test('choosing a mode persists it and tells the live session', () => {
  const socket = fakeSocket();
  state.socket = socket;

  voice.setVoiceMode('male');

  assert.equal(voice.voiceMode(), 'male');
  assert.deepEqual(socket.sent, [{ type: 'update_voice_mode', mode: 'male' }]);
  assert.deepEqual(JSON.parse(store.get('voice_mode')), { mode: 'male' });
});

test('choosing a mode before a session only stores it', () => {
  voice.setVoiceMode('male');

  assert.equal(voice.sessionVoiceMode(), 'male');
  assert.deepEqual(JSON.parse(store.get('voice_mode')), { mode: 'male' });
});

test('an unknown mode resolves to the default and never reaches the socket', () => {
  const socket = fakeSocket();
  state.socket = socket;

  voice.setVoiceMode('nonsense');

  assert.equal(voice.voiceMode(), 'female');
  assert.deepEqual(socket.sent, [{ type: 'update_voice_mode', mode: 'female' }]);
});

test('the clone keeps the last stable voice as its fallback', () => {
  voice.setVoiceMode('male');
  voice.setVoiceMode('speaker_clone');

  assert.equal(voice.voiceMode(), 'speaker_clone');
  assert.deepEqual(voice.voiceCloningStatus().a_to_b, {
    state: 'preparing',
    reason: 'insufficient_clear_speech',
    fallbackVoiceMode: 'male',
  });
  // Both lanes start preparing; only what is relevant is shown.
  assert.deepEqual(Object.keys(voice.voiceCloningStatus()), ['a_to_b', 'b_to_a']);
});

test('automatic speaking persists and reaches the live session', () => {
  const socket = fakeSocket();
  state.socket = socket;

  voice.setAutoSpeak(false);

  assert.equal(voice.autoSpeak(), false);
  // The panel sends the complete snapshot; this module only owns the boolean.
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(JSON.parse(store.get('tts_global')), { auto_speak: false });
});

test('a ready payload adopts the server mode and per-lane status', () => {
  voice.applyVoiceSessionReady({
    voice_mode: 'speaker_clone',
    voice_cloning_status: {
      a_to_b: { state: 'ready', fallback_voice_mode: 'male' },
      b_to_a: { state: 'preparing', fallback_voice_mode: 'male' },
    },
  });

  assert.equal(voice.voiceMode(), 'speaker_clone');
  assert.deepEqual(voice.voiceCloningStatus(), {
    a_to_b: { state: 'ready', reason: '', fallbackVoiceMode: 'male' },
    b_to_a: { state: 'preparing', reason: '', fallbackVoiceMode: 'male' },
  });
});

test('a cloning status event updates one lane only', () => {
  voice.applyVoiceSessionReady({ voice_mode: 'speaker_clone' });
  voice.applyVoiceCloningStatusMessage({
    lane_id: 'b_to_a',
    state: 'ready',
    reason: 'enough_speech',
    fallback_voice_mode: 'female',
  });

  assert.equal(voice.voiceCloningStatus().b_to_a.state, 'ready');
  assert.equal(voice.voiceCloningStatus().a_to_b, undefined);
});

test('a cloning status event for an unknown lane is ignored', () => {
  voice.applyVoiceSessionReady({ voice_mode: 'speaker_clone', voice_cloning_status: {} });
  voice.applyVoiceCloningStatusMessage({ lane_id: 'nope', state: 'ready' });

  assert.deepEqual(voice.voiceCloningStatus(), {});
});

test('a mode echo from the server is adopted', () => {
  voice.setVoiceMode('male');
  voice.applyVoiceModeSettingsMessage({ mode: 'speaker_clone' });

  assert.equal(voice.voiceMode(), 'speaker_clone');
});

test('the stored automatic-speaking preference is applied at configure time', () => {
  store.set('tts_global', JSON.stringify({ auto_speak: false }));
  state.ttsSettings.auto_speak = true;

  voice.configureVoiceOptions({ available: true });

  assert.equal(voice.autoSpeak(), false);
});

test.after(() => {
  delete globalThis.localStorage;
  delete globalThis.navigator;
});

// Mobile voice options: the mode, the automatic-speaking choice and the
// per-lane cloning status. The rules themselves are shared with desktop, so
// these cases cover the mobile wiring: persistence, socket updates and what the
// session messages do to the local state.
import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
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
  voice.configureVoiceOptions({ available: true });
});

test('the control stays unavailable without backend support', () => {
  voice.configureVoiceOptions({ available: false });
  assert.equal(voice.voiceModeAvailable(), false);
  voice.setVoiceMode('male');
  assert.equal(voice.voiceMode(), 'female');
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
  assert.deepEqual(socket.sent, [{ type: 'update_tts_settings', settings: { auto_speak: false } }]);
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

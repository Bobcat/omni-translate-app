import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadAutoSpeakPreference,
  loadTtsGlobalConfig,
  persistAutoSpeakPreference,
  persistTtsGlobalConfig,
} from '../../static/src/domain/storage.js';

const values = new Map();
globalThis.localStorage = {
  getItem(key) {
    return values.has(key) ? values.get(key) : null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
};

test.beforeEach(() => values.clear());

test('automatic speaking has no browser override until the user chooses', () => {
  assert.equal(loadAutoSpeakPreference(), null);
});

test('automatic-speaking preference survives reload and preserves TTS choices', () => {
  localStorage.setItem('tts_global', JSON.stringify({
    auto_speak: true,
    backend: 'kokoro',
    kokoro_voices: { English: 'af_heart' },
  }));

  persistAutoSpeakPreference(false);

  assert.equal(loadAutoSpeakPreference(), false);
  assert.deepEqual(loadTtsGlobalConfig(), {
    auto_speak: false,
    backend: 'kokoro',
    kokoro_voices: { English: 'af_heart' },
  });
});

test('mobile TTS persistence includes the automatic-speaking choice', () => {
  persistTtsGlobalConfig({
    auto_speak: true,
    backend: 'kokoro',
    kokoro: { voices: {} },
    voxcpm2: { ultimate_cloning: {} },
  });

  assert.equal(loadAutoSpeakPreference(), true);
});

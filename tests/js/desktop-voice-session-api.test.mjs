import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceSession } from '../../static/desktop/src/shared/api.js';

test('desktop voice session sends one product voice mode', async () => {
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({ session_id: 'conv_test' }),
    };
  };

  await createVoiceSession({
    sideA: 'Dutch',
    sideB: 'English',
    autoSpeak: true,
    voiceMode: 'speaker_clone',
  });

  assert.equal(request.url, '/api/sessions');
  assert.deepEqual(JSON.parse(request.options.body), {
    side_a_language: 'Dutch',
    side_b_language: 'English',
    tts_settings: { auto_speak: true },
    voice_mode: 'speaker_clone',
  });
});

test('desktop voice session omits voice mode when the backend has no selector', async () => {
  let body = null;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ session_id: 'conv_test' }),
    };
  };

  await createVoiceSession({
    sideA: 'Dutch',
    sideB: 'English',
    autoSpeak: false,
    voiceMode: null,
  });

  assert.equal('voice_mode' in body, false);
});

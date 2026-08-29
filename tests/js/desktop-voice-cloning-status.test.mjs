import assert from 'node:assert/strict';
import test from 'node:test';

import { visibleVoiceCloningStatus } from '../../static/desktop/src/views/voice/cloning-status.js';

test('voice cloning status stays hidden outside a live enabled session', () => {
  assert.equal(visibleVoiceCloningStatus({
    live: false,
    voiceMode: 'speaker_clone',
    voiceCloningStatus: { a_to_b: { state: 'preparing' } },
  }, 'a_to_b'), null);
  assert.equal(visibleVoiceCloningStatus({
    live: true,
    voiceMode: 'female',
    voiceCloningStatus: { a_to_b: { state: 'ready' } },
  }, 'a_to_b'), null);
});

test('voice cloning status explains collection for the active lane', () => {
  assert.deepEqual(visibleVoiceCloningStatus({
    live: true,
    voiceMode: 'speaker_clone',
    voiceCloningStatus: {
      a_to_b: { state: 'ready' },
      b_to_a: { state: 'preparing', fallbackVoiceMode: 'female' },
    },
  }, 'b_to_a'), {
    state: 'preparing',
    text: 'Learning speaker voice — using Female until enough speech is collected.',
  });
});

test('voice cloning status names the previous Male fallback', () => {
  assert.deepEqual(visibleVoiceCloningStatus({
    live: true,
    voiceMode: 'speaker_clone',
    voiceCloningStatus: {
      a_to_b: { state: 'preparing', fallbackVoiceMode: 'male' },
    },
  }, 'a_to_b'), {
    state: 'preparing',
    text: 'Learning speaker voice — using Male until enough speech is collected.',
  });
});

test('voice cloning status keeps ready state compact', () => {
  assert.deepEqual(visibleVoiceCloningStatus({
    live: true,
    voiceMode: 'speaker_clone',
    voiceCloningStatus: { a_to_b: { state: 'ready' } },
  }, 'a_to_b'), {
    state: 'ready',
    text: 'Speaker voice ready',
  });
});

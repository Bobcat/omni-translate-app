import assert from 'node:assert/strict';
import test from 'node:test';

import { visibleVoiceDirection } from '../../static/desktop/src/views/voice/direction.js';

test('voice setup shows the configured side A to side B direction', () => {
  assert.deepEqual(visibleVoiceDirection({
    live: false,
    sideALanguage: 'Dutch',
    sideBLanguage: 'English',
    currentTurn: {
      sourceLanguage: 'English',
      targetLanguage: 'Dutch',
    },
  }), {
    sourceLanguage: 'Dutch',
    targetLanguage: 'English',
  });
});

test('live voice direction follows the lane returned by the backend', () => {
  assert.deepEqual(visibleVoiceDirection({
    live: true,
    sideALanguage: 'Dutch',
    sideBLanguage: 'English',
    currentTurn: {
      laneId: 'b_to_a',
      sourceLanguage: 'English',
      targetLanguage: 'Dutch',
    },
  }), {
    sourceLanguage: 'English',
    targetLanguage: 'Dutch',
  });
});

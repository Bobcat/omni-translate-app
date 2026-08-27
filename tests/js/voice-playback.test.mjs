import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldStopMicrophoneAfterPlayback } from '../../static/src/shared/voice-playback.js';


test('automatic playback leaves live microphone capture running', () => {
  assert.equal(
    shouldStopMicrophoneAfterPlayback({ playbackTrigger: 'automatic' }),
    false,
  );
});


test('explicit and legacy playback retain the turn-ending microphone policy', () => {
  assert.equal(
    shouldStopMicrophoneAfterPlayback({ playbackTrigger: 'explicit' }),
    true,
  );
  assert.equal(shouldStopMicrophoneAfterPlayback({}), true);
});

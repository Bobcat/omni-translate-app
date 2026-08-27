import assert from 'node:assert/strict';
import test from 'node:test';

import { voiceSessionEndMessage } from '../../static/src/shared/voice-session-end.js';


test('shows the server message for voice session guardrails', () => {
  assert.equal(
    voiceSessionEndMessage({
      reason: 'session_duration_limit',
      message: 'Voice session stopped after 15 minutes.',
    }),
    'Voice session stopped after 15 minutes.',
  );
  assert.equal(
    voiceSessionEndMessage({ reason: 'session_storage_limit' }),
    'Voice session limit reached.',
  );
});

test('does not show a notice for a normal voice session end', () => {
  assert.equal(
    voiceSessionEndMessage({ reason: 'pause_listening', message: 'Finished.' }),
    '',
  );
});

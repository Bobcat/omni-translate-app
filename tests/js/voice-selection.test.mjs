// Shared voice-selection rules: which voice speaks, and what a lane reports
// while the speaker clone is still collecting speech. Both frontends depend on
// this, so the cases below are the behaviour contract, not a UI detail.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_VOICE_MODE,
  STABLE_VOICE_MODES,
  VOICE_MODES,
  normalizeVoiceMode,
  voiceCloningStatusFromMessage,
  voiceFallbackModeFor,
  voiceModeOrNull,
  voiceModeSelectionStatus,
} from '../../static/src/domain/voice-selection.js';

test('the product modes match the backend contract', () => {
  assert.deepEqual(VOICE_MODES, ['female', 'male', 'speaker_clone']);
  assert.deepEqual(STABLE_VOICE_MODES, ['female', 'male']);
  assert.equal(DEFAULT_VOICE_MODE, 'female');
});

test('only the product modes are recognized', () => {
  assert.equal(voiceModeOrNull('male'), 'male');
  assert.equal(voiceModeOrNull(' SPEAKER_CLONE '), 'speaker_clone');
  for (const value of [null, undefined, '', 'clone', 'Speaker', 7, {}]) {
    assert.equal(voiceModeOrNull(value), null, String(value));
  }
});

test('an unknown stored mode resolves to the default', () => {
  assert.equal(normalizeVoiceMode(undefined), 'female');
  assert.equal(normalizeVoiceMode('nonsense'), 'female');
  assert.equal(normalizeVoiceMode('male'), 'male');
});

test('a stable choice becomes the fallback voice', () => {
  assert.equal(voiceFallbackModeFor('female', 'male', 'female'), 'male');
  assert.equal(voiceFallbackModeFor('male', 'female', 'male'), 'female');
});

test('choosing the clone falls back to the voice that was speaking', () => {
  // The mode that was active until now, not the previously prepared fallback:
  // male -> female -> clone must fall back to female.
  assert.equal(voiceFallbackModeFor('male', 'speaker_clone', 'female'), 'female');
  assert.equal(voiceFallbackModeFor('female', 'speaker_clone', 'male'), 'male');
});

test('choosing the clone with no stable voice before it keeps the fallback', () => {
  assert.equal(voiceFallbackModeFor('male', 'speaker_clone', 'speaker_clone'), 'male');
  assert.equal(voiceFallbackModeFor('male', 'speaker_clone', undefined), 'male');
});

test('an unusable choice keeps the voice that was speaking', () => {
  assert.equal(voiceFallbackModeFor('female', 'nonsense', 'male'), 'male');
  // With nothing usable anywhere, the default speaks.
  assert.equal(voiceFallbackModeFor(undefined, 'speaker_clone', undefined), 'female');
  assert.equal(voiceFallbackModeFor('nonsense', 'nonsense', 'nonsense'), 'female');
  // The clone itself is never a fallback voice.
  assert.equal(voiceFallbackModeFor('speaker_clone', 'speaker_clone', 'speaker_clone'), 'female');
});

test('a freshly selected mode reports preparing only for the clone', () => {
  assert.deepEqual(voiceModeSelectionStatus('speaker_clone', 'male', 'male'), {
    state: 'preparing',
    reason: 'insufficient_clear_speech',
    fallbackVoiceMode: 'male',
  });
  assert.deepEqual(voiceModeSelectionStatus('female', 'male', 'male'), {
    state: 'off',
    reason: 'disabled',
    fallbackVoiceMode: 'female',
  });
  // Switching to the clone from female reports female, whatever was prepared.
  assert.deepEqual(voiceModeSelectionStatus('speaker_clone', 'male', 'female'), {
    state: 'preparing',
    reason: 'insufficient_clear_speech',
    fallbackVoiceMode: 'female',
  });
});

test('a status message keeps the server values and its fallback voice', () => {
  assert.deepEqual(
    voiceCloningStatusFromMessage(
      { state: 'ready', reason: 'enough_speech', fallback_voice_mode: 'male' },
      'female',
    ),
    { state: 'ready', reason: 'enough_speech', fallbackVoiceMode: 'male' },
  );
});

test('a status message without a fallback voice uses the local one', () => {
  assert.deepEqual(voiceCloningStatusFromMessage({ state: 'preparing' }, 'male'), {
    state: 'preparing',
    reason: '',
    fallbackVoiceMode: 'male',
  });
  // An unusable local fallback cannot leak into the status.
  assert.deepEqual(voiceCloningStatusFromMessage({ state: 'preparing' }, 'speaker_clone'), {
    state: 'preparing',
    reason: '',
    fallbackVoiceMode: 'female',
  });
  assert.deepEqual(voiceCloningStatusFromMessage(undefined, 'female'), {
    state: 'off',
    reason: '',
    fallbackVoiceMode: 'female',
  });
});

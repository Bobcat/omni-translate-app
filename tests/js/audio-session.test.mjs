import assert from 'node:assert/strict';
import test from 'node:test';

import {
  setVoiceAudioSessionCaptureActive,
  usesIosVoiceAudioPath,
} from '../../static/src/shared/audio-session.js';

test('voice audio session recognizes iOS and touch-capable iPadOS', () => {
  assert.equal(usesIosVoiceAudioPath({ userAgent: 'Mozilla/5.0 (iPhone)' }), true);
  assert.equal(usesIosVoiceAudioPath({
    userAgent: 'Mozilla/5.0',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  }), true);
  assert.equal(usesIosVoiceAudioPath({
    userAgent: 'Mozilla/5.0',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
  }), false);
});

test('voice audio session selects capture and playback categories when supported', () => {
  const navigatorObject = { audioSession: { type: 'auto' } };

  assert.equal(setVoiceAudioSessionCaptureActive(true, navigatorObject), true);
  assert.equal(navigatorObject.audioSession.type, 'play-and-record');
  assert.equal(setVoiceAudioSessionCaptureActive(false, navigatorObject), true);
  assert.equal(navigatorObject.audioSession.type, 'playback');
});

test('voice audio session leaves unsupported browsers unchanged', () => {
  assert.equal(setVoiceAudioSessionCaptureActive(true, {}), false);
});

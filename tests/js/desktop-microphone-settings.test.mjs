import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDesktopMicrophoneState,
  resetDesktopMicrophoneSettings,
  setDesktopMicrophoneRuntime,
  setDesktopMicrophoneSettings,
  subscribeDesktopMicrophoneState,
} from '../../static/desktop/src/shared/microphone-settings.js';

test('desktop microphone settings use the mobile defaults and normalize input', () => {
  resetDesktopMicrophoneSettings();
  assert.deepEqual(getDesktopMicrophoneState(), {
    preGain: 1.5,
    autoGainControl: true,
    autoOffSilenceSeconds: 3,
    autoOffAfterBubble: false,
    autoOffCueEnabled: true,
    captureBusy: false,
    inputLevel: 0,
    listening: false,
  });

  setDesktopMicrophoneSettings({
    preGain: 4,
    autoGainControl: 0,
    autoOffSilenceSeconds: 60,
    autoOffAfterBubble: 1,
    autoOffCueEnabled: 0,
  });
  const next = getDesktopMicrophoneState();
  assert.equal(next.preGain, 3);
  assert.equal(next.autoGainControl, false);
  assert.equal(next.autoOffSilenceSeconds, 60);
  assert.equal(next.autoOffAfterBubble, true);
  assert.equal(next.autoOffCueEnabled, false);
});

test('desktop microphone state publishes setting and runtime changes', () => {
  resetDesktopMicrophoneSettings();
  const events = [];
  const unsubscribe = subscribeDesktopMicrophoneState((event) => events.push(event));

  setDesktopMicrophoneSettings({ preGain: 1.8 });
  setDesktopMicrophoneRuntime({ inputLevel: 2, listening: true });
  unsubscribe();

  assert.deepEqual([...events[0].changed], ['preGain']);
  assert.equal(events[0].source, 'settings');
  assert.deepEqual([...events[1].changed], ['inputLevel', 'listening']);
  assert.equal(events[1].next.inputLevel, 1);
  assert.equal(events[1].source, 'runtime');
});

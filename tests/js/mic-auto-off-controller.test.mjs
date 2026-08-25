import assert from 'node:assert/strict';
import test from 'node:test';

import { createMicAutoOffController } from '../../static/src/shared/mic-auto-off-controller.js';

function createHarness() {
  const timers = new Map();
  const stopped = [];
  const timerChanges = [];
  const state = {
    active: true,
    listening: true,
    speaking: false,
    silenceSeconds: 3,
    autoOffAfterBubble: false,
  };
  let nextTimer = 1;
  const controller = createMicAutoOffController({
    getSnapshot: () => state,
    stopMicrophone: (reason) => stopped.push(reason),
    schedule: (callback, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, delayMs });
      return id;
    },
    cancel: (id) => timers.delete(id),
    onTimerChange: (id) => timerChanges.push(id),
  });
  return { controller, state, stopped, timerChanges, timers };
}

test('silence auto-off arms only for an active listening microphone', () => {
  const harness = createHarness();
  assert.equal(harness.controller.arm(), true);
  assert.equal(harness.controller.isArmed(), true);
  assert.equal(harness.timers.get(1).delayMs, 3000);

  harness.state.speaking = true;
  assert.equal(harness.controller.arm(), false);
  assert.equal(harness.controller.isArmed(), false);
  assert.equal(harness.timers.size, 0);

  harness.state.speaking = false;
  harness.state.silenceSeconds = 0;
  assert.equal(harness.controller.arm(), false);
  assert.equal(harness.timers.size, 0);

  harness.state.silenceSeconds = 3;
  harness.state.listening = false;
  assert.equal(harness.controller.arm(), false);
  harness.state.listening = true;
  harness.state.active = false;
  assert.equal(harness.controller.arm(), false);
});

test('silence timer stops the microphone and is rearmed after speech playback', () => {
  const harness = createHarness();
  harness.controller.arm();
  harness.controller.handleTurnUpdate('open_empty', 'open_speaking', 'tts_started');
  assert.equal(harness.timers.size, 0);

  harness.state.speaking = false;
  harness.controller.handleTurnUpdate('open_speaking', 'open_empty', 'tts_finished');
  assert.equal(harness.timers.get(2).delayMs, 3000);
  harness.timers.get(2).callback();
  assert.deepEqual(harness.stopped, ['silence']);
  assert.equal(harness.timerChanges.at(-1), null);
});

test('bubble auto-off accepts natural closes and excludes the duration cap', () => {
  const harness = createHarness();
  harness.state.autoOffAfterBubble = true;

  harness.controller.handleTurnUpdate('open_empty', 'open_empty', 'bubble_close:duration_cap');
  assert.deepEqual(harness.stopped, []);

  harness.controller.handleTurnUpdate('open_empty', 'open_empty', 'bubble_close:sentence_boundary');
  assert.deepEqual(harness.stopped, ['bubble_close']);
});

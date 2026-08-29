import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publishViewBusy,
  publishViewRecording,
  VIEW_BUSY_EVENT,
  VIEW_RECORDING_EVENT,
} from '../../static/desktop/src/shared/view-activity.js';

test('desktop view activity publishes separate session and recording states', () => {
  const events = [];
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  globalThis.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  try {
    publishViewBusy('voice', true);
    publishViewRecording('voice', true);
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }

  assert.deepEqual(events.map(({ type, detail }) => ({ type, detail })), [
    { type: VIEW_BUSY_EVENT, detail: { view: 'voice', busy: true } },
    { type: VIEW_RECORDING_EVENT, detail: { view: 'voice', recording: true } },
  ]);
});

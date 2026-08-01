// Regression tests for the text view's request runner (node --test).
// The bug these guard: clearing the input below the minimum during an
// in-flight request used to invalidate the runToken, which made the
// request's finally-cleanup skip entirely — inFlight stayed true and the
// view could never translate again until a page reload.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTranslationRunner } from '../../static/desktop/src/views/text/translation-runner.js';

// A runner wired to spies. `state.text` is mutable so a test can mimic the
// user typing/clearing while a request is in flight; every translate() call
// gets its own deferred entry in `requests`.
function setup({ text = 'hallo wereld' } = {}) {
  const state = { text };
  const calls = { result: [], error: [], busy: [] };
  const requests = [];
  const runner = createTranslationRunner({
    minChars: 3,
    getPayload: () => ({ source: 'Dutch', target: 'English', text: state.text }),
    translate: (payload) => new Promise((resolve, reject) => {
      requests.push({ payload, resolve, reject });
    }),
    onResult: (result) => calls.result.push(result),
    onError: (error) => calls.error.push(error),
    onBusy: (busy) => calls.busy.push(busy),
  });
  return { state, calls, requests, runner };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('clearing during an in-flight request still releases the runner', async () => {
  const { state, calls, requests, runner } = setup();

  const fired = runner.fire();
  assert.equal(runner.isInFlight(), true);

  state.text = ''; // user clears the input below the minimum
  runner.invalidate();

  requests[0].resolve({ translated_text: 'Hello world' });
  await fired;

  // Stale result is not applied, but cleanup ran unconditionally.
  assert.deepEqual(calls.result, []);
  assert.equal(runner.isInFlight(), false);
  assert.deepEqual(calls.busy, [true, false]);

  // The view can translate again: a fresh fire dispatches a new request.
  state.text = 'opnieuw typen';
  const again = runner.fire();
  assert.equal(requests.length, 2);
  requests[1].resolve({ translated_text: 'Typing again' });
  await again;
  assert.deepEqual(calls.result, [{ translated_text: 'Typing again' }]);
});

test('clear then retype during an in-flight request refires with the newest text', async () => {
  const { state, calls, requests, runner } = setup();

  const first = runner.fire();
  state.text = '';
  runner.invalidate();

  state.text = 'nieuwe tekst'; // user retypes while the request is still out
  await runner.fire(); // marks dirty, no second request yet
  assert.equal(requests.length, 1);

  requests[0].resolve({ translated_text: 'stale' });
  await first; // finally: cleanup + refire with the newest text

  assert.equal(requests.length, 2);
  assert.equal(requests[1].payload.text, 'nieuwe tekst');
  assert.deepEqual(calls.result, []); // the stale result never landed

  requests[1].resolve({ translated_text: 'New text' });
  await flushMicrotasks();
  assert.deepEqual(calls.result, [{ translated_text: 'New text' }]);
  assert.deepEqual(calls.busy, [true, false, true, false]);
});

test('a pending final flag propagates to the refire', async () => {
  const { requests, runner } = setup();

  const first = runner.fire();
  await runner.fire({ final: true }); // dirty, final requested
  requests[0].resolve({ translated_text: 'a' });
  await first;

  assert.equal(requests.length, 2);
  assert.equal(requests[1].payload.final, true);

  requests[1].resolve({ translated_text: 'b' });
  await flushMicrotasks();
});

test('an in-flight error after invalidate is swallowed but cleanup runs', async () => {
  const { state, calls, requests, runner } = setup();

  const fired = runner.fire();
  state.text = '';
  runner.invalidate();

  requests[0].reject(new Error('service down'));
  await fired;

  assert.deepEqual(calls.error, []);
  assert.equal(runner.isInFlight(), false);
  assert.deepEqual(calls.busy, [true, false]);
});

test('a current error surfaces and releases the runner', async () => {
  const { calls, requests, runner } = setup();

  const fired = runner.fire();
  requests[0].reject(new Error('service down'));
  await fired;

  assert.equal(calls.error.length, 1);
  assert.equal(runner.isInFlight(), false);
});

test('firing below the minimum never dispatches', async () => {
  const { calls, requests, runner } = setup({ text: 'hi' });

  await runner.fire();

  assert.equal(requests.length, 0);
  assert.deepEqual(calls.busy, []);
});

// The entry-version guard: an installed shell running older assets reloads
// itself once, and gives up instead of looping when a reload does not help.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VERSION_RELOAD_WINDOW_MS,
  shouldReloadForVersion,
} from '../../static/src/domain/entry-version.js';

const NOW = 1_000_000;

test('matching versions never reload', () => {
  assert.equal(shouldReloadForVersion('abc', 'abc', 0, NOW), false);
});

test('a missing server version never reloads', () => {
  for (const value of ['', '   ', undefined, null]) {
    assert.equal(shouldReloadForVersion('abc', value, 0, NOW), false, String(value));
  }
});

test('a different server version reloads once', () => {
  assert.equal(shouldReloadForVersion('abc', 'def', 0, NOW), true);
});

test('a reload inside the window is not repeated', () => {
  assert.equal(shouldReloadForVersion('abc', 'def', NOW - 1000, NOW), false);
  assert.equal(
    shouldReloadForVersion('abc', 'def', NOW - VERSION_RELOAD_WINDOW_MS + 1, NOW),
    false,
  );
});

test('a reload outside the window is allowed again', () => {
  assert.equal(
    shouldReloadForVersion('abc', 'def', NOW - VERSION_RELOAD_WINDOW_MS, NOW),
    true,
  );
});

test('an unusable stored timestamp is treated as no attempt', () => {
  for (const stored of [undefined, null, '', 'nonsense', NaN]) {
    assert.equal(shouldReloadForVersion('abc', 'def', stored, NOW), true, String(stored));
  }
});

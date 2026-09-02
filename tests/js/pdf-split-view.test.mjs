import assert from 'node:assert/strict';
import test from 'node:test';

import { pdfSplitPercent } from '../../static/desktop/src/views/pdf/split-view.js';


test('PDF split follows the pointer around the container midpoint', () => {
  assert.equal(pdfSplitPercent(600, 100, 1000), 50);
  assert.equal(pdfSplitPercent(700, 100, 1000), 60);
});

test('PDF split keeps both panes usable at either edge', () => {
  assert.equal(pdfSplitPercent(100, 100, 1000), 26.5);
  assert.equal(pdfSplitPercent(1100, 100, 1000), 73.5);
});

test('PDF split falls back to an even split before layout exists', () => {
  assert.equal(pdfSplitPercent(0, 0, 0), 50);
});

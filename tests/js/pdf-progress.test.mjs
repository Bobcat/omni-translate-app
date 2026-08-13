import assert from 'node:assert/strict';
import test from 'node:test';

import { pdfPendingText } from '../../static/desktop/src/views/pdf/progress.js';

test('queued PDF reports its place in line', () => {
  assert.equal(pdfPendingText({ state: 'queued', queue_position: 3 }), 'In queue — position 3');
  assert.equal(pdfPendingText({ state: 'queued' }), 'In queue…');
});

test('running PDF reports the page currently being translated', () => {
  assert.equal(
    pdfPendingText({ state: 'running', stage: 'page 3/15', pages_done: 2, pages_total: 15 }),
    'Translating… page 3 of 15',
  );
});

test('PDF rerender reports rendering instead of translating', () => {
  assert.equal(
    pdfPendingText({
      task: 'rerender_pdf',
      state: 'running',
      stage: 'page 3/15',
      pages_done: 2,
      pages_total: 15,
    }),
    'Rendering… page 3 of 15',
  );
  assert.equal(
    pdfPendingText({ task: 'rerender_pdf', state: 'running' }),
    'Rendering…',
  );
});


test('assemble stage replaces the completed-page translation label', () => {
  assert.equal(
    pdfPendingText({ state: 'running', stage: 'assemble', pages_done: 15, pages_total: 15 }),
    'Assembling 15 pages…',
  );
  assert.equal(
    pdfPendingText({ state: 'running', stage: 'assemble', pages_done: 1, pages_total: 1 }),
    'Assembling 1 page…',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  creditActivityAction,
  creditActivityState,
  defaultUsageDateRange,
  normalizeCreditActivity,
  usageDateBounds,
} from '../../static/desktop/src/views/usage/index.js';
import { getCreditActivity } from '../../static/desktop/src/views/usage/api.js';

test('credit activity accepts only public lifecycle states and safe values', () => {
  assert.deepEqual(
    normalizeCreditActivity({
      activity: [
        {
          action: 'pdf_translation',
          credits: 100,
          state: 'consumed',
          occurred_at: '2026-09-02T12:00:00+00:00',
        },
        { action: 'pdf_translation', credits: 80, state: 'released', occurred_at: '' },
        { action: 'pdf_translation', credits: -1, state: 'reserved', occurred_at: '' },
        { action: 'pdf_translation', credits: 20, state: 'adjusted', occurred_at: '' },
      ],
    }),
    [
      {
        action: 'pdf_translation',
        credits: 100,
        state: 'consumed',
        occurredAt: '2026-09-02T12:00:00+00:00',
      },
      { action: 'pdf_translation', credits: 80, state: 'released', occurredAt: '' },
    ],
  );
});

test('credit activity uses user-facing action and lifecycle labels', () => {
  assert.equal(creditActivityAction('pdf_translation'), 'PDF translation');
  assert.equal(creditActivityAction('internal_action'), 'Work');
  assert.equal(creditActivityState('reserved'), 'Reserved');
  assert.equal(creditActivityState('consumed'), 'Used');
  assert.equal(creditActivityState('released'), 'Returned');
});

test('usage date range defaults to three inclusive local calendar days', () => {
  assert.deepEqual(
    defaultUsageDateRange(new Date(2026, 8, 2, 15, 30)),
    { from: '2026-08-31', to: '2026-09-02' },
  );

  assert.deepEqual(
    usageDateBounds({ from: '2026-08-31', to: '2026-09-02' }),
    {
      fromAt: new Date(2026, 7, 31).toISOString(),
      toBefore: new Date(2026, 8, 3).toISOString(),
    },
  );
});

test('credit activity request sends the selected server-side date bounds', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => ({ activity: [] }) };
  };

  try {
    await getCreditActivity({
      fromAt: '2026-08-31T22:00:00.000Z',
      toBefore: '2026-09-02T22:00:00.000Z',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const url = new URL(requestedUrl, 'https://example.test');
  assert.equal(url.pathname, '/api/credits/activity');
  assert.equal(url.searchParams.get('from_at'), '2026-08-31T22:00:00.000Z');
  assert.equal(url.searchParams.get('to_before'), '2026-09-02T22:00:00.000Z');
});

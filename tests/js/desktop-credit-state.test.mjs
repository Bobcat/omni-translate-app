import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureDesktopCredits,
  getDesktopCreditState,
  refreshDesktopCredits,
  setDesktopCreditOwner,
  subscribeDesktopCreditState,
} from '../../static/desktop/src/shared/credit-state.js';

test('desktop credit state waits for configuration, is shared, and coalesces refreshes', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let completeRequest;
  globalThis.fetch = () => {
    requests += 1;
    return new Promise((resolve) => {
      completeRequest = () => resolve({
        ok: true,
        json: async () => ({
          credits: {
            plan: 'free',
            available: 2350,
            grant: 3000,
            period: 'month',
            period_end: '2026-10-01T00:00:00+00:00',
          },
        }),
      });
    });
  };

  try {
    const unconfigured = await refreshDesktopCredits();
    assert.equal(unconfigured.configured, false);
    assert.equal(requests, 0);

    const events = [];
    const unsubscribe = subscribeDesktopCreditState((state) => events.push(state));
    configureDesktopCredits({
      plans: [
        {
          code: 'anonymous',
          credits_per_period: 300,
          period: 'month',
          account_required: false,
          price_minor_units: 0,
          currency: 'EUR',
          billing_period: 'month',
          pdf_pages_per_job: 2,
          pdf_preview: true,
        },
        {
          code: 'free',
          credits_per_period: 3000,
          period: 'month',
          account_required: true,
          price_minor_units: 0,
          currency: 'EUR',
          billing_period: 'month',
          pdf_pages_per_job: 25,
          pdf_preview: false,
        },
      ],
    });
    const first = refreshDesktopCredits();
    const second = refreshDesktopCredits();
    assert.equal(requests, 1);
    completeRequest();
    await Promise.all([first, second]);
    unsubscribe();

    assert.deepEqual(getDesktopCreditState().credits, {
      plan: 'free',
      available: 2350,
      grant: 3000,
      period: 'month',
      period_end: '2026-10-01T00:00:00+00:00',
    });
    assert.equal(events.at(-1).loading, false);
    assert.deepEqual(getDesktopCreditState().plans, [
      {
        code: 'anonymous',
        grant: 300,
        period: 'month',
        accountRequired: false,
        priceMinorUnits: 0,
        currency: 'EUR',
        billingPeriod: 'month',
        pdfPagesPerJob: 2,
        pdfPreview: true,
      },
      {
        code: 'free',
        grant: 3000,
        period: 'month',
        accountRequired: true,
        priceMinorUnits: 0,
        currency: 'EUR',
        billingPeriod: 'month',
        pdfPagesPerJob: 25,
        pdfPreview: false,
      },
    ]);

    setDesktopCreditOwner('user:next');
    assert.equal(getDesktopCreditState().credits, null);
  } finally {
    setDesktopCreditOwner('anonymous');
    configureDesktopCredits({ plans: [] });
    globalThis.fetch = originalFetch;
  }
});

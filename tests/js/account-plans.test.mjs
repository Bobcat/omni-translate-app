import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatPlanPrice,
  planFeatures,
} from '../../static/desktop/src/views/account/plans.js';


test('plan price is money rather than the included credit grant', () => {
  assert.equal(
    formatPlanPrice({ priceMinorUnits: 0, currency: 'EUR' }),
    '€0.00',
  );
  assert.equal(
    formatPlanPrice({ priceMinorUnits: 1250, currency: 'EUR' }),
    '€12.50',
  );
});

test('included credits are the first plan feature', () => {
  assert.deepEqual(
    planFeatures({ grant: 3000, period: 'month', accountRequired: true }),
    [
      '3,000 included credits each month',
      'Use your credits on any signed-in device',
      'Exact credit use shown before work starts',
    ],
  );
});

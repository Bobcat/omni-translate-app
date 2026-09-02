import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pdfCreditProgressCopy,
  pdfCreditQuoteCopy,
  pdfCreditScopeCopy,
  pdfFreeAccountCopy,
  pdfFreeCreditAccessCopy,
  pdfGuestPreviewCopy,
} from '../../static/desktop/src/views/pdf/credit-copy.js';


const quote = {
  credits: 650,
  available: 3000,
  pages: 15,
  source_characters: 32940,
  remaining_after_confirmation: 2350,
};

test('binding PDF quote uses exact, target-specific confirmation copy', () => {
  const copy = pdfCreditQuoteCopy(quote, 'Dutch');

  assert.equal(copy.action, 'Translate');
  assert.equal(copy.affordable, true);
  assert.equal(copy.confirmTitle, 'Translate to Dutch?');
  assert.equal(copy.confirmAction, 'Translate to Dutch');
  assert.equal(copy.basis, 'Based on 15 pages and 32,940 source characters');
  assert.equal(copy.remaining, '2,350 credits will remain');
  assert.doesNotMatch(Object.values(copy).join(' '), /estimated|approximately|price locked/i);
});

test('PDF quote explains an insufficient balance before confirmation', () => {
  const copy = pdfCreditQuoteCopy({ ...quote, available: 300 }, 'Dutch');

  assert.equal(copy.affordable, false);
  assert.equal(
    copy.insufficient,
    'You have 300 credits available. You need 350 more to translate this PDF.',
  );
});

test('Guest preview and Free account copy keep scope and plan benefits separate', () => {
  const plans = [
    { code: 'anonymous', pdfPagesPerJob: 2, pdfPreview: true },
    { code: 'free', pdfPagesPerJob: 25, grant: 3000, period: 'month' },
  ];
  assert.equal(
    pdfGuestPreviewCopy(plans),
    'Guest preview includes the first 2 pages of each PDF.',
  );
  assert.equal(
    pdfFreeAccountCopy(plans),
    'Create a free account or sign in to translate PDFs up to 25 pages with 3,000 credits per month.',
  );
  assert.equal(
    pdfFreeCreditAccessCopy(plans),
    'Create a free account or sign in to get 3,000 credits per month.',
  );
});

test('cancel copy changes only after compute starts', () => {
  const reserved = pdfCreditProgressCopy(
    { state: 'queued', credit_usage: { credits: 650 }, quota: {} },
    quote,
  );
  assert.equal(reserved.cancelAction, 'Cancel translation');

  const active = pdfCreditProgressCopy(
    {
      state: 'running',
      credit_usage: { credits: 650 },
      quota: { compute_started_at_utc: '2026-09-01T10:00:00+00:00' },
    },
    quote,
  );
  assert.equal(active.cancelAction, 'Stop translation');
  assert.equal(
    active.stopCopy,
    'Processing has started, so the 650 credits cannot be returned.',
  );
});

test('read-only scope explains a plan-limited preview', () => {
  assert.equal(
    pdfCreditScopeCopy({ source_pages: 9, translated_pages: 2, preview: true }),
    'Translating the first 2 of 9 pages',
  );
});

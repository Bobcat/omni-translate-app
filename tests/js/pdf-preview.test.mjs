import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configuredPdfPreviewLimit,
  pdfPreviewFromEnvelope,
  pdfPreviewNotice,
  translatedPdfFilename,
} from '../../static/desktop/src/views/pdf/preview.js';
import {
  pdfAccountPlanFromConfig,
  pdfPreviewQuotaExhausted,
} from '../../static/desktop/src/views/pdf/quota-cta.js';

test('preview limit comes only from an enabled first-pages entitlement', () => {
  assert.equal(configuredPdfPreviewLimit({ entitlements: {
    'pdf_translation.preview_first_pages': true,
    'pdf_translation.max_pages_per_job': 2,
  } }), 2);
  assert.equal(configuredPdfPreviewLimit({ entitlements: {
    'pdf_translation.max_pages_per_job': 25,
  } }), 0);
});

test('preview metadata is accepted only for a partial document', () => {
  assert.deepEqual(pdfPreviewFromEnvelope({ pdf_preview: {
    source_pages: 12,
    translated_pages: 2,
  } }), { sourcePages: 12, translatedPages: 2 });
  assert.equal(pdfPreviewFromEnvelope({ pdf_preview: {
    source_pages: 2,
    translated_pages: 2,
  } }), null);
});

test('preview copy distinguishes plan scope from an actual partial result', () => {
  assert.equal(
    pdfPreviewNotice(2, null),
    'Preview access translates up to 2 pages from the start of a PDF.',
  );
  assert.equal(
    pdfPreviewNotice(2, { sourcePages: 12, translatedPages: 2 }),
    'Preview: first 2 of 12 pages.',
  );
});

test('partial results have an explicit preview download name', () => {
  assert.equal(
    translatedPdfFilename('report.pdf', 'English', { sourcePages: 12, translatedPages: 2 }),
    'report_preview_english.pdf',
  );
  assert.equal(translatedPdfFilename('report.pdf', 'English', null), 'report_english.pdf');
});

test('only a resolved zero balance exhausts the anonymous preview plan', () => {
  assert.equal(pdfPreviewQuotaExhausted({
    previewPageLimit: 2,
    usageResolved: true,
    remaining: 0,
  }), true);
  assert.equal(pdfPreviewQuotaExhausted({
    previewPageLimit: 2,
    usageResolved: false,
    remaining: 0,
  }), false);
  assert.equal(pdfPreviewQuotaExhausted({
    previewPageLimit: 2,
    usageResolved: true,
    remaining: null,
  }), false);
  assert.equal(pdfPreviewQuotaExhausted({
    previewPageLimit: 0,
    usageResolved: true,
    remaining: 0,
  }), false);
});

test('account plan card values come from public app config', () => {
  assert.deepEqual(pdfAccountPlanFromConfig({
    pdf_translation: {
      account_plan: {
        pages_per_period: 50,
        max_pages_per_job: 25,
      },
    },
  }), { pagesPerPeriod: 50, maxPagesPerJob: 25 });
});

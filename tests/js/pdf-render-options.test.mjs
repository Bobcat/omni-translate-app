import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PDF_RENDER_DEFAULTS,
  normalizePdfRenderOptions,
  pdfRenderApplicability,
} from '../../static/desktop/src/views/pdf/render-options.js';


test('PDF render defaults are app-owned typeset at 0.9', () => {
  assert.equal(PDF_RENDER_DEFAULTS.page_layout_mode, 'typeset');
  assert.equal(PDF_RENDER_DEFAULTS.page_scale, 0.9);
  assert.deepEqual(normalizePdfRenderOptions(), PDF_RENDER_DEFAULTS);
});


test('fit makes page scale not applicable without losing its value', () => {
  const options = normalizePdfRenderOptions({ page_layout_mode: 'fit', page_scale: 0.82 });
  assert.equal(options.page_scale, 0.82);
  assert.equal(pdfRenderApplicability(options).page_scale, true);
});


test('all-typeset result disables controls owned by the compositor', () => {
  const options = normalizePdfRenderOptions();
  const envelope = {
    response: {
      metadata: { page_layout_mode: 'typeset' },
      document: {
        pages: [
          { effective_page_layout_mode: 'typeset', page_class: 'scanned' },
          { effective_page_layout_mode: 'typeset', page_class: 'born-digital' },
        ],
      },
    },
  };

  const reasons = pdfRenderApplicability(options, envelope);
  assert.ok(reasons.width_fit_mode);
  assert.ok(reasons.size_metric_mode);
  assert.ok(reasons.size_cohort_mode);
  assert.ok(reasons.render_size_mode);
  assert.equal(reasons.erase_fill_mode, undefined);
});


test('picture fallback keeps fit controls applicable in typeset mode', () => {
  const envelope = {
    response: {
      metadata: { page_layout_mode: 'typeset' },
      document: {
        pages: [
          { effective_page_layout_mode: 'typeset', page_class: 'born-digital' },
          { effective_page_layout_mode: 'fit', page_class: 'scanned' },
        ],
      },
    },
  };

  const reasons = pdfRenderApplicability(PDF_RENDER_DEFAULTS, envelope);
  assert.equal(reasons.width_fit_mode, undefined);
  assert.equal(reasons.size_metric_mode, undefined);
});


test('born-digital vector document needs no background fill', () => {
  const envelope = {
    response: {
      metadata: { page_layout_mode: 'typeset' },
      document: {
        pages: [
          { effective_page_layout_mode: 'typeset', page_class: 'born-digital' },
        ],
      },
    },
  };

  assert.equal(
    pdfRenderApplicability(PDF_RENDER_DEFAULTS, envelope).erase_fill_mode,
    'Vector text needs no background fill.',
  );
});

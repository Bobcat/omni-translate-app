import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampPdfScale,
  pdfCanvasOutputScale,
  pdfFitPageScale,
  pdfFitWidthScale,
  pdfDestinationPageNumber,
  pdfExternalLinkUrl,
  pdfLinkBounds,
  pdfPageInViewport,
  pdfScaleFromPercentage,
} from '../../static/desktop/src/views/pdf/viewer/index.js?v=20260901-pdfjs-14';


test('PDF viewer scale stays inside its supported zoom range', () => {
  assert.equal(clampPdfScale(0.1), 0.25);
  assert.equal(clampPdfScale(2), 2);
  assert.equal(clampPdfScale(8), 4);
  assert.equal(clampPdfScale(Number.NaN), 1);
});


test('PDF fit-width scale uses the available pane width', () => {
  assert.equal(pdfFitWidthScale(648, 612, 36), 1);
  assert.equal(pdfFitWidthScale(342, 612, 36), 0.5);
  assert.equal(pdfFitWidthScale(0, 612, 36), 1);
});


test('PDF fit-page scale keeps the whole page inside the pane', () => {
  assert.equal(pdfFitPageScale(648, 828, 612, 792, 36), 1);
  assert.equal(pdfFitPageScale(648, 432, 612, 792, 36), 0.5);
  assert.equal(pdfFitPageScale(0, 432, 612, 792, 36), 1);
});


test('PDF zoom percentage accepts plain and percent-suffixed values', () => {
  assert.equal(pdfScaleFromPercentage('125'), 1.25);
  assert.equal(pdfScaleFromPercentage(' 87.5% '), 0.875);
  assert.equal(pdfScaleFromPercentage('87,5'), 0.875);
  assert.equal(pdfScaleFromPercentage('500%'), 4);
  assert.equal(pdfScaleFromPercentage('zoom'), null);
  assert.equal(pdfScaleFromPercentage('0'), null);
});


test('PDF canvas scale respects HiDPI and the canvas pixel ceiling', () => {
  assert.equal(pdfCanvasOutputScale(1000, 1000, 1), 2);
  assert.equal(pdfCanvasOutputScale(1000, 1000, 3), 3);
  assert.equal(pdfCanvasOutputScale(1000, 1000, 4), 3);
  assert.equal(pdfCanvasOutputScale(4000, 4000, 2, 4_000_000), 0.5);
});


test('PDF current page follows the page occupying most of the viewport', () => {
  const pages = [
    { pageNumber: 1, top: 0, height: 600 },
    { pageNumber: 2, top: 618, height: 600 },
    { pageNumber: 3, top: 1236, height: 600 },
  ];
  assert.equal(pdfPageInViewport(pages, 0, 500), 1);
  assert.equal(pdfPageInViewport(pages, 400, 500), 2);
  assert.equal(pdfPageInViewport(pages, 1250, 500), 3);
  assert.equal(pdfPageInViewport([], 0, 500), 1);
});


test('PDF link rectangles are normalized after viewport conversion', () => {
  const viewport = {
    convertToViewportPoint: (x, y) => x === 1 && y === 2 ? [80, 90] : [20, 30],
  };
  assert.deepEqual(pdfLinkBounds([1, 2, 3, 4], viewport), {
    left: 20,
    top: 30,
    width: 60,
    height: 60,
  });
});


test('PDF external links allow common web protocols and reject script URLs', () => {
  assert.equal(pdfExternalLinkUrl('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(pdfExternalLinkUrl('mailto:hello@example.com'), 'mailto:hello@example.com');
  assert.equal(pdfExternalLinkUrl('javascript:alert(1)'), '');
  assert.equal(pdfExternalLinkUrl('data:text/html,hello'), '');
});


test('PDF destinations resolve named, indexed, and referenced pages', async () => {
  const reference = { num: 12, gen: 0 };
  const documentProxy = {
    getDestination: async (name) => name === 'chapter' ? [reference, { name: 'Fit' }] : null,
    getPageIndex: async (value) => value === reference ? 3 : -1,
  };
  assert.equal(await pdfDestinationPageNumber(documentProxy, [1, { name: 'Fit' }]), 2);
  assert.equal(await pdfDestinationPageNumber(documentProxy, 'chapter'), 4);
  assert.equal(await pdfDestinationPageNumber(documentProxy, 'missing'), null);
});

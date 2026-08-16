function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

export function configuredPdfPreviewLimit(payload) {
  const entitlements = payload?.entitlements || {};
  if (!entitlements['pdf_translation.preview_first_pages']) return 0;
  return positiveInteger(entitlements['pdf_translation.max_pages_per_job']);
}

export function pdfPreviewFromEnvelope(envelope) {
  const sourcePages = positiveInteger(envelope?.pdf_preview?.source_pages);
  const translatedPages = positiveInteger(envelope?.pdf_preview?.translated_pages);
  if (!sourcePages || !translatedPages || translatedPages >= sourcePages) return null;
  return { sourcePages, translatedPages };
}

export function pdfPreviewNotice(limit, preview) {
  if (preview) {
    return `Preview: first ${preview.translatedPages} of ${preview.sourcePages} pages.`;
  }
  const safeLimit = positiveInteger(limit);
  if (!safeLimit) return '';
  return `Preview access translates up to ${safeLimit} pages from the start of a PDF.`;
}

export function translatedPdfFilename(sourceFileName, targetLanguage, preview) {
  const stem = String(sourceFileName || 'document').replace(/\.[^.]+$/, '') || 'document';
  const target = String(targetLanguage || '').toLowerCase() || 'translated';
  return `${stem}${preview ? '_preview' : ''}_${target}.pdf`;
}

function number(value) {
  return Number(value || 0).toLocaleString();
}

function formatCreditCount(value) {
  const count = Number(value || 0);
  return `${number(count)} ${count === 1 ? 'credit' : 'credits'}`;
}

export function pdfCreditQuoteCopy(quote, targetLanguage) {
  const creditsRequired = Number(quote?.credits || 0);
  const available = Number(quote?.available || 0);
  const credits = number(creditsRequired);
  const pages = Number(quote?.pages || 0);
  const target = String(targetLanguage || '');
  const affordable = creditsRequired <= available;
  const shortfall = Math.max(0, creditsRequired - available);
  return {
    credits,
    affordable,
    basis: `Based on ${number(pages)} ${pages === 1 ? 'page' : 'pages'} and ${number(quote?.source_characters)} source characters`,
    remaining: `${number(quote?.remaining_after_confirmation)} credits will remain`,
    insufficient: `You have ${formatCreditCount(available)} available. You need ${number(shortfall)} more to translate this PDF.`,
    action: 'Translate',
    confirmTitle: `Translate to ${target}?`,
    confirmCopy: `This translation will use ${credits} credits. ${number(quote?.remaining_after_confirmation)} credits will remain.`,
    confirmAction: `Translate to ${target}`,
  };
}

export function pdfGuestPreviewCopy(plans) {
  const guest = (plans || []).find((plan) => plan?.code === 'anonymous');
  const guestPages = Number(guest?.pdfPagesPerJob || 0);
  if (!guest?.pdfPreview || guestPages < 1) return '';
  return `Guest preview includes the first ${number(guestPages)} pages of each PDF.`;
}

export function pdfFreeAccountCopy(plans) {
  const free = (plans || []).find((plan) => plan?.code === 'free');
  const freePages = Number(free?.pdfPagesPerJob || 0);
  if (freePages < 1 || Number(free?.grant || 0) < 1) return '';
  return `Create a free account or sign in to translate PDFs up to ${number(freePages)} pages with ${formatCreditCount(free?.grant)} per ${String(free?.period || 'period')}.`;
}

export function pdfFreeCreditAccessCopy(plans) {
  const free = (plans || []).find((plan) => plan?.code === 'free');
  if (Number(free?.grant || 0) < 1) return '';
  return `Create a free account or sign in to get ${formatCreditCount(free.grant)} per ${String(free.period || 'period')}.`;
}

export function pdfCreditProgressCopy(envelope, quote) {
  const credits = number(envelope?.credit_usage?.credits || quote?.credits);
  const computeStarted = Boolean(envelope?.quota?.compute_started_at_utc);
  return {
    computeStarted,
    cancelAction: computeStarted ? 'Stop translation' : 'Cancel translation',
    stopCopy: `Processing has started, so the ${credits} credits cannot be returned.`,
  };
}

export function pdfCreditScopeCopy(scope) {
  const sourcePages = Number(scope?.source_pages || 0);
  const translatedPages = Number(scope?.translated_pages || 0);
  if (!translatedPages) return '';
  if (scope?.preview && sourcePages > translatedPages) {
    return `Translating the first ${number(translatedPages)} of ${number(sourcePages)} pages`;
  }
  return `${number(translatedPages)} ${translatedPages === 1 ? 'page' : 'pages'}`;
}

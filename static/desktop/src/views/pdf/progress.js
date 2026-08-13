function pageTotals(envelope) {
  return {
    done: envelope?.pages_done ?? envelope?.response?.document?.pages_done,
    total: envelope?.pages_total
      ?? envelope?.response?.document?.pages_total
      ?? envelope?.page_count,
  };
}

export function pdfPendingText(envelope) {
  if (String(envelope?.state || '').toLowerCase() === 'queued') {
    const position = envelope?.queue_position;
    return typeof position === 'number' ? `In queue — position ${position}` : 'In queue…';
  }

  const { done, total } = pageTotals(envelope);
  if (String(envelope?.stage || '').toLowerCase() === 'assemble') {
    if (typeof total === 'number' && total > 0) {
      return `Assembling ${total} ${total === 1 ? 'page' : 'pages'}…`;
    }
    return 'Assembling PDF…';
  }

  const action = String(envelope?.task || '').toLowerCase() === 'rerender_pdf'
    ? 'Rendering'
    : 'Translating';
  if (typeof done === 'number' && typeof total === 'number' && total > 0) {
    // done counts finished pages. While a page is in flight, show that page
    // rather than leaving the counter at the previous completed page.
    return `${action}… page ${Math.min(done + 1, total)} of ${total}`;
  }
  return `${action}…`;
}

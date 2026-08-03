const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

// A running upstream request acknowledges cancel as `cancel_requested` before
// it reaches `cancelled`. Keep querying until a terminal envelope has also
// driven backend quota settlement.
export async function waitForCancellationSettlement(initialEnvelope, { getRequest, wait }) {
  let envelope = initialEnvelope;
  while (!TERMINAL_STATES.has(String(envelope?.state || '').toLowerCase())) {
    await wait();
    envelope = await getRequest(String(envelope?.request_id || ''));
  }
  return envelope;
}

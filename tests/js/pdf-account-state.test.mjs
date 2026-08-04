import assert from 'node:assert/strict';
import test from 'node:test';

import { getPdfArtifact, setAuthTokenProvider } from '../../static/desktop/src/shared/api.js';
import { createAccountChangeGuard } from '../../static/desktop/src/shared/account-state.js';
import { createAccountChangeGuard as createMobileAccountChangeGuard } from '../../static/src/shared/account-state.js';
import { waitForCancellationSettlement } from '../../static/desktop/src/views/pdf/cancellation.js';

test('PDF account state is cleared on sign-out and not on token refresh', () => {
  let clears = 0;
  const apply = createAccountChangeGuard(() => { clears += 1; });
  apply({ signedIn: true, userId: 'user-a' });
  apply({ signedIn: true, userId: 'user-a' });
  assert.equal(clears, 0);
  apply({ signedIn: false, userId: '' });
  assert.equal(clears, 1);
});

test('PDF account state is cleared on a direct account switch', () => {
  let clears = 0;
  const apply = createAccountChangeGuard(() => { clears += 1; });
  apply({ signedIn: true, userId: 'user-a' });
  apply({ signedIn: true, userId: 'user-b' });
  assert.equal(clears, 1);
});

test('anonymous image state is cleared when the user signs in', () => {
  for (const createGuard of [createAccountChangeGuard, createMobileAccountChangeGuard]) {
    let clears = 0;
    const apply = createGuard(() => { clears += 1; });
    apply({ signedIn: false, userId: '' });
    apply({ signedIn: true, userId: 'user-a' });
    assert.equal(clears, 1);
  }
});

test('cancel_requested is followed until backend settlement reaches cancelled', async () => {
  const states = ['running', 'cancelled'];
  let waits = 0;
  const envelope = await waitForCancellationSettlement(
    { request_id: 'request-1', state: 'cancel_requested' },
    {
      getRequest: async () => ({ request_id: 'request-1', state: states.shift() }),
      wait: async () => { waits += 1; },
    },
  );
  assert.equal(envelope.state, 'cancelled');
  assert.equal(waits, 2);
});

test('a queued request cancelled immediately needs no status poll', async () => {
  let polls = 0;
  const envelope = await waitForCancellationSettlement(
    { request_id: 'request-queued', state: 'cancelled' },
    {
      getRequest: async () => { polls += 1; },
      wait: async () => {},
    },
  );
  assert.equal(envelope.state, 'cancelled');
  assert.equal(polls, 0);
});

test('PDF artifacts are fetched with the current bearer token', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedOptions = null;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response('pdf-data', {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    });
  };
  setAuthTokenProvider(() => 'access-token');

  try {
    const blob = await getPdfArtifact('request id', 'translated file.pdf');
    assert.equal(blob.type, 'application/pdf');
    assert.equal(
      capturedUrl,
      '/api/pdf-translation/requests/request%20id/artifacts/translated%20file.pdf',
    );
    assert.equal(capturedOptions.headers.Authorization, 'Bearer access-token');
  } finally {
    setAuthTokenProvider(() => '');
    globalThis.fetch = originalFetch;
  }
});

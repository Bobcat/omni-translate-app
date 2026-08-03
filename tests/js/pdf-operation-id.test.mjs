import assert from 'node:assert/strict';
import test from 'node:test';

import { setAuthTokenProvider, submitPdf } from '../../static/desktop/src/shared/api.js';


test('an uncertain PDF submit is retried once with the same operation id', async () => {
  const originalFetch = globalThis.fetch;
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const requests = [];
  let token = 'access-token';
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) {
      token = 'switched-account-token';
      return new Response('upstream timeout', { status: 502 });
    }
    return new Response(JSON.stringify({ request_id: operationId, state: 'queued' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  setAuthTokenProvider(() => token);

  try {
    const envelope = await submitPdf(new Blob(['pdf']), {
      target: 'English',
      operationId,
    });
    assert.equal(envelope.request_id, operationId);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.headers['Idempotency-Key']),
      [operationId, operationId],
    );
    assert.ok(requests.every((request) => request.headers.Authorization === 'Bearer access-token'));
  } finally {
    setAuthTokenProvider(() => '');
    globalThis.fetch = originalFetch;
  }
});


test('a certain PDF submit rejection is not retried', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ detail: 'conflict' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await assert.rejects(
      submitPdf(new Blob(['pdf']), {
        target: 'English',
        operationId: '123e4567-e89b-42d3-a456-426614174000',
      }),
      (error) => error.status === 409 && /conflict/.test(error.message),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('two uncertain submits recover through status without a third upload', async () => {
  const originalFetch = globalThis.fetch;
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const calls = [];
  let token = 'first-account-token';
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (calls.length === 1) token = 'second-account-token';
    if (calls.length <= 2) return new Response('upstream timeout', { status: 502 });
    return new Response(JSON.stringify({ request_id: operationId, state: 'running' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  setAuthTokenProvider(() => token);

  try {
    const envelope = await submitPdf(new Blob(['pdf']), {
      target: 'English',
      operationId,
    });
    assert.equal(envelope.state, 'running');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.options.method || 'GET'), ['POST', 'POST', 'GET']);
    assert.equal(
      calls[2].url,
      `/api/pdf-translation/requests/${encodeURIComponent(operationId)}`,
    );
    assert.ok(
      calls.every((call) => call.options.headers.Authorization === 'Bearer first-account-token'),
    );
  } finally {
    setAuthTokenProvider(() => '');
    globalThis.fetch = originalFetch;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  setAuthTokenProvider,
  translateImage,
} from '../../static/desktop/src/shared/api.js';


test('an uncertain image submit is retried with one operation id and principal', async () => {
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
    return new Response(new Blob(['translated'], { type: 'image/png' }), {
      status: 200,
      headers: { 'X-Image-Translation-Request-Id': operationId },
    });
  };
  setAuthTokenProvider(() => token);

  try {
    const result = await translateImage(new Blob(['image'], { type: 'image/png' }), {
      source: 'auto',
      target: 'English',
      operationId,
    });
    assert.equal(result.requestId, operationId);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.headers['Idempotency-Key'] === operationId));
    assert.ok(requests.every((request) => request.headers.Authorization === 'Bearer access-token'));
  } finally {
    setAuthTokenProvider(() => '');
    globalThis.fetch = originalFetch;
  }
});


test('a certain image conflict is not retried', async () => {
  const originalFetch = globalThis.fetch;
  setAuthTokenProvider(() => 'access-token');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ detail: 'operation payload conflict' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await assert.rejects(
      translateImage(new Blob(['image'], { type: 'image/png' }), {
        source: 'auto',
        target: 'English',
        operationId: '123e4567-e89b-42d3-a456-426614174000',
      }),
      (error) => error.status === 409 && /payload conflict/.test(error.message),
    );
    assert.equal(calls, 1);
  } finally {
    setAuthTokenProvider(() => '');
    globalThis.fetch = originalFetch;
  }
});


test('an anonymous image operation establishes its cookie before upload', async () => {
  const originalFetch = globalThis.fetch;
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/me') {
      return new Response(JSON.stringify({ principal: { kind: 'anonymous' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(new Blob(['translated'], { type: 'image/png' }), {
      status: 200,
      headers: { 'X-Image-Translation-Request-Id': operationId },
    });
  };
  setAuthTokenProvider(() => '');

  try {
    await translateImage(new Blob(['image'], { type: 'image/png' }), {
      source: 'auto',
      target: 'English',
      operationId,
    });
    assert.deepEqual(calls.map((call) => call.url), ['/api/me', '/api/image-translation']);
    assert.equal(calls[1].options.headers['Idempotency-Key'], operationId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

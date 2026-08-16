import assert from 'node:assert/strict';
import test from 'node:test';

import { createPdfOperationRecovery } from '../../static/desktop/src/views/pdf/operation-recovery.js';

const OPERATION_A = '123e4567-e89b-42d3-a456-426614174000';
const OPERATION_B = '123e4567-e89b-42d3-a456-426614174001';
const STARTED_AT = '2026-08-04T10:00:00.000Z';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function remember(recovery, userId, operationId = OPERATION_A) {
  return recovery.remember(userId, {
    operationId,
    fileName: 'source.pdf',
    targetLanguage: 'English',
    startedAt: STARTED_AT,
  });
}

test('pending PDF metadata is isolated by account and contains no document', () => {
  const storage = memoryStorage();
  const recovery = createPdfOperationRecovery({ storage, getRequest: async () => ({}) });

  assert.equal(remember(recovery, 'user-a'), true);
  assert.equal(recovery.load('user-b'), null);
  assert.deepEqual(recovery.load('user-a'), {
    version: 1,
    operationId: OPERATION_A,
    fileName: 'source.pdf',
    targetLanguage: 'English',
    startedAt: STARTED_AT,
  });
  assert.equal([...storage.values.values()][0].includes('document'), false);
});

test('an active recovered operation remains stored', async () => {
  const storage = memoryStorage();
  const recovery = createPdfOperationRecovery({
    storage,
    getRequest: async (requestId) => ({ request_id: requestId, state: 'running' }),
  });
  remember(recovery, 'user-a');

  const result = await recovery.recover('user-a');

  assert.equal(result.envelope.state, 'running');
  assert.equal(result.unavailable, false);
  assert.equal(recovery.load('user-a').operationId, OPERATION_A);
});

test('preview page metadata survives recovery without storing PDF bytes', () => {
  const storage = memoryStorage();
  const recovery = createPdfOperationRecovery({ storage, getRequest: async () => ({}) });

  recovery.remember('anonymous', {
    operationId: OPERATION_A,
    fileName: 'source.pdf',
    targetLanguage: 'English',
    startedAt: STARTED_AT,
    pdfPreview: { sourcePages: 12, translatedPages: 2 },
  });

  assert.deepEqual(recovery.load('anonymous').pdfPreview, {
    sourcePages: 12,
    translatedPages: 2,
  });
  assert.equal([...storage.values.values()][0].includes('%PDF'), false);
});

test('render choices survive operation recovery', () => {
  const storage = memoryStorage();
  const recovery = createPdfOperationRecovery({ storage, getRequest: async () => ({}) });

  recovery.remember('anonymous', {
    operationId: OPERATION_A,
    fileName: 'source.pdf',
    targetLanguage: 'English',
    startedAt: STARTED_AT,
    renderOptions: {
      page_layout_mode: 'fit',
      page_scale: 0.82,
      width_fit_mode: 'extend_to_margin',
    },
  });

  const options = recovery.load('anonymous').renderOptions;
  assert.equal(options.page_layout_mode, 'fit');
  assert.equal(options.page_scale, 0.82);
  assert.equal(options.width_fit_mode, 'extend_to_margin');
});

test('a failed recovered operation is removed', async () => {
  const storage = memoryStorage();
  const recovery = createPdfOperationRecovery({
    storage,
    getRequest: async (requestId) => ({ request_id: requestId, state: 'failed' }),
  });
  remember(recovery, 'user-a');

  const result = await recovery.recover('user-a');

  assert.equal(result.envelope.state, 'failed');
  assert.equal(recovery.load('user-a'), null);
});

test('completed stays stored until the view has fetched the artifact', async () => {
  const storage = memoryStorage();
  const recovery = createPdfOperationRecovery({
    storage,
    getRequest: async (requestId) => ({ request_id: requestId, state: 'completed' }),
  });
  remember(recovery, 'user-a');

  const result = await recovery.recover('user-a');

  assert.equal(result.envelope.state, 'completed');
  assert.equal(recovery.load('user-a').operationId, OPERATION_A);
});

test('a missing or expired operation is removed', async () => {
  for (const status of [404, 410]) {
    const storage = memoryStorage();
    const recovery = createPdfOperationRecovery({
      storage,
      getRequest: async () => {
        throw Object.assign(new Error('unavailable'), { status });
      },
    });
    remember(recovery, 'user-a');

    const result = await recovery.recover('user-a');

    assert.equal(result.unavailable, true);
    assert.equal(recovery.load('user-a'), null);
  }
});

test('a temporary status failure keeps the operation for a later reload', async () => {
  const storage = memoryStorage();
  const recovery = createPdfOperationRecovery({
    storage,
    getRequest: async () => {
      throw Object.assign(new Error('unreachable'), { status: 502 });
    },
  });
  remember(recovery, 'user-a');

  const result = await recovery.recover('user-a');

  assert.equal(result.unavailable, false);
  assert.equal(result.error.status, 502);
  assert.equal(recovery.load('user-a').operationId, OPERATION_A);
});

test('settling an older operation cannot erase its replacement', () => {
  const storage = memoryStorage();
  const recovery = createPdfOperationRecovery({ storage, getRequest: async () => ({}) });
  remember(recovery, 'user-a', OPERATION_A);
  remember(recovery, 'user-a', OPERATION_B);

  recovery.forget('user-a', OPERATION_A);

  assert.equal(recovery.load('user-a').operationId, OPERATION_B);
});

test('unavailable browser storage disables recovery without blocking submit', () => {
  const recovery = createPdfOperationRecovery({ storage: null, getRequest: async () => ({}) });

  assert.equal(remember(recovery, 'user-a'), false);
  assert.equal(recovery.load('user-a'), null);
  assert.doesNotThrow(() => recovery.forget('user-a'));
});

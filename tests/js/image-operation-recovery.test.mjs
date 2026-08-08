import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createImageOperationRecovery,
  imageOperationOwnerKey,
  registerImageSignOutCancellation,
} from '../../static/shared/image-operation-recovery.js';

const OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function record() {
  return {
    operationId: OPERATION_ID,
    fileName: 'scan.png',
    targetLanguage: 'English',
    startedAt: '2026-08-08T12:00:00.000Z',
  };
}

test('owner keys separate signed users from the anonymous browser identity', () => {
  assert.equal(imageOperationOwnerKey({ signedIn: false }), 'anonymous');
  assert.equal(imageOperationOwnerKey({ signedIn: true, userId: 'user-1' }), 'user:user-1');
});

test('pending operation survives a new recovery instance', () => {
  const storage = memoryStorage();
  const first = createImageOperationRecovery({ storage, getRequest: async () => null });
  assert.equal(first.remember('user:user-1', record()), true);

  const restored = createImageOperationRecovery({ storage, getRequest: async () => null });
  assert.deepEqual(restored.load('user:user-1'), { version: 1, ...record() });
  assert.equal(restored.load('user:user-2'), null);
});

test('completed operation stays stored until the artifact fetch succeeds', async () => {
  const storage = memoryStorage();
  const recovery = createImageOperationRecovery({
    storage,
    getRequest: async () => ({ request_id: OPERATION_ID, state: 'completed' }),
  });
  recovery.remember('anonymous', record());

  const result = await recovery.recover('anonymous');

  assert.equal(result.envelope.state, 'completed');
  assert.ok(recovery.load('anonymous'));
});

test('failed and unavailable operations are forgotten', async () => {
  for (const response of [
    { request_id: OPERATION_ID, state: 'failed' },
    Object.assign(new Error('gone'), { status: 410 }),
  ]) {
    const storage = memoryStorage();
    const recovery = createImageOperationRecovery({
      storage,
      getRequest: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    });
    recovery.remember('anonymous', record());

    const result = await recovery.recover('anonymous');

    assert.equal(recovery.load('anonymous'), null);
    assert.equal(result.unavailable, response instanceof Error);
  }
});

test('temporary status failure keeps the operation recoverable', async () => {
  const storage = memoryStorage();
  const recovery = createImageOperationRecovery({
    storage,
    getRequest: async () => { throw Object.assign(new Error('upstream down'), { status: 502 }); },
  });
  recovery.remember('anonymous', record());

  const result = await recovery.recover('anonymous');

  assert.equal(result.unavailable, false);
  assert.ok(recovery.load('anonymous'));
});

test('sign out cancels and forgets the current user operation before auth changes', async () => {
  const storage = memoryStorage();
  const recovery = createImageOperationRecovery({ storage, getRequest: async () => null });
  recovery.remember('user:user-1', record());
  let beforeSignOut = null;
  const cancelled = [];
  registerImageSignOutCancellation({
    storage,
    getRequest: async () => null,
    cancelRequest: async (operationId) => { cancelled.push(operationId); },
    onBeforeSignOut: (callback) => { beforeSignOut = callback; return () => {}; },
  });

  await beforeSignOut({ signedIn: true, userId: 'user-1' });

  assert.deepEqual(cancelled, [OPERATION_ID]);
  assert.equal(recovery.load('user:user-1'), null);
});

test('sign out stays blocked and keeps recovery state when cancellation is uncertain', async () => {
  const storage = memoryStorage();
  const recovery = createImageOperationRecovery({ storage, getRequest: async () => null });
  recovery.remember('user:user-1', record());
  let beforeSignOut = null;
  registerImageSignOutCancellation({
    storage,
    getRequest: async () => null,
    cancelRequest: async () => { throw Object.assign(new Error('unreachable'), { status: 502 }); },
    onBeforeSignOut: (callback) => { beforeSignOut = callback; return () => {}; },
  });

  await assert.rejects(
    beforeSignOut({ signedIn: true, userId: 'user-1' }),
    /unreachable/,
  );
  assert.ok(recovery.load('user:user-1'));
});

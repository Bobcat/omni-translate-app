// Account-scoped persistence for one recoverable image operation. Source image
// bytes never enter browser storage; the service's durable request is authoritative.

const STORAGE_PREFIX = 'omni-translate.image-operation.';
const RECORD_VERSION = 1;
const TERMINAL_WITHOUT_ARTIFACT = new Set([
  'failed',
  'cancelled',
  'cancelled_before_authorization',
]);
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function imageOperationOwnerKey(authState) {
  if (authState?.signedIn && authState.userId) return `user:${String(authState.userId)}`;
  return 'anonymous';
}

function storageKey(ownerKey) {
  return `${STORAGE_PREFIX}${String(ownerKey || '')}`;
}

function normalizeRecord(value) {
  if (!value || value.version !== RECORD_VERSION) return null;
  const operationId = String(value.operationId || '').trim();
  const fileName = String(value.fileName || '').slice(0, 240);
  const targetLanguage = String(value.targetLanguage || '').slice(0, 80);
  const startedAt = String(value.startedAt || '');
  if (!OPERATION_ID_PATTERN.test(operationId) || !targetLanguage || !startedAt) return null;
  return { version: RECORD_VERSION, operationId, fileName, targetLanguage, startedAt };
}

export function createImageOperationRecovery({ storage, getRequest }) {
  function load(ownerKey) {
    if (!ownerKey || !storage) return null;
    const key = storageKey(ownerKey);
    try {
      const record = normalizeRecord(JSON.parse(storage.getItem(key) || 'null'));
      if (!record) storage.removeItem(key);
      return record;
    } catch {
      try { storage.removeItem(key); } catch {}
      return null;
    }
  }

  function remember(ownerKey, details) {
    if (!ownerKey || !storage) return false;
    const record = normalizeRecord({ version: RECORD_VERSION, ...details });
    if (!record) return false;
    try {
      storage.setItem(storageKey(ownerKey), JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  function forget(ownerKey, operationId = '') {
    if (!ownerKey || !storage) return;
    if (operationId) {
      const current = load(ownerKey);
      if (!current || current.operationId !== String(operationId)) return;
    }
    try { storage.removeItem(storageKey(ownerKey)); } catch {}
  }

  async function recover(ownerKey) {
    const record = load(ownerKey);
    if (!record) return { record: null, envelope: null, error: null, unavailable: false };
    try {
      const envelope = await getRequest(record.operationId);
      if (String(envelope?.request_id || '') !== record.operationId) {
        forget(ownerKey, record.operationId);
        return {
          record,
          envelope: null,
          error: new Error('The service returned a different image operation.'),
          unavailable: true,
        };
      }
      const state = String(envelope?.state || '').toLowerCase();
      if (TERMINAL_WITHOUT_ARTIFACT.has(state)) forget(ownerKey, record.operationId);
      return { record, envelope, error: null, unavailable: false };
    } catch (error) {
      const unavailable = error?.status === 404 || error?.status === 410;
      if (unavailable) forget(ownerKey, record.operationId);
      return { record, envelope: null, error, unavailable };
    }
  }

  return { load, remember, forget, recover };
}

export function registerImageSignOutCancellation({
  storage,
  getRequest,
  cancelRequest,
  onBeforeSignOut,
}) {
  const recovery = createImageOperationRecovery({ storage, getRequest });
  return onBeforeSignOut(async (authState) => {
    const ownerKey = imageOperationOwnerKey(authState);
    const record = recovery.load(ownerKey);
    if (!record) return;
    try {
      await cancelRequest(record.operationId);
    } catch (error) {
      if (error?.status !== 404 && error?.status !== 410) throw error;
    }
    recovery.forget(ownerKey, record.operationId);
  });
}

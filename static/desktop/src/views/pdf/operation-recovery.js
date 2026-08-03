// Account-scoped persistence for the one PDF operation owned by this view.
// Only recovery metadata is stored; the uploaded document never enters
// localStorage.

const STORAGE_PREFIX = 'omni-translate.desktop.pdf-operation.';
const RECORD_VERSION = 1;
const TERMINAL_WITHOUT_ARTIFACT = new Set(['failed', 'cancelled']);
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageKey(userId) {
  return `${STORAGE_PREFIX}${String(userId || '')}`;
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

export function createPdfOperationRecovery({ storage, getRequest }) {
  function load(userId) {
    if (!userId || !storage) return null;
    const key = storageKey(userId);
    try {
      const record = normalizeRecord(JSON.parse(storage.getItem(key) || 'null'));
      if (!record) storage.removeItem(key);
      return record;
    } catch {
      try { storage.removeItem(key); } catch {}
      return null;
    }
  }

  function remember(userId, details) {
    if (!userId || !storage) return false;
    const record = normalizeRecord({
      version: RECORD_VERSION,
      operationId: details?.operationId,
      fileName: details?.fileName,
      targetLanguage: details?.targetLanguage,
      startedAt: details?.startedAt,
    });
    if (!record) return false;
    try {
      storage.setItem(storageKey(userId), JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  function forget(userId, operationId = '') {
    if (!userId || !storage) return;
    if (operationId) {
      const current = load(userId);
      if (!current || current.operationId !== String(operationId)) return;
    }
    try { storage.removeItem(storageKey(userId)); } catch {}
  }

  async function recover(userId) {
    const record = load(userId);
    if (!record) return { record: null, envelope: null, error: null, unavailable: false };
    try {
      const envelope = await getRequest(record.operationId);
      if (String(envelope?.request_id || '') !== record.operationId) {
        forget(userId, record.operationId);
        return {
          record,
          envelope: null,
          error: new Error('The service returned a different PDF operation.'),
          unavailable: true,
        };
      }
      const state = String(envelope?.state || '').toLowerCase();
      // Keep completed until the view has fetched the translated artifact. A
      // reload during that fetch must still be able to resume the download.
      if (TERMINAL_WITHOUT_ARTIFACT.has(state)) forget(userId, record.operationId);
      return { record, envelope, error: null, unavailable: false };
    } catch (error) {
      const unavailable = error?.status === 404 || error?.status === 410;
      if (unavailable) forget(userId, record.operationId);
      return { record, envelope: null, error, unavailable };
    }
  }

  return { load, remember, forget, recover };
}

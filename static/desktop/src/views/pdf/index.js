import { iconMarkup } from '../../shared/icons.js';
import { populateLanguageSelect, recordLanguageMru } from '../../shared/languages.js';
import {
  submitPdf,
  rerenderPdf,
  getPdfRequest,
  cancelPdf,
  getPdfArtifact,
  getConfig,
  getEntitlements,
  getUsage,
} from '../../shared/api.js?v=20260829-voice-modes-10';
import { publishViewBusy } from '../../shared/view-activity.js';
import { onAuthChange, whenAuthReady } from '../../auth.js';
import { createAccountChangeGuard } from '../../shared/account-state.js';
import { waitForCancellationSettlement } from './cancellation.js';
import { createPdfOperationRecovery } from './operation-recovery.js';
import {
  configuredPdfPreviewLimit,
  pdfPreviewFromEnvelope,
  pdfPreviewNotice,
  translatedPdfFilename,
} from './preview.js';
import {
  createPdfQuotaCta,
  pdfAccountPlanFromConfig,
  pdfPreviewQuotaExhausted,
} from './quota-cta.js';
import { pdfPendingText } from './progress.js';
import { createPdfRenderControls } from './render-options.js';

// PDF translation view, same stage model as the Workbench: an empty state
// (dropzone) swaps for a loaded state (original frame + translated frame) once
// a file is chosen. The submit returns a lifecycle envelope immediately and
// the view polls it — a PDF can take minutes, so the translated frame shows a
// spinner with Cancel meanwhile. "Show original" collapses the stage to just
// the translated document; × returns to the dropzone (cancelling a running
// request first). Changing the target resubmits the same file, cancelling the
// job it replaces. `runToken` makes stale poll ticks and responses a no-op —
// a stale submit cancels the job it created before being ignored.
//
// The shell keeps views alive across navigation, so the poll keeps running
// while the view is detached — both the sidebar busy indicator and the stage
// have to be right while you are elsewhere, and one small GET per interval
// beats being wrong. A pending operation is also stored by account, so a full
// reload resumes status polling without retaining or re-uploading the PDF.
// Work in flight marks the sidebar entry via view-busy.

const POLL_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
// Matches the backend limit (pdf_translation.max_upload_bytes); checking here
// spares the user a full upload before the 413.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function createPdfView() {
  const container = document.createElement('div');
  container.className = 'view pdf-view';
  container.innerHTML = `
    <h1 class="visually-hidden">PDF translation</h1>
    <div class="view-toolbar" id="pdfToolbar">
      <div class="language-pair">
        <button type="button" class="language-trigger" value="auto" aria-label="Source language: Detect language" disabled>Detect language</button>
        <span class="language-arrow" aria-hidden="true">${iconMarkup('arrow-right')}</span>
        <button type="button" id="pdfTarget" aria-label="Choose target language"></button>
      </div>
      <div class="toolbar-actions">
        <label class="field switch-field">
          <span>Show original</span>
          <span class="switch">
            <input type="checkbox" id="pdfShowOriginal" checked>
            <span class="switch-slider"></span>
          </span>
        </label>
        <button type="button" class="pdf-render-toolbar-button" id="pdfRenderToggle" aria-expanded="false" aria-controls="pdfRenderPanel">
          ${iconMarkup('panel-left')}
          <span>Render</span>
        </button>
        <a class="icon-square-btn" id="pdfDownload" title="Download translated PDF" aria-label="Download translated PDF" hidden>${iconMarkup('download')}</a>
        <button type="button" class="icon-square-btn" id="pdfReset" title="Choose another PDF" aria-label="Choose another PDF" hidden>${iconMarkup('x')}</button>
      </div>
    </div>
    <div class="pdf-workspace">
      <div class="pdf-admission-loading" id="pdfAdmissionLoading">Checking PDF allowance…</div>
      <div class="dropzone-card" id="pdfDropzone" hidden>
        <div class="dropzone-drop">
          ${iconMarkup('upload-cloud')}
          <div class="dropzone-hint">Drag and drop a PDF</div>
        </div>
        <div class="dropzone-sep"></div>
        <div class="dropzone-choose">
          <span>Or choose a file</span>
          <button type="button" class="browse-btn" id="pdfBrowseBtn">Browse your files</button>
        </div>
      </div>
      <div class="result-grid" id="pdfStage" hidden>
        <figure class="result-frame result-frame-original">
          <iframe id="pdfOriginal" title="Original PDF"></iframe>
        </figure>
        <figure class="result-frame">
          <div class="stage-pending" id="pdfPending">
            <div class="spinner" role="status" aria-label="Translating"></div>
            <div class="stage-pending-text" id="pdfPendingText">Translating…</div>
            <button type="button" class="link-btn" id="pdfCancelBtn">Cancel</button>
          </div>
          <iframe id="pdfTranslated" title="Translated PDF" hidden></iframe>
        </figure>
      </div>
      <div id="pdfRenderMount"></div>
    </div>
    <div class="usage-line" id="pdfUsage" hidden></div>
    <div class="usage-line" id="pdfPreviewNotice" hidden></div>
    <div class="usage-line" id="pdfTemporaryNotice">Translations are temporary. Download the result after it completes.</div>
    <div class="status-line" id="pdfStatus" role="status"></div>
    <input type="file" id="pdfFileInput" accept="application/pdf,.pdf" hidden>
  `;

  const targetSelect = container.querySelector('#pdfTarget');
  const toolbar = container.querySelector('#pdfToolbar');
  const renderToggle = container.querySelector('#pdfRenderToggle');
  const showOriginalToggle = container.querySelector('#pdfShowOriginal');
  const showOriginalField = showOriginalToggle.closest('.switch-field');
  const downloadLink = container.querySelector('#pdfDownload');
  const resetBtn = container.querySelector('#pdfReset');
  const dropzone = container.querySelector('#pdfDropzone');
  const browseBtn = container.querySelector('#pdfBrowseBtn');
  const fileInput = container.querySelector('#pdfFileInput');
  const stage = container.querySelector('#pdfStage');
  const originalFrame = container.querySelector('#pdfOriginal');
  const translatedFrame = container.querySelector('#pdfTranslated');
  const pending = container.querySelector('#pdfPending');
  const pendingText = container.querySelector('#pdfPendingText');
  const cancelBtn = container.querySelector('#pdfCancelBtn');
  const statusEl = container.querySelector('#pdfStatus');
  const usageEl = container.querySelector('#pdfUsage');
  const previewNoticeEl = container.querySelector('#pdfPreviewNotice');
  const temporaryNoticeEl = container.querySelector('#pdfTemporaryNotice');
  const admissionLoadingEl = container.querySelector('#pdfAdmissionLoading');
  const renderMount = container.querySelector('#pdfRenderMount');
  const quotaCta = createPdfQuotaCta();
  admissionLoadingEl.after(quotaCta.element);
  const renderControls = createPdfRenderControls({
    trigger: renderToggle,
    onChange: handleRenderOptionsChange,
  });
  renderMount.replaceWith(renderControls.element);

  let currentFile = null;
  let sourceFileName = '';
  let pendingOperationId = '';
  let requestId = '';
  let requestState = '';
  let originalUrl = '';
  let translatedUrl = '';
  let runToken = 0;
  let pollTimer = 0;
  let activeOwnerKey = 'anonymous';
  let previewPageLimit = 0;
  let previewPagesPerPeriod = 0;
  let previewDetails = null;
  let accountPlan = { pagesPerPeriod: 0, maxPagesPerJob: 0 };
  let authConfigured = false;
  let planResolved = false;
  let usageResolved = false;
  let usageRemaining = null;
  let stageLoaded = false;
  let operationStartedAt = '';
  let showOriginalPreference = showOriginalToggle.checked;
  const cancellationSettlements = new Map();
  let operationStorage = null;
  try { operationStorage = window.localStorage; } catch {}
  const operationRecovery = createPdfOperationRecovery({
    storage: operationStorage,
    getRequest: getPdfRequest,
  });

  let planFetchToken = 0;
  let usageFetchToken = 0;

  function renderPreviewNotice() {
    const message = pdfPreviewNotice(previewPageLimit, previewDetails);
    previewNoticeEl.textContent = message;
    previewNoticeEl.hidden = !message || (!stageLoaded && quotaIsExhausted());
  }

  function quotaIsExhausted() {
    return pdfPreviewQuotaExhausted({
      previewPageLimit,
      usageResolved,
      remaining: usageRemaining,
    });
  }

  function renderAdmissionState() {
    const waiting = !stageLoaded && (!planResolved || !usageResolved);
    const exhausted = !stageLoaded && quotaIsExhausted();
    dropzone.hidden = stageLoaded || waiting || exhausted;
    admissionLoadingEl.hidden = stageLoaded || !waiting;
    quotaCta.element.hidden = !exhausted;
    toolbar.hidden = exhausted;
    renderControls.setAvailable(stageLoaded && !exhausted);
    temporaryNoticeEl.hidden = exhausted;
    quotaCta.update({
      previewPagesPerPeriod,
      previewPageLimit,
      accountPlan,
      authConfigured,
      visible: exhausted,
    });
    renderPreviewNotice();
  }

  async function refreshPlanInfo() {
    const token = ++planFetchToken;
    planResolved = false;
    renderAdmissionState();
    await whenAuthReady();
    if (token !== planFetchToken) return;
    const [entitlementsResult, configResult] = await Promise.allSettled([
      getEntitlements(),
      getConfig(),
    ]);
    if (token !== planFetchToken) return;
    if (entitlementsResult.status === 'fulfilled') {
      previewPageLimit = configuredPdfPreviewLimit(entitlementsResult.value);
    }
    if (configResult.status === 'fulfilled') {
      accountPlan = pdfAccountPlanFromConfig(configResult.value);
      authConfigured = Boolean(configResult.value?.auth?.configured);
    }
    planResolved = true;
    renderAdmissionState();
  }

  // Page balance for the resolved plan. Refreshed on account changes and
  // terminal settlement.
  async function refreshUsage() {
    const token = ++usageFetchToken;
    usageResolved = false;
    renderAdmissionState();
    await whenAuthReady();
    if (token !== usageFetchToken) return;
    try {
      const data = await getUsage();
      if (token !== usageFetchToken) return;
      const pages = (data?.usage || []).find((entry) => entry.metric === 'pdf_translation.pages');
      if (!pages || typeof pages.remaining !== 'number' || typeof pages.limit !== 'number') {
        usageEl.hidden = true;
        usageRemaining = null;
        return;
      }
      usageRemaining = pages.remaining;
      previewPagesPerPeriod = pages.limit;
      usageEl.textContent = `PDF pages this month: ${pages.remaining} of ${pages.limit} left${usageBreakdown(pages)}${formatResetDate(pages.period_end)}`;
      usageEl.hidden = false;
    } catch {
      // A failed fetch leaves the previous balance in place.
    } finally {
      if (token === usageFetchToken) {
        usageResolved = true;
        renderAdmissionState();
      }
    }
  }

  populateLanguageSelect(targetSelect, 'English');
  setOriginalAvailable(false);

  const applyAccountChange = createAccountChangeGuard(discardAccountState);
  applyAccountChange({ signedIn: false, userId: '' });
  recoverPendingOperation(activeOwnerKey);
  refreshPlanInfo();
  refreshUsage();
  onAuthChange((authState) => {
    const nextOwnerKey = authState?.signedIn && authState.userId
      ? `user:${String(authState.userId)}`
      : 'anonymous';
    const accountChanged = nextOwnerKey !== activeOwnerKey;
    applyAccountChange(authState);
    activeOwnerKey = nextOwnerKey;
    previewPageLimit = 0;
    previewPagesPerPeriod = 0;
    previewDetails = null;
    accountPlan = { pagesPerPeriod: 0, maxPagesPerJob: 0 };
    authConfigured = false;
    planResolved = false;
    usageResolved = false;
    usageRemaining = null;
    usageEl.hidden = true;
    renderAdmissionState();
    refreshPlanInfo();
    refreshUsage();
    if (accountChanged) recoverPendingOperation(activeOwnerKey);
  });

  function setBusy(busy) {
    publishViewBusy('pdf', busy);
    renderControls.setBusy(busy);
  }

  function setStatus(message, isError = false) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function setPending(message) {
    pending.hidden = false;
    translatedFrame.hidden = true;
    pendingText.textContent = message || 'Translating…';
  }

  function clearPending() {
    pending.hidden = true;
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function applyViewMode() {
    stage.classList.toggle('is-single', !showOriginalToggle.checked);
  }

  function setOriginalAvailable(available) {
    showOriginalField.hidden = !available;
    if (!available) showOriginalToggle.checked = false;
    else showOriginalToggle.checked = showOriginalPreference;
    applyViewMode();
  }

  function setStageLoaded(loaded) {
    stageLoaded = loaded;
    stage.hidden = !loaded;
    resetBtn.hidden = !loaded;
    renderAdmissionState();
  }

  // The rendered translation is the first artifact that is not the uploaded
  // input and carries a PDF mime type (same selection as the workbench).
  function translatedArtifactName(envelope) {
    const artifacts = envelope?.response?.artifacts || {};
    for (const [name, meta] of Object.entries(artifacts)) {
      if (name === 'input') continue;
      if (String(meta?.mime_type || '').includes('pdf')) return name;
    }
    return '';
  }

  async function showTranslated(envelope) {
    const name = translatedArtifactName(envelope);
    if (!name) {
      clearPending();
      setStatus('Translation finished but no PDF was returned.', true);
      return;
    }
    const artifactRequestId = requestId;
    const blob = await getPdfArtifact(artifactRequestId, name);
    if (artifactRequestId !== requestId) return;
    if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    translatedUrl = URL.createObjectURL(blob);
    clearPending();
    translatedFrame.src = translatedUrl;
    translatedFrame.hidden = false;
    renderAdmissionState();
    downloadLink.href = translatedUrl;
    downloadLink.download = translatedPdfFilename(
      sourceFileName,
      targetSelect.value,
      previewDetails,
    );
    downloadLink.hidden = false;
    setStatus('');
  }

  function forgetPendingOperation(operationId = pendingOperationId || requestId) {
    operationRecovery.forget(activeOwnerKey, operationId);
    if (!operationId || pendingOperationId === operationId) pendingOperationId = '';
  }

  function rememberPendingOperation(operationId = pendingOperationId || requestId) {
    if (!operationId) return;
    operationRecovery.remember(activeOwnerKey, {
      operationId,
      fileName: sourceFileName,
      targetLanguage: targetSelect.value,
      startedAt: operationStartedAt,
      pdfPreview: previewDetails,
      renderOptions: renderControls.getValues(),
    });
  }

  function applyPreviewEnvelope(envelope) {
    const next = pdfPreviewFromEnvelope(envelope);
    if (!next) return;
    previewDetails = next;
    renderPreviewNotice();
    rememberPendingOperation();
  }

  async function applyEnvelope(token, envelope) {
    if (String(envelope?.request_id || '') !== requestId) {
      throw new Error('The service returned a different PDF operation.');
    }
    applyPreviewEnvelope(envelope);
    renderControls.setEnvelope(envelope);
    const state = String(envelope?.state || '').toLowerCase();
    requestState = state;
    if (state === 'completed') {
      refreshUsage();
      try {
        await showTranslated(envelope);
      } catch (err) {
        if (err?.status === 404 || err?.status === 410) forgetPendingOperation(requestId);
        throw err;
      }
      if (token !== runToken) return true;
      forgetPendingOperation(requestId);
      setBusy(false);
      return true;
    }
    if (TERMINAL_STATES.has(state)) {
      forgetPendingOperation(requestId);
      clearPending();
      setStatus(envelope?.error?.message || `Translation ${state}.`, true);
      setBusy(false);
      refreshUsage();
      return true;
    }
    setPending(pdfPendingText(envelope));
    return false;
  }

  async function poll(token) {
    stopPolling();
    if (token !== runToken || !requestId) return;
    try {
      const envelope = await getPdfRequest(requestId);
      if (token !== runToken) return;
      if (await applyEnvelope(token, envelope)) return;
    } catch (err) {
      if (token !== runToken) return;
      clearPending();
      setStatus(err.message || 'Could not fetch the translation status.', true);
      setBusy(false);
      return;
    }
    pollTimer = window.setTimeout(() => poll(token), POLL_INTERVAL_MS);
  }

  async function recoverPendingOperation(ownerKey) {
    const saved = operationRecovery.load(ownerKey);
    if (!saved) return;
    const token = ++runToken;
    stopPolling();
    currentFile = null;
    sourceFileName = saved.fileName;
    pendingOperationId = saved.operationId;
    requestId = saved.operationId;
    requestState = '';
    previewDetails = saved.pdfPreview || null;
    if (saved.renderOptions) renderControls.setValues(saved.renderOptions);
    operationStartedAt = saved.startedAt;
    renderPreviewNotice();
    populateLanguageSelect(targetSelect, saved.targetLanguage);
    setOriginalAvailable(false);
    setStageLoaded(true);
    setPending('Restoring translation…');
    setStatus('');
    setBusy(true);

    const result = await operationRecovery.recover(ownerKey);
    if (token !== runToken || ownerKey !== activeOwnerKey) return;
    if (result.error) {
      clearPending();
      setBusy(false);
      if (result.unavailable) {
        clearLocalPdfState();
        setStatus(
          'The previous translation is no longer available. Any open quota reservation will be reconciled by the server.',
          true,
        );
      } else {
        setStatus('Could not restore the previous translation. Reload to try again, or remove it with ×.', true);
      }
      return;
    }
    try {
      if (await applyEnvelope(token, result.envelope)) return;
    } catch (err) {
      if (token !== runToken) return;
      clearPending();
      setStatus(err.message || 'Could not restore the previous translation.', true);
      setBusy(false);
      return;
    }
    pollTimer = window.setTimeout(() => poll(token), POLL_INTERVAL_MS);
  }

  async function translate(file) {
    if (!planResolved || !usageResolved || quotaIsExhausted()) {
      renderAdmissionState();
      return;
    }
    const token = ++runToken;
    stopPolling();
    await whenAuthReady();
    if (token !== runToken) return;
    // A replacement must wait until the old reservation is settled. Otherwise
    // a target-language change can reserve the same pages twice and strand the
    // old hold after the regular poll has been invalidated.
    if (requestId && !TERMINAL_STATES.has(requestState)) {
      const previousRequestId = requestId;
      setPending('Cancelling previous translation…');
      try {
        await cancelAndSettle(previousRequestId);
      } catch (err) {
        if (token !== runToken) return;
        setStatus(err.message || 'Could not cancel the previous translation.', true);
        setPending('Translating…');
        poll(token);
        return;
      }
      if (token !== runToken) return;
    }
    currentFile = file;
    sourceFileName = file.name || 'document.pdf';
    pendingOperationId = '';
    requestId = '';
    requestState = '';
    previewDetails = null;
    operationStartedAt = '';
    renderControls.setEnvelope(null);
    renderPreviewNotice();
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');
    if (translatedUrl) {
      URL.revokeObjectURL(translatedUrl);
      translatedUrl = '';
    }
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = URL.createObjectURL(file);
    originalFrame.src = originalUrl;
    translatedFrame.removeAttribute('src');
    setOriginalAvailable(true);
    setStageLoaded(true);
    setPending('Uploading…');
    setStatus('');
    setBusy(true);
    const operationId = globalThis.crypto.randomUUID();
    pendingOperationId = operationId;
    operationStartedAt = new Date().toISOString();
    rememberPendingOperation(operationId);
    try {
      const envelope = await submitPdf(file, {
        target: targetSelect.value,
        operationId,
        renderOptions: renderControls.getValues(),
      });
      if (token !== runToken) {
        cancelStaleSubmit(envelope);
        return;
      }
      requestId = String(envelope?.request_id || '');
      requestState = String(envelope?.state || '').toLowerCase();
      applyPreviewEnvelope(envelope);
      refreshUsage();
      if (!requestId) {
        clearPending();
        setStatus('The service did not return a request id.', true);
        setBusy(false);
        return;
      }
      setPending(pdfPendingText(envelope));
      poll(token);
    } catch (err) {
      if (token !== runToken) return;
      if (err?.status && err.status !== 408 && err.status < 500) {
        forgetPendingOperation(operationId);
      }
      clearPending();
      setStatus(err.message || 'Could not submit the PDF.', true);
      setBusy(false);
      await refreshUsage();
      if (err?.status === 429 && quotaIsExhausted()) clearLocalPdfState();
    }
  }

  function handleRenderOptionsChange() {
    if (requestState !== 'completed' || !requestId) return;
    rerenderCurrent();
  }

  async function rerenderCurrent() {
    const sourceRequestId = requestId;
    const token = ++runToken;
    stopPolling();
    await whenAuthReady();
    if (token !== runToken) return;
    const operationId = globalThis.crypto.randomUUID();
    pendingOperationId = operationId;
    operationStartedAt = new Date().toISOString();
    downloadLink.hidden = true;
    setPending('Rendering…');
    setStatus('');
    setBusy(true);
    rememberPendingOperation(operationId);
    try {
      const envelope = await rerenderPdf(sourceRequestId, {
        operationId,
        renderOptions: renderControls.getValues(),
      });
      if (token !== runToken) {
        cancelStaleSubmit(envelope);
        return;
      }
      requestId = String(envelope?.request_id || '');
      requestState = String(envelope?.state || '').toLowerCase();
      applyPreviewEnvelope(envelope);
      if (!requestId) {
        forgetPendingOperation(operationId);
        clearPending();
        translatedFrame.hidden = !translatedUrl;
        setStatus('The service did not return a request id.', true);
        setBusy(false);
        return;
      }
      setPending(pdfPendingText(envelope));
      poll(token);
    } catch (err) {
      if (token !== runToken) return;
      if (err?.status && err.status !== 408 && err.status < 500) {
        forgetPendingOperation(operationId);
      }
      requestId = sourceRequestId;
      requestState = 'completed';
      clearPending();
      translatedFrame.hidden = !translatedUrl;
      downloadLink.hidden = !translatedUrl;
      setStatus(err.message || 'Could not render the PDF.', true);
      setBusy(false);
    }
  }

  function waitForNextPoll() {
    return new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
  }

  function cancelAndSettle(id) {
    if (cancellationSettlements.has(id)) return cancellationSettlements.get(id);
    const ownerId = activeOwnerKey;
    const settlement = cancelPdf(id)
      .then((envelope) => waitForCancellationSettlement(envelope, {
        getRequest: getPdfRequest,
        wait: waitForNextPoll,
      }))
      .then((envelope) => {
        operationRecovery.forget(ownerId, id);
        refreshUsage();
        return envelope;
      })
      .finally(() => { cancellationSettlements.delete(id); });
    cancellationSettlements.set(id, settlement);
    return settlement;
  }

  function cancelRequest() {
    if (!requestId || TERMINAL_STATES.has(requestState)) return null;
    return cancelAndSettle(requestId);
  }

  // A submit abandoned while still in flight (language change, reset, a newer
  // file — requestId was not known yet, so cancelRequest could not reach it)
  // still creates a job server-side. Cancel the id from the stale envelope
  // instead of dropping it, or the orphaned job keeps occupying the shared
  // queue. This settlement continues in the background.
  function cancelStaleSubmit(envelope) {
    const id = String(envelope?.request_id || '');
    if (!id) return;
    cancelAndSettle(id).catch(() => {});
  }

  function clearLocalPdfState() {
    setBusy(false);
    currentFile = null;
    sourceFileName = '';
    pendingOperationId = '';
    requestId = '';
    requestState = '';
    previewDetails = null;
    operationStartedAt = '';
    renderControls.setEnvelope(null);
    renderPreviewNotice();
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');
    downloadLink.removeAttribute('download');
    originalFrame.removeAttribute('src');
    translatedFrame.removeAttribute('src');
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    originalUrl = '';
    translatedUrl = '';
    setOriginalAvailable(false);
    clearPending();
    setStatus('');
    setStageLoaded(false);
  }

  function resetView() {
    ++runToken;
    stopPolling();
    const operationId = pendingOperationId || requestId;
    const settlement = cancelRequest();
    operationRecovery.forget(activeOwnerKey, operationId);
    clearLocalPdfState();
    settlement?.catch(() => {});
  }

  function discardAccountState() {
    ++runToken;
    stopPolling();
    operationRecovery.forget(activeOwnerKey);
    clearLocalPdfState();
  }

  targetSelect.addEventListener('change', () => {
    recordLanguageMru(targetSelect.value);
    populateLanguageSelect(targetSelect, targetSelect.value);
    if (currentFile) translate(currentFile);
  });

  showOriginalToggle.addEventListener('change', () => {
    showOriginalPreference = showOriginalToggle.checked;
    applyViewMode();
  });
  cancelBtn.addEventListener('click', () => { resetView(); });
  resetBtn.addEventListener('click', () => { resetView(); });

  function acceptFile(file) {
    if (!file) return;
    if (!planResolved || !usageResolved || quotaIsExhausted()) {
      renderAdmissionState();
      return;
    }
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) {
      setStatus('Unsupported file type — choose a PDF.', true);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setStatus(`PDF too large — the maximum is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`, true);
      return;
    }
    translate(file);
  }

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    acceptFile(fileInput.files[0]);
    fileInput.value = '';
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragover');
    acceptFile(event.dataTransfer.files[0]);
  });

  return container;
}

function formatResetDate(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return '';
  return ` · resets ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date)}`;
}

function usageBreakdown(entry) {
  const consumed = Number(entry?.consumed || 0);
  const reserved = Number(entry?.reserved || 0);
  return ` · ${consumed.toLocaleString()} used · ${reserved.toLocaleString()} pending`;
}

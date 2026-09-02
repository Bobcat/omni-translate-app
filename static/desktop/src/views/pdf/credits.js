import { iconMarkup } from '../../shared/icons.js';
import { populateLanguageSelect, recordLanguageMru } from '../../shared/languages.js';
import {
  cancelPdf,
  confirmPdf,
  getPdfArtifact,
  getPdfRequest,
  preparePdf,
  quotePdf,
} from '../../shared/api.js?v=20260902-credits-23';
import {
  refreshDesktopCredits,
  subscribeDesktopCreditState,
} from '../../shared/credit-state.js?v=20260902-credits-25';
import { onAuthChange, whenAuthReady } from '../../auth.js';
import { publishViewBusy } from '../../shared/view-activity.js?v=20260829-voice-modes-11';
import {
  pdfCreditProgressCopy,
  pdfCreditQuoteCopy,
  pdfCreditScopeCopy,
  pdfFreeAccountCopy,
  pdfFreeCreditAccessCopy,
  pdfGuestPreviewCopy,
} from './credit-copy.js?v=20260902-credits-8';
import { pdfPendingText } from './progress.js?v=20260902-credits-1';
import { attachPdfSplitView } from './split-view.js?v=20260901-credits-9';
import { createPdfViewer } from './viewer/index.js?v=20260901-pdfjs-14';

const POLL_INTERVAL_MS = 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const STORAGE_PREFIX = 'omni-translate.desktop.pdf-credit-operation.';
const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'cancelled_before_authorization',
]);

function translatedPdfFilename(sourceFileName, targetLanguage) {
  const stem = String(sourceFileName || 'document').replace(/\.[^.]+$/, '') || 'document';
  const target = String(targetLanguage || '').toLowerCase() || 'translated';
  return `${stem}_${target}.pdf`;
}

export function createPdfCreditsView({ onViewPlans }) {
  const container = document.createElement('div');
  container.className = 'view pdf-view pdf-credit-view';
  container.innerHTML = `
    <h1 class="visually-hidden">PDF translation</h1>
    <div class="view-toolbar pdf-credit-toolbar">
      <div class="pdf-credit-document-heading">
        <span aria-hidden="true">${iconMarkup('file-text')}</span>
        <strong data-role="document-name">PDF translation</strong>
      </div>
      <div class="toolbar-actions">
        <a class="icon-square-btn" data-role="download" title="Download translated PDF" aria-label="Download translated PDF" hidden>${iconMarkup('download')}</a>
        <button type="button" class="icon-square-btn" data-role="reset" title="Choose another PDF" aria-label="Choose another PDF" hidden>${iconMarkup('x')}</button>
      </div>
    </div>
    <div class="pdf-workspace">
      <div class="pdf-credit-setup" data-role="setup">
        <section class="pdf-credit-upload" data-role="dropzone" aria-label="Upload source PDF">
          ${iconMarkup('upload-cloud')}
          <h2>Drag and drop a PDF</h2>
          <p>or choose a file from your device</p>
          <button type="button" class="browse-btn" data-role="browse">Browse your files</button>
        </section>
        <section class="pdf-credit-setup-side" aria-label="Translation setup">
          <div>
            <p class="pdf-credit-eyebrow">Translation</p>
            <h2>Translate this PDF</h2>
          </div>
          <div data-role="setup-target-mount">
            <label class="pdf-credit-target-field" data-role="target-field">
              <span>Target language</span>
              <button type="button" data-role="target" aria-label="Choose target language"></button>
            </label>
          </div>
          <div class="pdf-credit-setup-summary">
            <span>Credit use</span>
            <strong>Shown after upload</strong>
            <p>We read the pages and source text first. Translation starts only after you confirm the exact credit use and target language.</p>
          </div>
          <div class="pdf-credit-scope" data-role="setup-guest-scope" hidden></div>
          <div class="pdf-credit-plan-note" data-role="setup-plan-note" hidden>
            <strong>Translate longer PDFs for free</strong>
            <p data-role="setup-free-plan-copy"></p>
            <button type="button" class="link-btn" data-role="setup-view-plans">View plans</button>
          </div>
        </section>
      </div>
      <div class="pdf-credit-grid" data-role="stage" hidden>
        <section class="pdf-credit-source" aria-label="Source PDF">
          <div data-role="original-mount"></div>
          <div class="pdf-credit-source-placeholder" data-role="source-placeholder" hidden>
            <span>${iconMarkup('file-text')}</span>
            <strong data-role="source-name"></strong>
            <span>The source is securely staged for this translation.</span>
          </div>
        </section>
        <div
          class="pdf-credit-divider"
          data-role="divider"
          role="separator"
          aria-label="Resize PDF panes"
          aria-orientation="vertical"
          aria-valuemin="0"
          aria-valuemax="100"
          tabindex="0"
        ></div>
        <section class="pdf-credit-side" data-role="side" aria-live="polite">
          <div class="pdf-credit-preparing" data-role="preparing">
            <div class="spinner" role="status" aria-label="Preparing translation"></div>
            <h2>Preparing translation…</h2>
            <p>Reading the document and counting the source text.</p>
          </div>
          <div class="pdf-credit-config" data-role="config" hidden>
            <div>
              <p class="pdf-credit-eyebrow">Translation</p>
              <h2>Translate this PDF</h2>
            </div>
            <div data-role="config-target-mount"></div>
            <div class="pdf-credit-scope" data-role="scope"></div>
            <div class="pdf-credit-use-card">
              <span>Will use</span>
              <strong><span data-role="quote-credits"></span> credits</strong>
              <p data-role="quote-basis"></p>
              <p data-role="quote-remaining"></p>
              <div class="pdf-credit-plan-note" data-role="plan-note" role="status" hidden>
                <strong data-role="plan-note-title"></strong>
                <p data-role="quote-shortfall-copy" hidden></p>
                <p data-role="free-plan-copy" hidden></p>
                <button type="button" class="link-btn" data-role="view-plans"></button>
              </div>
            </div>
            <div class="pdf-credit-config-actions">
              <button type="button" class="pdf-credit-primary" data-role="translate"></button>
            </div>
          </div>
          <div class="pdf-credit-progress" data-role="progress" hidden>
            <div class="spinner" role="status" aria-label="Translating"></div>
            <h2 data-role="progress-title">Translating…</h2>
            <p data-role="progress-text"></p>
            <button type="button" class="pdf-credit-secondary" data-role="cancel"></button>
          </div>
          <div class="pdf-credit-result" data-role="result" hidden>
            <div class="pdf-credit-result-viewer" data-role="translated-mount"></div>
          </div>
          <div class="pdf-credit-error" data-role="error" hidden>
            <h2>Translation could not be completed</h2>
            <p data-role="error-message"></p>
            <p class="pdf-credit-returned" data-role="returned" hidden></p>
          </div>
        </section>
      </div>
    </div>
    <div class="status-line" data-role="status" role="status"></div>
    <input type="file" data-role="file" accept="application/pdf,.pdf" hidden>
    <dialog class="pdf-credit-dialog" data-role="confirm-dialog">
      <form method="dialog" class="pdf-credit-dialog-card">
        <h2 data-role="confirm-title"></h2>
        <p data-role="confirm-copy"></p>
        <div class="pdf-credit-dialog-actions">
          <button type="submit" value="back" class="pdf-credit-secondary">Back</button>
          <button type="submit" value="confirm" class="pdf-credit-primary" data-role="confirm-action"></button>
        </div>
      </form>
    </dialog>
    <dialog class="pdf-credit-dialog" data-role="stop-dialog">
      <form method="dialog" class="pdf-credit-dialog-card">
        <h2>Stop translation?</h2>
        <p data-role="stop-copy"></p>
        <div class="pdf-credit-dialog-actions">
          <button type="submit" value="keep" class="pdf-credit-secondary">Keep translating</button>
          <button type="submit" value="stop" class="pdf-credit-danger">Stop translation</button>
        </div>
      </form>
    </dialog>
  `;

  const find = (role) => container.querySelector(`[data-role="${role}"]`);
  const setup = find('setup');
  const dropzone = find('dropzone');
  const stage = find('stage');
  const browseBtn = find('browse');
  const fileInput = find('file');
  const resetBtn = find('reset');
  const downloadLink = find('download');
  const viewPlansButton = find('view-plans');
  const setupViewPlansButton = find('setup-view-plans');
  const targetSelect = find('target');
  const targetField = find('target-field');
  const setupTargetMount = find('setup-target-mount');
  const configTargetMount = find('config-target-mount');
  const preparing = find('preparing');
  const configPanel = find('config');
  const progressPanel = find('progress');
  const resultPanel = find('result');
  const errorPanel = find('error');
  const confirmDialog = find('confirm-dialog');
  const stopDialog = find('stop-dialog');
  const originalViewer = createPdfViewer({ label: 'Original PDF' });
  const translatedViewer = createPdfViewer({ label: 'Translated PDF' });
  find('original-mount').replaceWith(originalViewer.element);
  find('translated-mount').replaceWith(translatedViewer.element);
  attachPdfSplitView({ container: stage, separator: find('divider') });

  let ownerKey = 'anonymous';
  let sourceFile = null;
  let sourceFileName = '';
  let requestId = '';
  let requestState = '';
  let quote = null;
  let scope = null;
  let creditPlans = [];
  let currentPlan = '';
  let translatedUrl = '';
  let pollTimer = 0;
  let runToken = 0;
  let quoteToken = 0;
  let storage = null;
  try { storage = window.localStorage; } catch {}

  populateLanguageSelect(targetSelect, 'English');
  subscribeDesktopCreditState(applyCreditState);
  refreshCredits();
  recover();
  onAuthChange((authState) => {
    const nextOwner = authState?.signedIn && authState.userId
      ? `user:${String(authState.userId)}`
      : 'anonymous';
    if (nextOwner === ownerKey) return;
    clearView({ forget: false, cancel: false });
    ownerKey = nextOwner;
    creditPlans = [];
    currentPlan = '';
    renderSetupPlanNote();
    refreshCredits();
    recover();
  });

  function setMode(mode) {
    preparing.hidden = mode !== 'preparing';
    configPanel.hidden = mode !== 'config';
    progressPanel.hidden = mode !== 'progress';
    resultPanel.hidden = mode !== 'result';
    errorPanel.hidden = mode !== 'error';
  }

  function setBusy(value) {
    publishViewBusy('pdf', Boolean(value));
  }

  function setStatus(message, isError = false) {
    const element = find('status');
    element.textContent = message || '';
    element.classList.toggle('is-error', Boolean(isError));
  }

  function showStage() {
    setup.hidden = true;
    stage.hidden = false;
    resetBtn.hidden = false;
    configTargetMount.append(targetField);
    setDocumentName(sourceFileName);
  }

  function setDocumentName(fileName = '') {
    const name = String(fileName || '').trim();
    const heading = find('document-name');
    heading.textContent = name || 'PDF translation';
    heading.title = name;
  }

  function showSourcePlaceholder() {
    originalViewer.element.hidden = true;
    find('source-placeholder').hidden = false;
    find('source-name').textContent = sourceFileName || 'Source PDF';
  }

  function showSource(file) {
    find('source-placeholder').hidden = true;
    originalViewer.element.hidden = false;
    originalViewer.load(file);
  }

  async function restoreSource(token, envelope) {
    const inputArtifact = envelope?.response?.artifacts?.input;
    if (!String(inputArtifact?.mime_type || '').includes('pdf')) return;
    const artifactRequestId = requestId;
    try {
      const blob = await getPdfArtifact(artifactRequestId, 'input');
      if (token !== runToken || artifactRequestId !== requestId) return;
      sourceFile = blob;
      showSource(blob);
    } catch {
      // The source artifact may have expired independently of saved recovery metadata.
    }
  }

  function stopPolling() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function schedulePoll(token) {
    stopPolling();
    pollTimer = window.setTimeout(() => poll(token), POLL_INTERVAL_MS);
  }

  async function refreshCredits() {
    try {
      await refreshDesktopCredits();
    } catch {}
  }

  function applyCreditState(creditState) {
    const available = Number(creditState?.credits?.available);
    creditPlans = creditState?.plans || [];
    currentPlan = String(creditState?.credits?.plan || '');
    renderSetupPlanNote();
    if (quote && Number.isFinite(available)) {
      quote.available = available;
      quote.remaining_after_confirmation = requestState === 'awaiting_quota'
        ? Math.max(0, available - Number(quote.credits || 0))
        : available;
      if (requestState === 'awaiting_quota') renderQuote();
    }
  }

  async function acceptFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) {
      setStatus('Unsupported file type — choose a PDF.', true);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setStatus(`PDF too large — the maximum is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`, true);
      return;
    }
    const token = ++runToken;
    stopPolling();
    await whenAuthReady();
    if (token !== runToken) return;
    sourceFile = file;
    sourceFileName = file.name || 'document.pdf';
    requestId = globalThis.crypto.randomUUID();
    requestState = '';
    quote = null;
    scope = null;
    showStage();
    showSource(file);
    setMode('preparing');
    setStatus('');
    setBusy(true);
    remember();
    try {
      const envelope = await preparePdf(file, { operationId: requestId });
      if (token !== runToken) return;
      await applyEnvelope(token, envelope);
    } catch (err) {
      if (token !== runToken) return;
      showError(err.message || 'Could not prepare the PDF.');
      setBusy(false);
    }
  }

  async function applyEnvelope(token, envelope) {
    if (token !== runToken) return true;
    if (String(envelope?.request_id || '') !== requestId) {
      throw new Error('The service returned a different PDF operation.');
    }
    requestState = String(envelope?.state || '').toLowerCase();
    scope = envelope?.pdf_scope || scope;
    if (requestState === 'awaiting_quota') {
      setBusy(false);
      await refreshQuote();
      return true;
    }
    if (requestState === 'completed') {
      if (!sourceFile) void restoreSource(token, envelope);
      await showResult(envelope);
      forget();
      setBusy(false);
      refreshCredits();
      return true;
    }
    if (TERMINAL_STATES.has(requestState)) {
      const returned = envelope?.credit_usage?.state === 'released';
      showError(
        envelope?.error?.message || `Translation ${requestState}.`,
        returned ? `${Number(envelope.credit_usage.credits).toLocaleString()} credits returned` : '',
      );
      forget();
      setBusy(false);
      refreshCredits();
      return true;
    }
    if (envelope?.credit_usage) showProgress(envelope);
    else setMode('preparing');
    schedulePoll(token);
    return false;
  }

  async function poll(token) {
    if (token !== runToken || !requestId) return;
    try {
      const envelope = await getPdfRequest(requestId);
      await applyEnvelope(token, envelope);
    } catch (err) {
      if (token !== runToken) return;
      setStatus(err.message || 'Could not fetch translation status.', true);
      schedulePoll(token);
    }
  }

  async function refreshQuote() {
    const token = ++quoteToken;
    setMode('config');
    find('translate').disabled = true;
    find('translate').textContent = 'Preparing price…';
    find('plan-note').hidden = true;
    try {
      const payload = await quotePdf(requestId, { target: targetSelect.value });
      if (token !== quoteToken || !requestId) return;
      quote = payload.quote;
      scope = payload.pdf_scope || scope;
      renderQuote();
      remember();
    } catch (err) {
      if (token !== quoteToken) return;
      showError(err.message || 'Could not create the credit quote.');
    }
  }

  function renderQuote() {
    if (!quote) return;
    setMode('config');
    const copy = pdfCreditQuoteCopy(quote, targetSelect.value);
    find('quote-credits').textContent = copy.credits;
    find('quote-basis').textContent = copy.basis;
    find('quote-remaining').textContent = copy.remaining;
    find('quote-remaining').hidden = !copy.affordable;
    find('quote-shortfall-copy').textContent = copy.insufficient;
    find('scope').textContent = pdfCreditScopeCopy(scope);
    renderPlanNote(copy);
    const button = find('translate');
    button.textContent = copy.action;
    button.disabled = !copy.affordable;
    button.hidden = !copy.affordable;
  }

  function renderPlanNote(copy) {
    const freeCopy = currentPlan === 'anonymous' ? pdfFreeAccountCopy(creditPlans) : '';
    const freeCreditAccessCopy = currentPlan === 'anonymous'
      ? pdfFreeCreditAccessCopy(creditPlans)
      : '';
    const insufficient = !copy.affordable;
    const note = find('plan-note');
    note.hidden = !insufficient && !freeCopy;
    note.classList.toggle('is-warning', insufficient);
    find('plan-note-title').textContent = insufficient
      ? 'Not enough credits'
      : 'Translate longer PDFs for free';
    find('quote-shortfall-copy').hidden = !insufficient;
    find('free-plan-copy').textContent = insufficient ? freeCreditAccessCopy : freeCopy;
    find('free-plan-copy').hidden = insufficient ? !freeCreditAccessCopy : !freeCopy;
    viewPlansButton.textContent = 'View plans';
  }

  function renderSetupPlanNote() {
    const guestPreviewCopy = currentPlan === 'anonymous'
      ? pdfGuestPreviewCopy(creditPlans)
      : '';
    const freeCopy = currentPlan === 'anonymous' ? pdfFreeAccountCopy(creditPlans) : '';
    find('setup-guest-scope').hidden = !guestPreviewCopy;
    find('setup-guest-scope').textContent = guestPreviewCopy;
    find('setup-plan-note').hidden = !freeCopy;
    find('setup-free-plan-copy').textContent = freeCopy;
  }

  function openConfirmDialog() {
    if (!quote) return;
    const copy = pdfCreditQuoteCopy(quote, targetSelect.value);
    find('confirm-title').textContent = copy.confirmTitle;
    find('confirm-copy').textContent = copy.confirmCopy;
    find('confirm-action').textContent = copy.confirmAction;
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
  }

  async function confirmTranslation() {
    if (!quote) return;
    const token = ++runToken;
    setBusy(true);
    setMode('progress');
    find('progress-title').textContent = 'Reserving credits…';
    find('progress-text').textContent = '';
    try {
      const envelope = await confirmPdf(requestId, {
        quoteId: quote.id,
        target: targetSelect.value,
      });
      if (token !== runToken) return;
      remember();
      refreshCredits();
      await applyEnvelope(token, envelope);
    } catch (err) {
      if (token !== runToken) return;
      if (err?.code === 'QUOTE_EXPIRED') {
        quote = null;
        await refreshQuote();
        setStatus('The previous quote expired. Review the new credit amount before continuing.', true);
        setBusy(false);
        return;
      }
      const required = Number(err?.details?.required);
      const available = Number(err?.details?.available);
      if (err?.code === 'CREDITS_EXHAUSTED' && Number.isFinite(available) && quote) {
        quote.available = available;
        quote.remaining_after_confirmation = Math.max(0, available - Number(quote.credits || 0));
      }
      setMode('config');
      renderQuote();
      setStatus(
        err?.code === 'CREDITS_EXHAUSTED'
          && Number.isFinite(required)
          && Number.isFinite(available)
          ? `This translation needs ${required.toLocaleString()} credits; ${available.toLocaleString()} are available.`
          : (err.message || 'Could not start the translation.'),
        true,
      );
      setBusy(false);
      refreshCredits();
    }
  }

  function showProgress(envelope) {
    setMode('progress');
    const copy = pdfCreditProgressCopy(envelope, quote);
    find('progress-title').textContent = pdfPendingText(envelope);
    find('progress-text').textContent = pdfCreditScopeCopy(scope);
    const cancel = find('cancel');
    cancel.textContent = copy.cancelAction;
    cancel.dataset.computeStarted = copy.computeStarted ? 'true' : 'false';
  }

  async function showResult(envelope) {
    const artifactName = translatedArtifactName(envelope);
    if (!artifactName) throw new Error('Translation finished but no PDF was returned.');
    const blob = await getPdfArtifact(requestId, artifactName);
    if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    translatedUrl = URL.createObjectURL(blob);
    translatedViewer.load(blob);
    setMode('result');
    downloadLink.href = translatedUrl;
    downloadLink.download = translatedPdfFilename(sourceFileName, targetSelect.value);
    downloadLink.hidden = false;
    setStatus('');
  }

  function showError(message, returned = '') {
    setMode('error');
    find('error-message').textContent = message;
    find('returned').textContent = returned;
    find('returned').hidden = !returned;
    setStatus('');
  }

  async function cancelTranslation() {
    if (!requestId || TERMINAL_STATES.has(requestState)) return;
    try {
      const envelope = await cancelPdf(requestId);
      await applyEnvelope(runToken, envelope);
    } catch (err) {
      setStatus(err.message || 'Could not cancel the translation.', true);
    }
  }

  function clearView({ forget: removeStored = true, cancel = true } = {}) {
    const activeId = requestId;
    const activeState = requestState;
    ++runToken;
    ++quoteToken;
    stopPolling();
    if (cancel && activeId && !TERMINAL_STATES.has(activeState)) {
      cancelPdf(activeId).catch(() => {});
    }
    if (removeStored) forget();
    sourceFile = null;
    sourceFileName = '';
    requestId = '';
    requestState = '';
    quote = null;
    scope = null;
    originalViewer.clear();
    translatedViewer.clear();
    if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    translatedUrl = '';
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');
    resetBtn.hidden = true;
    stage.hidden = true;
    setupTargetMount.append(targetField);
    setup.hidden = false;
    setDocumentName();
    setStatus('');
    setBusy(false);
  }

  function remember() {
    if (!storage || !requestId) return;
    try {
      storage.setItem(storageKey(ownerKey), JSON.stringify({
        version: 1,
        operationId: requestId,
        fileName: sourceFileName,
        targetLanguage: targetSelect.value,
        quote,
        scope,
      }));
    } catch {}
  }

  function forget() {
    if (!storage) return;
    try { storage.removeItem(storageKey(ownerKey)); } catch {}
  }

  async function recover() {
    if (!storage) return;
    let saved = null;
    try { saved = JSON.parse(storage.getItem(storageKey(ownerKey)) || 'null'); } catch {}
    if (!saved?.operationId) return;
    const token = ++runToken;
    requestId = String(saved.operationId);
    sourceFileName = String(saved.fileName || 'Source PDF');
    quote = saved.quote || null;
    scope = saved.scope || null;
    populateLanguageSelect(targetSelect, String(saved.targetLanguage || 'English'));
    showStage();
    showSourcePlaceholder();
    setMode('preparing');
    setBusy(true);
    try {
      const envelope = await getPdfRequest(requestId);
      if (token !== runToken) return;
      await applyEnvelope(token, envelope);
    } catch (err) {
      if (token !== runToken) return;
      showError(err.message || 'Could not restore the previous translation.');
      setBusy(false);
    }
  }

  targetSelect.addEventListener('change', () => {
    recordLanguageMru(targetSelect.value);
    populateLanguageSelect(targetSelect, targetSelect.value);
    if (requestState === 'awaiting_quota') refreshQuote();
  });
  find('translate').addEventListener('click', openConfirmDialog);
  viewPlansButton.addEventListener('click', onViewPlans);
  setupViewPlansButton.addEventListener('click', onViewPlans);
  confirmDialog.addEventListener('close', () => {
    if (confirmDialog.returnValue === 'confirm') confirmTranslation();
  });
  find('cancel').addEventListener('click', () => {
    if (find('cancel').dataset.computeStarted === 'true') {
      find('stop-copy').textContent = pdfCreditProgressCopy(
        { quota: { compute_started_at_utc: true }, credit_usage: { credits: quote?.credits } },
        quote,
      ).stopCopy;
      stopDialog.returnValue = '';
      stopDialog.showModal();
    } else {
      cancelTranslation();
    }
  });
  stopDialog.addEventListener('close', () => {
    if (stopDialog.returnValue === 'stop') cancelTranslation();
  });
  resetBtn.addEventListener('click', () => clearView());
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

function storageKey(ownerKey) {
  return `${STORAGE_PREFIX}${String(ownerKey || 'anonymous')}`;
}

function translatedArtifactName(envelope) {
  const artifacts = envelope?.response?.artifacts || {};
  for (const [name, metadata] of Object.entries(artifacts)) {
    if (name !== 'input' && String(metadata?.mime_type || '').includes('pdf')) return name;
  }
  return '';
}

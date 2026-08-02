import { iconMarkup } from '../../shared/icons.js';
import { populateLanguageSelect, recordLanguageMru } from '../../shared/languages.js';
import { submitPdf, getPdfRequest, cancelPdf, pdfArtifactUrl, getMe } from '../../shared/api.js';
import { publishViewBusy } from '../../shared/view-activity.js';
import { isEnabled as isAuthEnabled, onAuthChange, whenAuthReady } from '../../auth.js';
import { createSignInCard } from '../../shared/signin-card.js';

// PDF translation view, same stage model as the LLM Workbench: an empty state
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
// beats being wrong. Work in flight marks the sidebar entry via view-busy.

const POLL_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
// Matches the backend limit (pdf_translation.max_upload_bytes); checking here
// spares the user a full upload before the 413.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function createPdfView() {
  const container = document.createElement('div');
  container.className = 'view pdf-view';
  container.innerHTML = `
    <div class="view-toolbar">
      <div class="field">
        <span>Target</span>
        <button type="button" id="pdfTarget"></button>
      </div>
      <label class="field switch-field">
        <span>Show original</span>
        <span class="switch">
          <input type="checkbox" id="pdfShowOriginal" checked>
          <span class="switch-slider"></span>
        </span>
      </label>
      <div class="toolbar-actions">
        <a class="icon-square-btn" id="pdfDownload" title="Download translated PDF" aria-label="Download translated PDF" hidden>${iconMarkup('download')}</a>
        <button type="button" class="icon-square-btn" id="pdfReset" title="Choose another PDF" aria-label="Choose another PDF" hidden>${iconMarkup('x')}</button>
      </div>
    </div>
    <div class="dropzone-card" id="pdfDropzone">
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
    <div class="status-line" id="pdfStatus" role="status"></div>
    <input type="file" id="pdfFileInput" accept="application/pdf,.pdf" hidden>
  `;

  const targetSelect = container.querySelector('#pdfTarget');
  const showOriginalToggle = container.querySelector('#pdfShowOriginal');
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

  let currentFile = null;
  let requestId = '';
  let requestState = '';
  let originalUrl = '';
  let runToken = 0;
  let pollTimer = 0;

  // Anonymous gate: when the deployment has auth configured and the caller is
  // not signed in, the sign-in card replaces the upload UI (the anonymous plan
  // has PDF disabled). Re-evaluated on every auth-state change, so signing in
  // swaps the upload UI back in. Not gated at all when auth is unconfigured —
  // dev stays anonymous-only.
  const gateCard = createSignInCard('PDF translation needs a free account — 12 pages per month included.');
  gateCard.classList.add('pdf-gate');
  gateCard.hidden = true;
  container.appendChild(gateCard);

  let gateToken = 0;

  async function applyAuthGate() {
    if (!isAuthEnabled()) return;
    const token = ++gateToken;
    // Wait for the SDK session restore so a signed-in user is not gated on a
    // not-yet-restored (empty) bearer token.
    await whenAuthReady();
    if (token !== gateToken) return;
    let principalKind = '';
    try {
      const me = await getMe();
      principalKind = String(me?.principal?.kind || '');
    } catch {
      // A failed /api/me leaves the view usable rather than gating on a guess.
      return;
    }
    if (token !== gateToken) return;
    const gated = principalKind !== 'user';
    container.classList.toggle('is-gated', gated);
    gateCard.hidden = !gated;
  }

  applyAuthGate();
  onAuthChange(() => { applyAuthGate(); });

  populateLanguageSelect(targetSelect, 'English');
  applyViewMode();

  function setBusy(busy) {
    publishViewBusy('pdf', busy);
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

  function setStageLoaded(loaded) {
    dropzone.hidden = loaded;
    stage.hidden = !loaded;
    resetBtn.hidden = !loaded;
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

  function progressText(envelope) {
    const done = envelope?.pages_done ?? envelope?.response?.document?.pages_done;
    const total = envelope?.pages_total ?? envelope?.response?.document?.pages_total ?? envelope?.page_count;
    if (typeof done === 'number' && typeof total === 'number' && total > 0) {
      // done counts FINISHED pages, so "0/N" sits there while page 1 is still
      // in flight — showing the page in progress reads as movement, not stall.
      return `Translating… page ${Math.min(done + 1, total)} of ${total}`;
    }
    return 'Translating…';
  }

  // The service shares one FIFO between image and pdf requests and lets image
  // work overtake a queued PDF, so the position is "place in line", not an
  // exact "N ahead of you" — the label stays honest about that.
  function pendingTextFor(envelope) {
    if (String(envelope?.state || '').toLowerCase() === 'queued') {
      const position = envelope?.queue_position;
      return typeof position === 'number' ? `In queue — position ${position}` : 'In queue…';
    }
    return progressText(envelope);
  }

  function showTranslated(envelope) {
    const name = translatedArtifactName(envelope);
    if (!name) {
      clearPending();
      setStatus('Translation finished but no PDF was returned.', true);
      return;
    }
    const url = pdfArtifactUrl(requestId, name);
    clearPending();
    translatedFrame.src = url;
    translatedFrame.hidden = false;
    const stem = (currentFile?.name || 'document').replace(/\.[^.]+$/, '');
    downloadLink.href = url;
    downloadLink.download = `${stem}_${targetSelect.value.toLowerCase()}.pdf`;
    downloadLink.hidden = false;
    setStatus('');
  }

  async function poll(token) {
    stopPolling();
    if (token !== runToken || !requestId) return;
    try {
      const envelope = await getPdfRequest(requestId);
      if (token !== runToken) return;
      const state = String(envelope?.state || '').toLowerCase();
      requestState = state;
      if (state === 'completed') {
        showTranslated(envelope);
        setBusy(false);
        return;
      }
      if (TERMINAL_STATES.has(state)) {
        clearPending();
        setStatus(envelope?.error?.message || `Translation ${state}.`, true);
        setBusy(false);
        return;
      }
      setPending(pendingTextFor(envelope));
    } catch (err) {
      if (token !== runToken) return;
      clearPending();
      setStatus(err.message || 'Could not fetch the translation status.', true);
      setBusy(false);
      return;
    }
    pollTimer = window.setTimeout(() => poll(token), POLL_INTERVAL_MS);
  }

  async function translate(file) {
    const token = ++runToken;
    stopPolling();
    // Cancel the request this one replaces (e.g. a target-language change
    // mid-run) so it stops occupying the shared service queue. Fire and
    // forget, same tolerance as resetView: a slow or failed cancel must not
    // delay the replacement. Reads the current requestId synchronously, so
    // it must run before the reset below.
    cancelRequest();
    currentFile = file;
    requestId = '';
    requestState = '';
    downloadLink.hidden = true;
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = URL.createObjectURL(file);
    originalFrame.src = originalUrl;
    translatedFrame.removeAttribute('src');
    setStageLoaded(true);
    setPending('Uploading…');
    setStatus('');
    setBusy(true);
    try {
      const envelope = await submitPdf(file, { target: targetSelect.value });
      if (token !== runToken) {
        cancelStaleSubmit(envelope);
        return;
      }
      requestId = String(envelope?.request_id || '');
      requestState = String(envelope?.state || '').toLowerCase();
      if (!requestId) {
        clearPending();
        setStatus('The service did not return a request id.', true);
        setBusy(false);
        return;
      }
      setPending(pendingTextFor(envelope));
      poll(token);
    } catch (err) {
      if (token !== runToken) return;
      clearPending();
      setStatus(err.message || 'Could not submit the PDF.', true);
      setBusy(false);
    }
  }

  async function cancelRequest() {
    if (!requestId || TERMINAL_STATES.has(requestState)) return;
    try {
      await cancelPdf(requestId);
    } catch {
      // A failed cancel must not trap the user on the stage; the reset proceeds.
    }
  }

  // A submit abandoned while still in flight (language change, reset, a newer
  // file — requestId was not known yet, so cancelRequest could not reach it)
  // still creates a job server-side. Cancel the id from the stale envelope
  // instead of dropping it, or the orphaned job keeps occupying the shared
  // queue. Fire and forget, same tolerance as cancelRequest.
  function cancelStaleSubmit(envelope) {
    const id = String(envelope?.request_id || '');
    if (!id) return;
    cancelPdf(id).catch(() => {});
  }

  async function resetView() {
    ++runToken;
    stopPolling();
    await cancelRequest();
    setBusy(false);
    currentFile = null;
    requestId = '';
    requestState = '';
    downloadLink.hidden = true;
    originalFrame.removeAttribute('src');
    translatedFrame.removeAttribute('src');
    if (originalUrl) {
      URL.revokeObjectURL(originalUrl);
      originalUrl = '';
    }
    clearPending();
    setStatus('');
    setStageLoaded(false);
  }

  targetSelect.addEventListener('change', () => {
    recordLanguageMru(targetSelect.value);
    populateLanguageSelect(targetSelect, targetSelect.value);
    if (currentFile) translate(currentFile);
  });

  showOriginalToggle.addEventListener('change', applyViewMode);
  cancelBtn.addEventListener('click', () => { resetView(); });
  resetBtn.addEventListener('click', () => { resetView(); });

  function acceptFile(file) {
    if (!file) return;
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

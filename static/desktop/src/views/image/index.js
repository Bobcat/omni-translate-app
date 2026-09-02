import { iconMarkup } from '../../shared/icons.js';
import { populateLanguageSelect, recordLanguageMru } from '../../shared/languages.js';
import {
  cancelImage,
  getImageArtifact,
  getImageRequest,
  translateImage,
  retranslateImage,
} from '../../shared/api.js?v=20260902-credits-23';
import { publishViewBusy } from '../../shared/view-activity.js?v=20260829-voice-modes-11';
import { onAuthChange } from '../../auth.js';
import {
  createImageOperationRecovery,
  imageOperationOwnerKey,
} from '../../../../shared/image-operation-recovery.js';

// Image translation view, same stage model as the PDF view: an empty state
// (dropzone) swaps for a loaded state (original frame + translated frame) once
// a file is chosen. The translated frame shows a spinner while the backend
// translates. The explicit reset action cancels a pending durable request;
// changing the target re-translates the
// current image (the service reuses its OCR, so that is cheap). `runToken`
// makes a stale response a no-op when the user drops a new file, switches
// target, or resets mid-flight.
//
// The shell keeps views alive across navigation: a response that arrives
// while the view is detached still renders, and work in flight marks the
// sidebar entry via view-busy.

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TERMINAL_STATES = new Set(['failed', 'cancelled', 'cancelled_before_authorization']);
const POLL_INTERVAL_MS = 1000;

export function createImageView() {
  const container = document.createElement('div');
  container.className = 'view image-view';
  container.innerHTML = `
    <h1 class="visually-hidden">Image translation</h1>
    <div class="view-toolbar">
      <div class="language-pair">
        <button type="button" class="language-trigger" value="auto" aria-label="Source language: Detect language" disabled>Detect language</button>
        <span class="language-arrow" aria-hidden="true">${iconMarkup('arrow-right')}</span>
        <button type="button" id="imageTarget" aria-label="Choose target language"></button>
      </div>
      <div class="toolbar-actions">
        <label class="field switch-field">
          <span>Show original</span>
          <span class="switch">
            <input type="checkbox" id="imageShowOriginal" checked>
            <span class="switch-slider"></span>
          </span>
        </label>
        <label class="zoom-field" id="imageZoomField" title="Image size" hidden>
          <input type="range" id="imageZoom" min="25" max="200" step="5" value="100">
          <output id="imageZoomValue">100%</output>
        </label>
        <a class="icon-square-btn" id="imageDownload" title="Download translated image" aria-label="Download translated image" hidden>${iconMarkup('download')}</a>
        <button type="button" class="icon-square-btn" id="imageReset" title="Choose another image" aria-label="Choose another image" hidden>${iconMarkup('x')}</button>
      </div>
    </div>
    <div class="dropzone-card" id="imageDropzone">
      <div class="dropzone-drop">
        ${iconMarkup('upload-cloud')}
        <div class="dropzone-hint">Drag and drop an image</div>
      </div>
      <div class="dropzone-sep"></div>
      <div class="dropzone-choose">
        <span>Or choose a file</span>
        <button type="button" class="browse-btn" id="imageBrowseBtn">Browse your files</button>
      </div>
    </div>
    <div class="result-grid" id="imageStage" hidden>
      <figure class="result-frame result-frame-original">
        <img id="imageOriginal" alt="Original image">
      </figure>
      <figure class="result-frame">
        <div class="stage-pending" id="imagePending">
          <div class="spinner" role="status" aria-label="Translating"></div>
          <div class="stage-pending-text">Translating…</div>
        </div>
        <img id="imageTranslated" alt="Translated image" hidden>
      </figure>
    </div>
    <div class="status-line" id="imageStatus" role="status"></div>
    <input type="file" id="imageFileInput" accept="image/png,image/jpeg,image/webp" hidden>
  `;

  const targetSelect = container.querySelector('#imageTarget');
  const showOriginalToggle = container.querySelector('#imageShowOriginal');
  const showOriginalField = showOriginalToggle.closest('.switch-field');
  const downloadLink = container.querySelector('#imageDownload');
  const resetBtn = container.querySelector('#imageReset');
  const zoomField = container.querySelector('#imageZoomField');
  const zoomInput = container.querySelector('#imageZoom');
  const zoomValue = container.querySelector('#imageZoomValue');
  const dropzone = container.querySelector('#imageDropzone');
  const browseBtn = container.querySelector('#imageBrowseBtn');
  const fileInput = container.querySelector('#imageFileInput');
  const stage = container.querySelector('#imageStage');
  const originalImg = container.querySelector('#imageOriginal');
  const translatedImg = container.querySelector('#imageTranslated');
  const pending = container.querySelector('#imagePending');
  const statusEl = container.querySelector('#imageStatus');

  let requestId = '';
  let fileName = '';
  let originalUrl = '';
  let translatedUrl = '';
  let pendingOperationId = '';
  let requestState = '';
  let runToken = 0;
  let pollTimer = 0;
  let activeOwnerKey = 'anonymous';
  let operationStorage = null;
  try { operationStorage = window.localStorage; } catch {}
  const operationRecovery = createImageOperationRecovery({
    storage: operationStorage,
    getRequest: getImageRequest,
  });
  // Auto-fit wins until the user touches the slider; re-armed for each image.
  let zoomAuto = true;

  populateLanguageSelect(targetSelect, 'English');
  setOriginalAvailable(false);
  recoverPendingOperation(activeOwnerKey);
  onAuthChange((authState) => {
    const nextOwnerKey = imageOperationOwnerKey(authState);
    if (nextOwnerKey === activeOwnerKey) return;
    operationRecovery.forget(activeOwnerKey);
    resetView({ cancelPending: false });
    activeOwnerKey = nextOwnerKey;
    recoverPendingOperation(activeOwnerKey);
  });

  function setBusy(busy) {
    publishViewBusy('image', busy);
    targetSelect.disabled = busy;
  }

  function stopPolling() {
    if (!pollTimer) return;
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function setStatus(message, isError = false) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function applyViewMode() {
    stage.classList.toggle('is-single', !showOriginalToggle.checked);
  }

  // Zoom is relative to the image's NATIVE size (CSS zoom scales the layout
  // box), so the frame grows with the image and >100% scrolls inside it.
  function applyZoom(pct) {
    zoomInput.value = String(pct);
    zoomValue.textContent = `${pct}%`;
    originalImg.style.zoom = String(pct / 100);
    translatedImg.style.zoom = String(pct / 100);
  }

  // Largest step-of-5 zoom that still fits the column width, capped at 100%
  // (small images stay native; the user can upscale manually past that).
  function fitZoom() {
    const naturalWidth = originalImg.naturalWidth;
    const frameWidth = translatedImg.closest('.result-frame').clientWidth;
    if (!naturalWidth || !frameWidth) return;
    const pct = Math.max(25, Math.min(100, Math.floor((frameWidth / naturalWidth) * 100 / 5) * 5));
    applyZoom(pct);
  }

  function setStageLoaded(loaded) {
    dropzone.hidden = loaded;
    stage.hidden = !loaded;
    resetBtn.hidden = !loaded;
    zoomField.hidden = !loaded;
  }

  function setOriginalAvailable(available) {
    showOriginalField.hidden = !available;
    showOriginalToggle.checked = available;
    applyViewMode();
  }

  function showTranslated(blob) {
    if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    translatedUrl = URL.createObjectURL(blob);
    translatedImg.src = translatedUrl;
    translatedImg.hidden = false;
    pending.hidden = true;
    const extension = blob.type === 'image/jpeg' ? 'jpg' : (blob.type.split('/')[1] || 'png');
    const stem = fileName.replace(/\.[^.]+$/, '') || 'image';
    downloadLink.href = translatedUrl;
    downloadLink.download = `${stem}_${targetSelect.value.toLowerCase()}.${extension}`;
    downloadLink.hidden = false;
    setStatus('');
  }

  function showError(message) {
    pending.hidden = true;
    setStatus(message || 'Translation failed.', true);
  }

  function rememberOperation(operationId) {
    if (pendingOperationId && pendingOperationId !== operationId) {
      cancelImage(pendingOperationId).catch(() => {});
    }
    pendingOperationId = operationId;
    requestState = '';
    operationRecovery.remember(activeOwnerKey, {
      operationId,
      fileName,
      targetLanguage: targetSelect.value,
      startedAt: new Date().toISOString(),
    });
  }

  function forgetOperation(operationId = pendingOperationId || requestId) {
    operationRecovery.forget(activeOwnerKey, operationId);
    if (!operationId || pendingOperationId === operationId) pendingOperationId = '';
  }

  async function applyRecoveredEnvelope(token, envelope) {
    if (String(envelope?.request_id || '') !== requestId) {
      throw new Error('The service returned a different image operation.');
    }
    const state = String(envelope?.state || '').toLowerCase();
    requestState = state;
    if (state === 'completed') {
      const artifactRequestId = requestId;
      const blob = await getImageArtifact(artifactRequestId);
      if (token !== runToken || artifactRequestId !== requestId) return true;
      showTranslated(blob);
      forgetOperation(artifactRequestId);
      setBusy(false);
      return true;
    }
    if (TERMINAL_STATES.has(state)) {
      const message = envelope?.error?.message || `Translation ${state.replaceAll('_', ' ')}.`;
      forgetOperation(requestId);
      requestId = '';
      showError(message);
      setBusy(false);
      return true;
    }
    pending.hidden = false;
    pending.querySelector('.stage-pending-text').textContent = state === 'queued'
      ? 'Waiting in queue…'
      : 'Translating…';
    return false;
  }

  async function pollRecoveredOperation(token) {
    stopPolling();
    if (token !== runToken || !requestId) return;
    try {
      const envelope = await getImageRequest(requestId);
      if (token !== runToken) return;
      if (await applyRecoveredEnvelope(token, envelope)) return;
      setStatus('');
    } catch (err) {
      if (token !== runToken) return;
      if (err?.status === 404 || err?.status === 410) {
        forgetOperation(requestId);
        resetView({ cancelPending: false, keepStatus: true });
        setStatus('The previous image translation is no longer available.', true);
        return;
      }
      setStatus('Translation status is temporarily unavailable. Retrying…', true);
    }
    pollTimer = window.setTimeout(() => pollRecoveredOperation(token), POLL_INTERVAL_MS);
  }

  async function recoverPendingOperation(ownerKey) {
    const saved = operationRecovery.load(ownerKey);
    if (!saved) return;
    const token = ++runToken;
    stopPolling();
    fileName = saved.fileName || 'image';
    pendingOperationId = saved.operationId;
    requestId = saved.operationId;
    requestState = '';
    populateLanguageSelect(targetSelect, saved.targetLanguage);
    setOriginalAvailable(false);
    setStageLoaded(true);
    translatedImg.hidden = true;
    downloadLink.hidden = true;
    pending.hidden = false;
    pending.querySelector('.stage-pending-text').textContent = 'Restoring translation…';
    setStatus('');
    setBusy(true);

    const result = await operationRecovery.recover(ownerKey);
    if (token !== runToken || ownerKey !== activeOwnerKey) return;
    if (result.error) {
      if (result.unavailable) {
        resetView({ cancelPending: false, keepStatus: true });
        setStatus('The previous image translation is no longer available.', true);
      } else {
        setStatus('Could not restore the translation yet. Retrying…', true);
        pollTimer = window.setTimeout(() => pollRecoveredOperation(token), POLL_INTERVAL_MS);
      }
      return;
    }
    try {
      if (await applyRecoveredEnvelope(token, result.envelope)) return;
    } catch (err) {
      if (token !== runToken) return;
      if (err?.status === 404 || err?.status === 410) {
        forgetOperation(requestId);
        requestId = '';
        showError(err.message || 'The previous image translation is no longer available.');
        setBusy(false);
        return;
      }
      setStatus('The translated image is temporarily unavailable. Retrying…', true);
      pollTimer = window.setTimeout(() => pollRecoveredOperation(token), POLL_INTERVAL_MS);
      return;
    }
    pollTimer = window.setTimeout(() => pollRecoveredOperation(token), POLL_INTERVAL_MS);
  }

  async function translate(file) {
    const token = ++runToken;
    stopPolling();
    requestId = '';
    requestState = '';
    zoomAuto = true;
    fileName = file.name || 'image';
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = URL.createObjectURL(file);
    originalImg.src = originalUrl;
    translatedImg.removeAttribute('src');
    translatedImg.hidden = true;
    downloadLink.hidden = true;
    setStageLoaded(true);
    setOriginalAvailable(true);
    pending.hidden = false;
    setStatus('');
    setBusy(true);
    const operationId = globalThis.crypto.randomUUID();
    rememberOperation(operationId);
    try {
      const result = await translateImage(file, {
        source: 'auto',
        target: targetSelect.value,
        operationId,
      });
      if (token !== runToken) return;
      requestId = result.requestId;
      requestState = 'completed';
      showTranslated(result.blob);
      forgetOperation(operationId);
      setBusy(false);
    } catch (err) {
      if (token !== runToken) return;
      if (err?.status && err.status !== 408 && err.status < 500) forgetOperation(operationId);
      showError(err.message);
      setBusy(false);
    }
  }

  async function retranslate() {
    const token = ++runToken;
    stopPolling();
    downloadLink.hidden = true;
    translatedImg.hidden = true;
    pending.hidden = false;
    setStatus('');
    setBusy(true);
    const operationId = globalThis.crypto.randomUUID();
    rememberOperation(operationId);
    try {
      const result = await retranslateImage(requestId, {
        target: targetSelect.value,
        operationId,
      });
      if (token !== runToken) return;
      requestId = result.requestId;
      requestState = 'completed';
      showTranslated(result.blob);
      forgetOperation(operationId);
      setBusy(false);
    } catch (err) {
      if (token !== runToken) return;
      if (err?.status && err.status !== 408 && err.status < 500) forgetOperation(operationId);
      showError(err.message);
      setBusy(false);
    }
  }

  function resetView({ cancelPending = true, keepStatus = false } = {}) {
    ++runToken;
    stopPolling();
    const operationId = pendingOperationId;
    if (cancelPending && operationId && !TERMINAL_STATES.has(requestState)) {
      cancelImage(operationId).catch(() => {});
    }
    forgetOperation(operationId);
    requestId = '';
    requestState = '';
    setBusy(false);
    downloadLink.hidden = true;
    originalImg.removeAttribute('src');
    translatedImg.removeAttribute('src');
    if (originalUrl) {
      URL.revokeObjectURL(originalUrl);
      originalUrl = '';
    }
    if (translatedUrl) {
      URL.revokeObjectURL(translatedUrl);
      translatedUrl = '';
    }
    pending.hidden = true;
    setOriginalAvailable(false);
    if (!keepStatus) setStatus('');
    setStageLoaded(false);
  }

  targetSelect.addEventListener('change', () => {
    recordLanguageMru(targetSelect.value);
    populateLanguageSelect(targetSelect, targetSelect.value);
    if (requestId) retranslate();
  });

  showOriginalToggle.addEventListener('change', () => {
    applyViewMode();
    if (zoomAuto) fitZoom();
  });
  resetBtn.addEventListener('click', () => resetView());
  originalImg.addEventListener('load', () => {
    if (zoomAuto) fitZoom();
  });
  zoomInput.addEventListener('input', () => {
    zoomAuto = false;
    applyZoom(Number(zoomInput.value));
  });

  function acceptFile(file) {
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      setStatus('Unsupported file type — use PNG, JPEG or WebP.', true);
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

  // Auto-fit needs layout widths, which are 0 while the view is detached;
  // re-fit on return if the user never took over the slider.
  container.__onActivate = () => {
    if (zoomAuto && !stage.hidden) fitZoom();
  };

  return container;
}

// Image translation UX: local file selection, preview state, the real
// translation request to the backend proxy (`/api/image-translation`), the
// Original/Translated result surface, and returning to setup.

import { state } from '../state.js';
import { APP_MODES } from '../shared/constants.js';
import { els } from '../els.js';
import { api } from '../api-client.js';
import { currentLane } from '../domain/lanes.js';
import { normalizeLanguageName, codeForLanguage } from '../domain/languages.js';
import { renderLifecycle } from '../ui/render-status.js';
import { updateActionButtons } from '../ui/action-buttons.js';
import { refreshImageUsageCopy } from './usage.js';
import {
  createImageOperationRecovery,
  imageOperationOwnerKey,
} from '../../shared/image-operation-recovery.js';

const TERMINAL_STATES = new Set(['failed', 'cancelled', 'cancelled_before_authorization']);
const RECOVERY_POLL_INTERVAL_MS = 1000;

let operationStorage = null;
try { operationStorage = window.localStorage; } catch {}
const operationRecovery = createImageOperationRecovery({
  storage: operationStorage,
  getRequest: api.getImageRequest,
});
let activeRecoveryOwnerKey = 'anonymous';
let pendingOperationId = '';
let requestState = '';
let recoveryPollTimer = 0;

export function initializeImageOperationRecovery() {
  recoverPendingImageOperation(activeRecoveryOwnerKey);
}

export function handleImageAuthChange(authState) {
  const nextOwnerKey = imageOperationOwnerKey(authState);
  if (nextOwnerKey === activeRecoveryOwnerKey) return;
  operationRecovery.forget(activeRecoveryOwnerKey);
  stopRecoveryPolling();
  if (state.appMode === APP_MODES.IMAGE_TRANSLATION) {
    syncImageTranslationHistory(state.appMode, APP_MODES.SETUP);
    resetImageTranslationState({ cancelPending: false });
  }
  activeRecoveryOwnerKey = nextOwnerKey;
  recoverPendingImageOperation(activeRecoveryOwnerKey);
}

export function handleImageFileChange(event) {
  if (state.appMode !== APP_MODES.SETUP) {
    resetFileInput();
    return;
  }
  const file = event.target?.files?.[0];
  if (!file) return;
  if (!String(file.type || '').startsWith('image/')) {
    resetFileInput();
    return;
  }
  setSelectedImage(file);
}

export function setImageDisplayMode(mode) {
  if (!state.imageTranslation.translatedReady || state.imageTranslation.busy) return;
  state.imageTranslation.displayMode = mode === 'translated' ? 'translated' : 'original';
  renderImageTranslation();
}

export function retranslateImageToTarget(targetLanguage) {
  const it = state.imageTranslation;
  if (state.appMode !== APP_MODES.IMAGE_TRANSLATION) return;
  if (it.busy || !it.requestId) return;
  const nextTarget = normalizeLanguageName(targetLanguage);
  if (it.translatedReady && it.translatedTargetLanguage === nextTarget) return;
  const token = {};
  it.requestToken = token;
  it.busy = true;
  it.error = '';
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
  requestRetranslation(it.requestId, nextTarget, token);
}

// Re-render the current image with the current render options (state.imageRender) — reuses the
// cached translations on the service, no re-translation. Called when a render option changes in
// either the settings sheet or the inline strip. A no-op until there is a completed translation.
export function rerenderCurrentImage() {
  const it = state.imageTranslation;
  if (state.appMode !== APP_MODES.IMAGE_TRANSLATION) return;
  if (it.busy || !it.requestId || !it.translatedReady) return;
  const token = {};
  it.requestToken = token;
  it.busy = true;
  it.error = '';
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
  const operationId = globalThis.crypto.randomUUID();
  rememberOperation(operationId, it.translatedTargetLanguage);
  api.rerenderImage(it.requestId, { ...state.imageRender }, operationId)
    .then((result) => applyImageTranslationResult(result, token, it.translatedTargetLanguage))
    .catch((err) => applyRerenderError(err, token));
}

// Download the translated render as "<source-basename>_<target-code>.png". The rendered image is
// always a PNG regardless of the source type, so the extension is forced to .png.
export function saveTranslatedImage() {
  const it = state.imageTranslation;
  if (!it.translatedReady || !it.translatedUrl) return;
  const base = String(it.fileName || 'image').replace(/\.[^.]+$/, '') || 'image';
  const code = codeForLanguage(it.translatedTargetLanguage).toLowerCase();
  const link = document.createElement('a');
  link.href = it.translatedUrl;
  link.download = `${base}_${code}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function finishImageTranslation() {
  if (state.appMode !== APP_MODES.IMAGE_TRANSLATION) return false;
  syncImageTranslationHistory(state.appMode, APP_MODES.SETUP);
  resetImageTranslationState();
  return true;
}

export function finishImageTranslationFromHistory() {
  if (state.appMode !== APP_MODES.IMAGE_TRANSLATION) return false;
  _skipImageTranslationHistorySync = true;
  try {
    resetImageTranslationState();
  } finally {
    _skipImageTranslationHistorySync = false;
  }
  return true;
}

function stopRecoveryPolling() {
  if (!recoveryPollTimer) return;
  window.clearTimeout(recoveryPollTimer);
  recoveryPollTimer = 0;
}

function rememberOperation(operationId, targetLanguage) {
  if (pendingOperationId && pendingOperationId !== operationId) {
    api.cancelImage(pendingOperationId).catch(() => {});
  }
  pendingOperationId = operationId;
  requestState = '';
  operationRecovery.remember(activeRecoveryOwnerKey, {
    operationId,
    fileName: state.imageTranslation.fileName,
    targetLanguage,
    startedAt: new Date().toISOString(),
  });
}

function forgetOperation(operationId = pendingOperationId || state.imageTranslation.requestId) {
  operationRecovery.forget(activeRecoveryOwnerKey, operationId);
  if (!operationId || pendingOperationId === operationId) pendingOperationId = '';
}

function resetImageTranslationState({ cancelPending = true } = {}) {
  stopRecoveryPolling();
  const operationId = pendingOperationId;
  if (cancelPending && operationId && !TERMINAL_STATES.has(requestState)) {
    api.cancelImage(operationId).catch(() => {});
  }
  forgetOperation(operationId);
  requestState = '';
  clearSelectedImage();
  resetFileInput();
  state.appMode = APP_MODES.SETUP;
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
  refreshImageUsageCopy();
}

export function renderImageTranslation() {
  const {
    fileName,
    previewUrl,
    translatedUrl,
    translatedReady,
    displayMode,
    shouldResetScroll,
    error,
    busy,
  } = state.imageTranslation;
  const originalAvailable = Boolean(previewUrl);
  const showingTranslated = translatedReady && (!originalAvailable || displayMode === 'translated');
  const imageUrl = showingTranslated ? translatedUrl : previewUrl;
  els.imageModeToggle.hidden = !translatedReady || busy || !originalAvailable;
  els.imageSaveButton.hidden = !translatedReady || busy;
  els.imageRenderStrip.hidden = !translatedReady || busy || !state.devToolsSettings.showControls;
  els.imageBusyIndicator.hidden = !busy || Boolean(error);
  els.imageError.hidden = !error;
  els.imageError.textContent = error || '';
  els.imageOriginalButton.classList.toggle('is-active', !showingTranslated);
  els.imageTranslatedButton.classList.toggle('is-active', showingTranslated);
  els.imageOriginalButton.setAttribute('aria-pressed', showingTranslated ? 'false' : 'true');
  els.imageTranslatedButton.setAttribute('aria-pressed', showingTranslated ? 'true' : 'false');
  if (imageUrl) {
    if (shouldResetScroll) {
      state.imageTranslation.shouldResetScroll = false;
      els.imageDisplayPreview.addEventListener('load', resetImageScrollToImageTop, { once: true });
    }
    els.imageDisplayPreview.src = imageUrl;
    els.imageDisplayPreview.alt = imageAltText({ fileName, showingTranslated });
    els.imageSourceName.textContent = fileName;
    return;
  }
  els.imageDisplayPreview.removeAttribute('src');
  els.imageDisplayPreview.alt = 'Selected image';
  els.imageSourceName.textContent = fileName;
}

function setSelectedImage(file) {
  clearSelectedImage();
  const it = state.imageTranslation;
  it.fileName = String(file.name || 'Selected image');
  it.previewUrl = URL.createObjectURL(file);
  it.translatedUrl = '';
  it.translatedReady = false;
  it.displayMode = 'original';
  it.translatedTargetLanguage = '';
  it.shouldResetScroll = true;
  it.error = '';
  it.busy = true;
  it.requestId = '';
  const token = {};
  it.requestToken = token;
  const previousAppMode = state.appMode;
  state.appMode = APP_MODES.IMAGE_TRANSLATION;
  state.status = 'idle';
  syncImageTranslationHistory(previousAppMode, state.appMode);
  renderLifecycle();
  renderImageTranslation();
  resetImageScrollToImageTop();
  updateActionButtons();
  requestTranslation(file, token);
}

// Source A -> target B (the configured conversation direction). A newly picked
// image supersedes an in-flight one via the request token, so a stale response
// can never overwrite the current selection.
function requestTranslation(file, token) {
  const lane = currentLane();
  const targetLanguage = lane.targetLanguage;
  const operationId = globalThis.crypto.randomUUID();
  rememberOperation(operationId, targetLanguage);
  api.translateImage(file, {
    source: lane.sourceLanguage,
    target: targetLanguage,
    operationId,
    renderOptions: { ...state.imageRender },
  })
    .then((result) => applyImageTranslationResult(result, token, targetLanguage))
    .catch((err) => applyImageTranslationError(err, token));
}

function requestRetranslation(requestId, targetLanguage, token) {
  const operationId = globalThis.crypto.randomUUID();
  rememberOperation(operationId, targetLanguage);
  api.retranslateImage(requestId, {
    target: targetLanguage,
    operationId,
  })
    .then((result) => applyImageTranslationResult(result, token, targetLanguage))
    .catch((err) => applyImageTranslationError(err, token));
}

function applyImageTranslationResult({ blob, requestId }, token, targetLanguage) {
  const it = state.imageTranslation;
  if (it.requestToken !== token) return;
  clearTranslatedImageUrl();
  it.translatedUrl = URL.createObjectURL(blob);
  it.requestId = String(requestId || '');
  requestState = 'completed';
  forgetOperation(it.requestId);
  it.translatedReady = true;
  it.displayMode = 'translated';
  it.translatedTargetLanguage = normalizeLanguageName(targetLanguage);
  it.error = '';
  it.busy = false;
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
}

// A re-render failure keeps the existing translated image (only the render flags changed, the
// translation is unchanged) — so we clear the busy state and surface the error without wiping
// the view. The strip stays visible so the user can adjust and retry.
function applyRerenderError(err, token) {
  const it = state.imageTranslation;
  if (it.requestToken !== token) return;
  if (err?.status && err.status !== 408 && err.status < 500) forgetOperation();
  it.busy = false;
  it.error = String((err && err.message) || 'Re-render failed');
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
}

function applyImageTranslationError(err, token) {
  const it = state.imageTranslation;
  if (it.requestToken !== token) return;
  if (err?.status && err.status !== 408 && err.status < 500) forgetOperation();
  clearTranslatedImageUrl();
  it.translatedReady = false;
  it.displayMode = 'original';
  it.translatedTargetLanguage = '';
  it.error = String((err && err.message) || 'Translation failed');
  it.busy = false;
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
}

async function applyRecoveredEnvelope(envelope, token, targetLanguage) {
  const it = state.imageTranslation;
  if (it.requestToken !== token) return true;
  if (String(envelope?.request_id || '') !== it.requestId) {
    throw new Error('The service returned a different image operation.');
  }
  const nextState = String(envelope?.state || '').toLowerCase();
  requestState = nextState;
  if (nextState === 'completed') {
    const operationId = it.requestId;
    const blob = await api.getImageArtifact(operationId);
    if (it.requestToken !== token || operationId !== it.requestId) return true;
    applyImageTranslationResult({ blob, requestId: operationId }, token, targetLanguage);
    return true;
  }
  if (TERMINAL_STATES.has(nextState)) {
    forgetOperation(it.requestId);
    it.requestId = '';
    it.busy = false;
    it.error = envelope?.error?.message || `Translation ${nextState.replaceAll('_', ' ')}.`;
    renderImageTranslation();
    renderLifecycle();
    updateActionButtons();
    return true;
  }
  it.busy = true;
  it.error = '';
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
  return false;
}

async function pollRecoveredImageOperation(token, targetLanguage) {
  stopRecoveryPolling();
  const it = state.imageTranslation;
  if (it.requestToken !== token || !it.requestId) return;
  try {
    const envelope = await api.getImageRequest(it.requestId);
    if (it.requestToken !== token) return;
    if (await applyRecoveredEnvelope(envelope, token, targetLanguage)) return;
  } catch (err) {
    if (it.requestToken !== token) return;
    if (err?.status === 404 || err?.status === 410) {
      forgetOperation(it.requestId);
      it.requestId = '';
      it.busy = false;
      it.error = 'The previous image translation is no longer available.';
      renderImageTranslation();
      renderLifecycle();
      updateActionButtons();
      return;
    }
    it.error = 'Translation status is temporarily unavailable. Retrying…';
    renderImageTranslation();
  }
  recoveryPollTimer = window.setTimeout(
    () => pollRecoveredImageOperation(token, targetLanguage),
    RECOVERY_POLL_INTERVAL_MS,
  );
}

async function recoverPendingImageOperation(ownerKey) {
  const saved = operationRecovery.load(ownerKey);
  if (!saved) return;
  stopRecoveryPolling();
  clearSelectedImage();
  const it = state.imageTranslation;
  const token = {};
  it.requestToken = token;
  it.fileName = saved.fileName || 'image';
  it.busy = true;
  it.requestId = saved.operationId;
  it.displayMode = 'translated';
  it.translatedTargetLanguage = normalizeLanguageName(saved.targetLanguage);
  pendingOperationId = saved.operationId;
  requestState = '';
  const previousAppMode = state.appMode;
  state.appMode = APP_MODES.IMAGE_TRANSLATION;
  syncImageTranslationHistory(previousAppMode, state.appMode);
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();

  const result = await operationRecovery.recover(ownerKey);
  if (it.requestToken !== token || ownerKey !== activeRecoveryOwnerKey) return;
  if (result.error) {
    if (result.unavailable) {
      it.busy = false;
      it.error = 'The previous image translation is no longer available.';
      renderImageTranslation();
      renderLifecycle();
      updateActionButtons();
    } else {
      it.error = 'Could not restore the translation yet. Retrying…';
      renderImageTranslation();
      recoveryPollTimer = window.setTimeout(
        () => pollRecoveredImageOperation(token, saved.targetLanguage),
        RECOVERY_POLL_INTERVAL_MS,
      );
    }
    return;
  }
  try {
    if (await applyRecoveredEnvelope(result.envelope, token, saved.targetLanguage)) return;
  } catch (err) {
    if (it.requestToken !== token) return;
    if (err?.status === 404 || err?.status === 410) {
      forgetOperation(it.requestId);
      it.requestId = '';
      it.busy = false;
      it.error = err.message || 'The previous image translation is no longer available.';
      renderImageTranslation();
      renderLifecycle();
      updateActionButtons();
      return;
    }
    it.busy = true;
    it.error = 'The translated image is temporarily unavailable. Retrying…';
    renderImageTranslation();
    renderLifecycle();
    updateActionButtons();
    recoveryPollTimer = window.setTimeout(
      () => pollRecoveredImageOperation(token, saved.targetLanguage),
      RECOVERY_POLL_INTERVAL_MS,
    );
    return;
  }
  recoveryPollTimer = window.setTimeout(
    () => pollRecoveredImageOperation(token, saved.targetLanguage),
    RECOVERY_POLL_INTERVAL_MS,
  );
}

function clearSelectedImage() {
  const it = state.imageTranslation;
  if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
  clearTranslatedImageUrl();
  it.fileName = '';
  it.previewUrl = '';
  it.translatedUrl = '';
  it.translatedReady = false;
  it.displayMode = 'original';
  it.translatedTargetLanguage = '';
  it.shouldResetScroll = false;
  it.error = '';
  it.busy = false;
  it.requestId = '';
  it.requestToken = null;
}

function clearTranslatedImageUrl() {
  const it = state.imageTranslation;
  if (it.translatedUrl && it.translatedUrl !== it.previewUrl) {
    URL.revokeObjectURL(it.translatedUrl);
  }
  it.translatedUrl = '';
}

function resetFileInput() {
  if (els.imageFileInput) els.imageFileInput.value = '';
  if (els.cameraFileInput) els.cameraFileInput.value = '';
}

function imageAltText({ fileName, showingTranslated }) {
  const prefix = showingTranslated ? 'Translated image' : 'Selected image';
  return fileName ? `${prefix}: ${fileName}` : prefix;
}

function resetImageScrollToImageTop() {
  const target = els.imageOverlayScrollSpacer.offsetHeight;
  requestAnimationFrame(() => {
    els.imageScrollFrame.scrollTop = target;
    requestAnimationFrame(() => {
      els.imageScrollFrame.scrollTop = target;
    });
  });
}

let _skipImageTranslationHistorySync = false;

function syncImageTranslationHistory(previous, next) {
  if (_skipImageTranslationHistorySync) return;
  if (previous !== APP_MODES.IMAGE_TRANSLATION && next === APP_MODES.IMAGE_TRANSLATION) {
    if (history.state?.view !== 'image_translation') {
      history.pushState({ view: 'image_translation' }, '');
    }
    return;
  }
  if (previous === APP_MODES.IMAGE_TRANSLATION && next !== APP_MODES.IMAGE_TRANSLATION) {
    if (history.state?.view === 'image_translation') {
      history.back();
    }
  }
}

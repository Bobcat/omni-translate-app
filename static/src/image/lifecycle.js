// Image translation UX: local file selection, preview state, the real
// translation request to the backend proxy (`/api/image-translation`), the
// Original/Translated result surface, and returning to setup.

import { state } from '../state.js';
import { APP_MODES } from '../shared/constants.js';
import { els } from '../els.js';
import { api } from '../api-client.js';
import { currentLane } from '../domain/lanes.js';
import { normalizeLanguageName } from '../domain/languages.js';
import { renderLifecycle } from '../ui/render-status.js';
import { updateActionButtons } from '../ui/action-buttons.js';

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

function resetImageTranslationState() {
  clearSelectedImage();
  resetFileInput();
  state.appMode = APP_MODES.SETUP;
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
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
  const showingTranslated = translatedReady && displayMode === 'translated';
  const imageUrl = showingTranslated ? translatedUrl : previewUrl;
  els.imageModeToggle.hidden = !translatedReady || busy;
  els.imageBusyIndicator.hidden = !previewUrl || !busy || Boolean(error);
  els.imageError.hidden = !error;
  els.imageError.textContent = error || '';
  els.imageOriginalButton.classList.toggle('is-active', !showingTranslated);
  els.imageTranslatedButton.classList.toggle('is-active', showingTranslated);
  els.imageOriginalButton.setAttribute('aria-pressed', showingTranslated ? 'false' : 'true');
  els.imageTranslatedButton.setAttribute('aria-pressed', showingTranslated ? 'true' : 'false');
  if (previewUrl) {
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
  els.imageSourceName.textContent = '';
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
  api.translateImage(file, { source: lane.sourceLanguage, target: targetLanguage })
    .then((result) => applyImageTranslationResult(result, token, targetLanguage))
    .catch((err) => applyImageTranslationError(err, token));
}

function requestRetranslation(requestId, targetLanguage, token) {
  api.retranslateImage(requestId, { target: targetLanguage })
    .then((result) => applyImageTranslationResult(result, token, targetLanguage))
    .catch((err) => applyImageTranslationError(err, token));
}

function applyImageTranslationResult({ blob, requestId }, token, targetLanguage) {
  const it = state.imageTranslation;
  if (it.requestToken !== token) return;
  clearTranslatedImageUrl();
  it.translatedUrl = URL.createObjectURL(blob);
  it.requestId = String(requestId || '');
  it.translatedReady = true;
  it.displayMode = 'translated';
  it.translatedTargetLanguage = normalizeLanguageName(targetLanguage);
  it.error = '';
  it.busy = false;
  renderImageTranslation();
  renderLifecycle();
  updateActionButtons();
}

function applyImageTranslationError(err, token) {
  const it = state.imageTranslation;
  if (it.requestToken !== token) return;
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

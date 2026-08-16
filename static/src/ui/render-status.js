// Status-line UI: the app-shell render (setup/live-recording/image class
// toggles, per-element visibility), connection status, language-pill render, mic
// level meter + halo, and the start-button busy flag.

import { state } from '../state.js';
import { els } from '../els.js';
import { APP_MODES, MIC_STATES } from '../shared/constants.js';
import { micHaloVisual } from '../shared/mic-level-visual.js';
import { currentLane } from '../domain/lanes.js';
import { updateActionButtons } from './action-buttons.js';

export function setStatus(status) {
  state.status = String(status || 'idle').toLowerCase();
  renderLifecycle();
  updateActionButtons();
}

export function renderLifecycle() {
  const setup = state.appMode === APP_MODES.SETUP;
  const liveRecording = state.appMode === APP_MODES.LIVE_RECORDING;
  const imageTranslation = state.appMode === APP_MODES.IMAGE_TRANSLATION;
  const micOff = liveRecording && state.micState === MIC_STATES.OFF;
  const micListening = liveRecording && state.micState === MIC_STATES.LISTENING;
  const debugControls = Boolean(state.devToolsSettings.showControls);
  els.app.classList.toggle('is-setup', setup);
  els.app.classList.toggle('is-live-recording', liveRecording);
  els.app.classList.toggle('is-image-translation', imageTranslation);
  els.app.classList.toggle('is-mic-off', micOff);
  els.app.classList.toggle('is-mic-listening', micListening);
  els.setupStartPanel.hidden = !setup;
  els.imageTranslationView.hidden = !imageTranslation;
  els.sourceText.hidden = setup || imageTranslation;
  els.languageDirectionButton.hidden = !(setup || imageTranslation);
  els.translateNowButton.hidden = !(liveRecording && debugControls);
  els.speakNowButton.hidden = !(liveRecording && debugControls);
  els.micToggleButton.hidden = !liveRecording;
  els.pcExportButton.hidden = !(liveRecording && micOff && state.devToolsSettings.showControls);
  els.setupFixtureButton.hidden = !(setup && state.devToolsSettings.showControls);
  els.setupFixtureButton.disabled = state.status === 'connecting' || Boolean(state.fixtureBusy);
  els.startButton.disabled = state.status === 'connecting';
  setImagePickerDisabled(state.status === 'connecting');
  els.settingsStartButton.disabled = state.status === 'connecting' || imageTranslation;
  els.settingsStartButton.textContent = (liveRecording && micListening) ? 'Stop recording' : 'Start recording';
  els.languageDirectionButton.disabled = imageTranslation || !setup || state.status === 'connecting';
  els.languageDirectionButton.setAttribute(
    'aria-label',
    imageTranslation ? 'Detected source language to target language' : 'Switch selected languages',
  );
  els.languageDirectionButton.title = imageTranslation ? 'Detect language to target language' : 'Switch selected languages';
  els.turnModeButton?.classList.toggle('is-active', state.viewMode === 'turn');
  els.turnModeButton?.setAttribute('aria-pressed', state.viewMode === 'turn' ? 'true' : 'false');
  els.conversationModeButton?.classList.toggle('is-active', state.viewMode === 'conversation');
  els.conversationModeButton?.setAttribute('aria-pressed', state.viewMode === 'conversation' ? 'true' : 'false');
  renderLanguageControls();
}

export function setListenBusy(busy) {
  els.startButton.disabled = Boolean(busy);
  setImagePickerDisabled(Boolean(busy));
  els.settingsStartButton.disabled = Boolean(busy);
}

function setImagePickerDisabled(disabled) {
  setPickerControlDisabled(els.setupImageButton, els.imageFileInput, disabled);
  setPickerControlDisabled(els.setupCameraButton, els.cameraFileInput, disabled);
}

function setPickerControlDisabled(control, input, disabled) {
  control.classList.toggle('is-disabled', disabled);
  control.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  if ('disabled' in control) control.disabled = disabled;
  if (input) input.disabled = disabled;
}

export function renderLanguageControls() {
  const lane = currentLane();
  const setup = state.appMode === APP_MODES.SETUP;
  const imageTranslation = state.appMode === APP_MODES.IMAGE_TRANSLATION;
  const isConnecting = state.status === 'connecting';
  const imageBusy = Boolean(state.imageTranslation.busy);
  const canRetranslateImage = imageTranslation && Boolean(state.imageTranslation.requestId) && !imageBusy;
  els.sourceLanguagePillText.textContent = imageTranslation ? 'Detect language' : lane.sourceLanguage;
  els.targetLanguagePillText.textContent = lane.targetLanguage;
  els.sourceLanguagePill.hidden = !(setup || imageTranslation);
  els.targetLanguagePill.hidden = !(setup || imageTranslation);
  els.sourceLanguagePill.disabled = imageTranslation || isConnecting;
  els.targetLanguagePill.disabled = isConnecting || (imageTranslation && !canRetranslateImage);
  els.sourceLanguagePill.setAttribute('aria-label', imageTranslation ? 'Source language: Detect language' : `Source language: ${lane.sourceLanguage}`);
  els.targetLanguagePill.setAttribute('aria-label', `Target language: ${lane.targetLanguage}`);
}

export function renderMicLevel(value) {
  const halo = micHaloVisual(value, { listening: state.micState === MIC_STATES.LISTENING });
  const { level } = halo;
  state.audioSettings.inputLevel = level;
  const percent = Math.round(level * 100);
  els.micLevelFill.style.transform = `scaleX(${level.toFixed(3)})`;
  els.micLevel.setAttribute('aria-valuenow', String(percent));
  els.micLevel.classList.toggle('is-hot', level >= 0.9);
  els.micToggleButton.classList.toggle('is-clip-risk', halo.clipRisk);
  els.micToggleButton.style.setProperty('--mic-toggle-halo-scale', halo.scale);
  els.micToggleButton.style.setProperty('--mic-toggle-halo-color', halo.color);
  els.micToggleButton.style.boxShadow = '';
}

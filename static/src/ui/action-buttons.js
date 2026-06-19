// Action-bar buttons (translate-now, speak-now, mic-toggle, pc-export, swap).
// updateActionButtons fans out to per-button updaters; each updater reads
// state directly and writes the matching els.* button's disabled/aria/title.

import { state } from '../state.js';
import { els } from '../els.js';
import { APP_MODES, MIC_STATES, TURN_STATES } from '../shared/constants.js';
import { audioQueue } from '../session/audio-queue.js';
import { renderLanguageControls } from './render-status.js';

export function updateActionButtons() {
  updateTranslateNowButton();
  updateSpeakNowButton();
  updateMicToggleButton();
  updatePcExportButton();
  updateSwapButton();
  renderLanguageControls();
}

function updateTranslateNowButton() {
  const turnIsSpeaking = state.currentTurn.state === TURN_STATES.OPEN_SPEAKING;
  const live = state.appMode === APP_MODES.LIVE_RECORDING && state.socket?.isOpen();
  const debugControls = Boolean(state.devToolsSettings.showControls);
  els.translateNowButton.disabled = !(debugControls && live && state.currentTurn.canTranslateNow && !turnIsSpeaking);
}

function updateSwapButton() {
  const live = state.appMode === APP_MODES.LIVE_RECORDING && state.socket?.isOpen();
  els.swapButton.disabled = !live;
}

function updateSpeakNowButton() {
  const turnIsSpeaking = state.currentTurn.state === TURN_STATES.OPEN_SPEAKING;
  const live = state.appMode === APP_MODES.LIVE_RECORDING && state.socket?.isOpen();
  const debugControls = Boolean(state.devToolsSettings.showControls);
  const canSpeakTarget = Boolean(debugControls && live && state.currentTurn.speakableTargetText && !turnIsSpeaking);
  const canPlayAudio = Boolean(debugControls && live && audioQueue?.hasNonReplayAudio());
  els.speakNowButton.disabled = state.speakNowPending || !(canSpeakTarget || canPlayAudio);
  els.speakNowButton.classList.toggle('is-busy', turnIsSpeaking);
  let label = 'Speak now';
  if (canPlayAudio && state.audioStatus.startsWith('Playing')) {
    label = 'Playing';
  } else if (canPlayAudio) {
    label = 'Play audio';
  }
  els.speakNowButton.setAttribute('aria-label', label);
  els.speakNowButton.title = label;
}

function updateMicToggleButton() {
  const live = state.appMode === APP_MODES.LIVE_RECORDING && state.socket?.isOpen();
  const micListening = state.micState === MIC_STATES.LISTENING;
  const micOff = state.micState === MIC_STATES.OFF;
  const enabled = live && (micListening || micOff) && state.status !== 'connecting';
  els.micToggleButton.disabled = !enabled;
  els.micToggleButton.classList.toggle('is-mic-listening-action', micListening);
  els.micToggleButton.classList.toggle('is-mic-on-action', micOff);
  const label = micListening ? 'Turn microphone off' : 'Turn microphone on';
  els.micToggleButton.setAttribute('aria-label', label);
  els.micToggleButton.title = micListening ? 'Mic off' : 'Mic on';
}

function updatePcExportButton() {
  const canExport = state.appMode === APP_MODES.LIVE_RECORDING
    && state.micState === MIC_STATES.OFF
    && Boolean(state.sessionId)
    && !state.pcExportBusy;
  els.pcExportButton.disabled = !canExport;
  els.pcExportButton.setAttribute('aria-label', state.pcExportBusy ? 'Exporting PC transcript' : 'Export PC transcript');
  els.pcExportButton.title = state.pcExportBusy ? 'Exporting PC' : 'Export PC';
}

// User-initiated session actions: speak-now (with pending-flash timer),
// translate-now, lane swap during a session, and the setup-time language
// swap / single-side language pick.

import { state } from '../state.js';
import {
  SESSION_STATES,
  MIC_STATES,
  TURN_STATES,
} from '../shared/constants.js';
import {
  buildLocalLanes,
  createLocalTurn,
  currentLaneId,
} from '../domain/lanes.js';
import { normalizeLanguageName } from '../domain/languages.js';
import { renderLanguageControls } from '../ui/render-status.js';
import { updateActionButtons } from '../ui/action-buttons.js';
import { renderTtsSettings } from '../settings/tts.js';
import { renderTranscript } from '../ui/render-turn.js';
import { audioQueue } from './audio-queue.js';
import { stopMicrophoneCapture } from './lifecycle.js';

export function speakNow() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (audioQueue.hasNonReplayAudio()) {
    audioQueue.playOrResume();
    return;
  }
  if (state.currentTurn.speakableTargetText && state.currentTurn.state !== TURN_STATES.OPEN_SPEAKING && state.socket?.speakNow()) {
    state.speakNowPending = true;
    state.speakInflightFilter = {
      turnId: String(state.currentTurn.turnId || ''),
      knownPartIds: new Set(
        (state.currentTurn.parts || [])
          .map((part) => String(part.partId || ''))
          .filter(Boolean),
      ),
    };
    if (state.speakNowPendingTimer) clearTimeout(state.speakNowPendingTimer);
    state.speakNowPendingTimer = setTimeout(() => {
      state.speakNowPending = false;
      state.speakNowPendingTimer = null;
      state.speakInflightFilter = null;
      updateActionButtons();
    }, 1500);
    if (state.micState === MIC_STATES.LISTENING) {
      stopMicrophoneCapture();
    }
    updateActionButtons();
  }
}

export function clearSpeakNowPending() {
  if (!state.speakNowPending && !state.speakNowPendingTimer) return;
  state.speakNowPending = false;
  if (state.speakNowPendingTimer) {
    clearTimeout(state.speakNowPendingTimer);
    state.speakNowPendingTimer = null;
  }
}

export function translateNow() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (!state.currentTurn.canTranslateNow) return;
  state.socket?.translateNow();
}

export function swapDirection() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (!state.socket?.isOpen()) return;
  const nextLaneId = currentLaneId() === 'a_to_b' ? 'b_to_a' : 'a_to_b';
  audioQueue.clear();
  state.socket.nextTurn(nextLaneId);
}

export function setVisibleLanguage(role, value) {
  if (state.sessionState !== SESSION_STATES.SETUP) return;
  const next = normalizeLanguageName(value);
  if (currentLaneId() === 'a_to_b') {
    if (role === 'source') state.sideALanguage = next;
    else state.sideBLanguage = next;
  } else if (role === 'source') {
    state.sideBLanguage = next;
  } else {
    state.sideALanguage = next;
  }
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  state.currentTurn = createLocalTurn(currentLaneId(), state.lanes);
  renderLanguageControls();
  renderTranscript();
  renderTtsSettings();
  updateActionButtons();
}

export function swapSetupLanguages() {
  if (state.sessionState !== SESSION_STATES.SETUP) return;
  const previousSideA = state.sideALanguage;
  state.sideALanguage = state.sideBLanguage;
  state.sideBLanguage = previousSideA;
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  state.currentTurn = createLocalTurn(currentLaneId(), state.lanes);
  renderLanguageControls();
  renderTranscript();
  renderTtsSettings();
  updateActionButtons();
}

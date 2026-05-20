// Mic auto-off logic: timer driven by backend VAD signals, plus an
// imperative trigger for the bubble-close case. Owns the single
// authoritative path that stops the mic and plays the cue, so other
// modules just call into here.
//
// Lifecycle.js wires the actual stopMicrophoneCapture callback via
// registerMicAutoOffStopHandler to avoid a circular import.

import { state } from '../state.js';
import { MIC_STATES, SESSION_STATES, TURN_STATES } from '../shared/constants.js';
import { playMicAutoOffCue } from '../shared/audio-cue.js';

let _stopMicCallback = null;

export function registerMicAutoOffStopHandler(fn) {
  _stopMicCallback = typeof fn === 'function' ? fn : null;
}

export function armAutoOffSilenceTimer() {
  clearAutoOffSilenceTimer();
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (state.micState !== MIC_STATES.LISTENING) return;
  if (state.currentTurn?.state === TURN_STATES.OPEN_SPEAKING) return;
  const seconds = Number(state.audioSettings.autoOffSilenceSeconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  state.autoOffSilenceTimer = setTimeout(() => {
    state.autoOffSilenceTimer = null;
    performMicAutoOff('silence');
  }, Math.round(seconds * 1000));
}

export function clearAutoOffSilenceTimer() {
  if (state.autoOffSilenceTimer) {
    clearTimeout(state.autoOffSilenceTimer);
    state.autoOffSilenceTimer = null;
  }
}

export function performMicAutoOff(reason) {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (state.micState !== MIC_STATES.LISTENING) return;
  clearAutoOffSilenceTimer();
  if (state.audioSettings.autoOffCueEnabled) {
    try {
      playMicAutoOffCue();
    } catch {
      // ignore — cue is best-effort
    }
  }
  if (typeof _stopMicCallback === 'function') {
    _stopMicCallback(reason);
  }
}

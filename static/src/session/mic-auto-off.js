// Mic auto-off logic: timer driven by backend VAD signals, plus an
// imperative trigger for the bubble-close case. Owns the single
// authoritative path that stops the mic and plays the cue, so other
// modules just call into here.
//
// Lifecycle.js wires the actual stopMicrophoneCapture callback via
// registerMicAutoOffStopHandler to avoid a circular import.

import { state } from '../state.js';
import { MIC_STATES, APP_MODES, TURN_STATES } from '../shared/constants.js';

let _stopMicCallback = null;

export function registerMicAutoOffStopHandler(fn) {
  _stopMicCallback = typeof fn === 'function' ? fn : null;
}

export function armAutoOffSilenceTimer() {
  clearAutoOffSilenceTimer();
  if (state.appMode !== APP_MODES.LIVE_RECORDING) return;
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
  if (state.appMode !== APP_MODES.LIVE_RECORDING) return;
  if (state.micState !== MIC_STATES.LISTENING) return;
  clearAutoOffSilenceTimer();
  // The stop handler (lifecycle.stopMicrophoneCapture) plays the
  // off-cue itself so manual stops and auto-stops sound identical.
  if (typeof _stopMicCallback === 'function') {
    _stopMicCallback(reason);
  }
}

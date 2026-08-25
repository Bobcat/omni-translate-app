// Mic auto-off logic: timer driven by backend VAD signals, plus an
// imperative trigger for the bubble-close case. Owns the single
// authoritative path that stops the mic and plays the cue, so other
// modules just call into here.
//
// Lifecycle.js wires the actual stopMicrophoneCapture callback via
// registerMicAutoOffStopHandler to avoid a circular import.

import { state } from '../state.js';
import { MIC_STATES, APP_MODES, TURN_STATES } from '../shared/constants.js';
import { createMicAutoOffController } from '../shared/mic-auto-off-controller.js';

let _stopMicCallback = null;

const controller = createMicAutoOffController({
  getSnapshot: () => ({
    active: state.appMode === APP_MODES.LIVE_RECORDING,
    listening: state.micState === MIC_STATES.LISTENING,
    speaking: state.currentTurn?.state === TURN_STATES.OPEN_SPEAKING,
    silenceSeconds: state.audioSettings.autoOffSilenceSeconds,
    autoOffAfterBubble: state.audioSettings.autoOffAfterBubble,
  }),
  stopMicrophone: (reason) => _stopMicCallback?.(reason),
  onTimerChange: (timer) => {
    state.autoOffSilenceTimer = timer;
  },
});

export function registerMicAutoOffStopHandler(fn) {
  _stopMicCallback = typeof fn === 'function' ? fn : null;
}

export function armAutoOffSilenceTimer() {
  controller.arm();
}

export function clearAutoOffSilenceTimer() {
  controller.clear();
}

export function performMicAutoOff(reason) {
  // The stop handler (lifecycle.stopMicrophoneCapture) plays the
  // off-cue itself so manual stops and auto-stops sound identical.
  controller.stop(reason);
}

export function handleMicAutoOffTurnUpdate(previousState, nextState, reason) {
  controller.handleTurnUpdate(previousState, nextState, reason);
}

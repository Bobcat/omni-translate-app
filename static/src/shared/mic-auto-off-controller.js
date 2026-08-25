// State-independent microphone auto-off timing shared by both frontends.

import { TURN_STATES } from './constants.js';

const NATURAL_BUBBLE_CLOSE_REASONS = new Set([
  'bubble_close:sentence_boundary',
  'bubble_close:vad_silence',
]);

export function createMicAutoOffController({
  getSnapshot,
  stopMicrophone,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel = (timer) => clearTimeout(timer),
  onTimerChange,
}) {
  let timer = null;

  function snapshot() {
    return getSnapshot?.() || {};
  }

  function setTimer(next) {
    timer = next;
    onTimerChange?.(next);
  }

  function clear() {
    if (timer === null) return;
    cancel(timer);
    setTimer(null);
  }

  function stop(reason) {
    const current = snapshot();
    if (!current.active || !current.listening) return false;
    clear();
    stopMicrophone?.(reason);
    return true;
  }

  function arm() {
    clear();
    const current = snapshot();
    const seconds = Number(current.silenceSeconds || 0);
    if (!current.active || !current.listening || current.speaking) return false;
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const next = schedule(() => {
      setTimer(null);
      stop('silence');
    }, Math.round(seconds * 1000));
    setTimer(next);
    return true;
  }

  function handleTurnUpdate(previousState, nextState, reason) {
    if (previousState !== nextState) {
      if (nextState === TURN_STATES.OPEN_SPEAKING) {
        clear();
      } else if (previousState === TURN_STATES.OPEN_SPEAKING) {
        arm();
      }
    }
    if (snapshot().autoOffAfterBubble && NATURAL_BUBBLE_CLOSE_REASONS.has(reason)) {
      stop('bubble_close');
    }
  }

  return {
    arm,
    clear,
    stop,
    isArmed: () => timer !== null,
    handleTurnUpdate,
  };
}

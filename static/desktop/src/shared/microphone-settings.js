// Page-lifetime microphone settings and runtime status shared by Settings and Voice.

import {
  AUTO_OFF_SILENCE_CHOICES,
  DEFAULT_AUDIO_SETTINGS,
} from '../../../src/shared/constants.js';
import { normalizeMicLevel } from '../../../src/shared/mic-level-visual.js';

const listeners = new Set();

let current = initialState();

function initialState() {
  return {
    ...DEFAULT_AUDIO_SETTINGS,
    captureBusy: false,
    inputLevel: 0,
    listening: false,
  };
}

function snapshot() {
  return { ...current };
}

function publish(previous, source) {
  const next = snapshot();
  const changed = new Set(
    Object.keys(next).filter((key) => !Object.is(previous[key], next[key])),
  );
  if (!changed.size) return next;
  for (const listener of listeners) {
    listener({ previous, next, changed, source });
  }
  return next;
}

export function getDesktopMicrophoneState() {
  return snapshot();
}

export function setDesktopMicrophoneSettings(partial, { source = 'settings' } = {}) {
  const previous = snapshot();
  const next = { ...current };
  if (Object.hasOwn(partial, 'preGain')) {
    next.preGain = normalizePreGain(partial.preGain, current.preGain);
  }
  if (Object.hasOwn(partial, 'autoGainControl')) {
    next.autoGainControl = Boolean(partial.autoGainControl);
  }
  if (Object.hasOwn(partial, 'autoOffSilenceSeconds')) {
    const seconds = Number(partial.autoOffSilenceSeconds);
    next.autoOffSilenceSeconds = AUTO_OFF_SILENCE_CHOICES.includes(seconds)
      ? seconds
      : current.autoOffSilenceSeconds;
  }
  if (Object.hasOwn(partial, 'autoOffAfterBubble')) {
    next.autoOffAfterBubble = Boolean(partial.autoOffAfterBubble);
  }
  if (Object.hasOwn(partial, 'autoOffCueEnabled')) {
    next.autoOffCueEnabled = Boolean(partial.autoOffCueEnabled);
  }
  current = next;
  return publish(previous, source);
}

export function resetDesktopMicrophoneSettings() {
  return setDesktopMicrophoneSettings(DEFAULT_AUDIO_SETTINGS);
}

export function setDesktopMicrophoneRuntime(partial) {
  const previous = snapshot();
  const next = { ...current };
  if (Object.hasOwn(partial, 'captureBusy')) {
    next.captureBusy = Boolean(partial.captureBusy);
  }
  if (Object.hasOwn(partial, 'inputLevel')) {
    next.inputLevel = normalizeMicLevel(partial.inputLevel);
  }
  if (Object.hasOwn(partial, 'listening')) {
    next.listening = Boolean(partial.listening);
  }
  current = next;
  return publish(previous, 'runtime');
}

export function subscribeDesktopMicrophoneState(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function normalizePreGain(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Number(Math.max(0.5, Math.min(3, numeric)).toFixed(1));
}

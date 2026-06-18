// Audio settings subpage: pre-gain slider, AGC toggle, reset-to-defaults.
// AGC toggle and reset trigger a microphone restart, which lives in
// session/lifecycle.js — imported here.

import { state } from '../state.js';
import { els } from '../els.js';
import {
  APP_MODES,
  MIC_STATES,
  DEFAULT_AUDIO_SETTINGS,
  AUTO_OFF_SILENCE_CHOICES,
} from '../shared/constants.js';
import { renderMicLevel } from '../ui/render-status.js';
import { restartMicrophoneCapture } from '../session/lifecycle.js';
import {
  armAutoOffSilenceTimer,
  clearAutoOffSilenceTimer,
} from '../session/mic-auto-off.js';

export function renderAudioSettings() {
  els.micPreGain.value = String(state.audioSettings.preGain);
  const preGainLabel = `${state.audioSettings.preGain.toFixed(1)}x`;
  els.micPreGainValue.textContent = preGainLabel;
  els.micSettingsSummary.textContent = state.audioSettings.autoGainControl ? `${preGainLabel}, AGC` : preGainLabel;
  els.micAutoGainControl.checked = state.audioSettings.autoGainControl;
  const agcAvailable = state.appMode === APP_MODES.SETUP
    || state.appMode === APP_MODES.LIVE_RECORDING;
  els.micAutoGainControl.disabled = state.audioSettings.autoGainControlBusy || !agcAvailable;
  els.audioSettingsReset.disabled = state.audioSettings.autoGainControlBusy;
  if (els.micAutoOffSilence) {
    els.micAutoOffSilence.value = String(state.audioSettings.autoOffSilenceSeconds);
  }
  if (els.micAutoOffAfterBubble) {
    els.micAutoOffAfterBubble.checked = Boolean(state.audioSettings.autoOffAfterBubble);
  }
  if (els.micAutoOffCue) {
    els.micAutoOffCue.checked = Boolean(state.audioSettings.autoOffCueEnabled);
  }
  renderMicLevel(state.audioSettings.inputLevel);
}

export function handleAutoOffSilenceChange() {
  const raw = Number(els.micAutoOffSilence?.value);
  const next = AUTO_OFF_SILENCE_CHOICES.includes(raw) ? raw : DEFAULT_AUDIO_SETTINGS.autoOffSilenceSeconds;
  state.audioSettings.autoOffSilenceSeconds = next;
  if (next > 0 && state.micState === MIC_STATES.LISTENING) {
    armAutoOffSilenceTimer();
  } else {
    clearAutoOffSilenceTimer();
  }
  renderAudioSettings();
}

export function handleAutoOffAfterBubbleChange() {
  state.audioSettings.autoOffAfterBubble = Boolean(els.micAutoOffAfterBubble?.checked);
  renderAudioSettings();
}

export function handleAutoOffCueChange() {
  state.audioSettings.autoOffCueEnabled = Boolean(els.micAutoOffCue?.checked);
  renderAudioSettings();
}

export function handlePreGainInput() {
  state.audioSettings.preGain = normalizePreGain(els.micPreGain.value);
  state.capture?.setPreGain(state.audioSettings.preGain);
  renderAudioSettings();
}

export async function handleAutoGainControlChange() {
  const requested = Boolean(els.micAutoGainControl.checked);
  if (state.appMode === APP_MODES.SETUP
    || (state.appMode === APP_MODES.LIVE_RECORDING && state.micState === MIC_STATES.OFF)) {
    state.audioSettings.autoGainControl = requested;
    renderAudioSettings();
    return;
  }
  if (state.appMode !== APP_MODES.LIVE_RECORDING || !state.capture) {
    renderAudioSettings();
    return;
  }
  state.audioSettings.autoGainControl = requested;
  await restartMicrophoneCapture();
}

export async function resetAudioSettings() {
  // Brief tap-flash. Button isn't re-rendered by reset so we remove it
  // ourselves; see tts.js for the rerender-driven variant.
  els.audioSettingsReset?.classList.add('is-flashing');
  setTimeout(() => els.audioSettingsReset?.classList.remove('is-flashing'), 140);
  state.audioSettings.preGain = DEFAULT_AUDIO_SETTINGS.preGain;
  state.audioSettings.autoOffSilenceSeconds = DEFAULT_AUDIO_SETTINGS.autoOffSilenceSeconds;
  state.audioSettings.autoOffAfterBubble = DEFAULT_AUDIO_SETTINGS.autoOffAfterBubble;
  state.audioSettings.autoOffCueEnabled = DEFAULT_AUDIO_SETTINGS.autoOffCueEnabled;
  state.capture?.setPreGain(state.audioSettings.preGain);
  if (state.micState === MIC_STATES.LISTENING) {
    armAutoOffSilenceTimer();
  } else {
    clearAutoOffSilenceTimer();
  }
  if (state.appMode === APP_MODES.LIVE_RECORDING && state.capture) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
    await restartMicrophoneCapture();
    return;
  }
  if (state.appMode !== APP_MODES.LIVE_RECORDING) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
  } else if (state.micState === MIC_STATES.OFF) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
  }
  renderAudioSettings();
}

function normalizePreGain(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0.5, Math.min(3.0, numeric)) : 1;
}

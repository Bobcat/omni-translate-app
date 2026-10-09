// Mobile voice options: the voice that speaks translations, whether they speak
// automatically, and what the speaker clone is doing. The rules are shared with
// the desktop voice session (domain/voice-selection.js); this module owns the
// mobile state, persistence and the websocket updates.

import { state } from '../state.js';
import {
  loadAutoSpeakPreference,
  loadVoiceModePreference,
  persistAutoSpeakPreference,
  persistVoiceModePreference,
} from '../domain/storage.js';
import {
  DEFAULT_VOICE_MODE,
  normalizeVoiceMode,
  voiceCloningStatusFromMessage,
  voiceFallbackModeFor,
  voiceModeSelectionStatus,
} from '../domain/voice-selection.js';
import { LANE_IDS } from '../shared/constants.js';

/** Called when a message carries voice state that the open sheet also shows. */
let _onChange = null;

let _options = {
  mode: DEFAULT_VOICE_MODE,
  fallbackMode: DEFAULT_VOICE_MODE,
  available: false,
  cloningStatus: {},
};

export function configureVoiceOptions({ available = false, onChange = null } = {}) {
  _options.available = Boolean(available);
  _onChange = typeof onChange === 'function' ? onChange : null;
  // The stored preference outlives a reload, like the desktop choice; without
  // one the session default stands.
  const stored = loadAutoSpeakPreference();
  if (stored !== null) state.ttsSettings.auto_speak = stored;
}

/** The control is only offered while the active TTS backend supports modes. */
export function voiceModeAvailable() {
  return _options.available;
}

export function voiceMode() {
  return _options.mode;
}

export function voiceCloningStatus() {
  return _options.cloningStatus;
}

export function autoSpeak() {
  return Boolean(state.ttsSettings.auto_speak);
}

/** The mode a new session starts with. */
export function sessionVoiceMode() {
  return _options.mode;
}

function notify() {
  if (_onChange) _onChange();
}

/**
 * Apply the mode, whether or not a session is live: the socket carries it when
 * one is, and the stored choice decides the next session otherwise.
 */
export function setVoiceMode(mode) {
  if (!_options.available) return;
  const previousMode = _options.mode;
  const normalized = normalizeVoiceMode(mode);
  _options.fallbackMode = voiceFallbackModeFor(_options.fallbackMode, mode, previousMode);
  _options.mode = normalized;
  persistVoiceModePreference(normalized);
  for (const laneId of LANE_IDS) {
    _options.cloningStatus[laneId] = voiceModeSelectionStatus(
      normalized,
      _options.fallbackMode,
      previousMode,
    );
  }
  if (state.socket?.isOpen?.()) state.socket.updateVoiceMode(normalized);
  notify();
}

/** Automatic speaking is a per-session choice once a session is live. */
export function setAutoSpeak(enabled) {
  const next = Boolean(enabled);
  state.ttsSettings.auto_speak = next;
  persistAutoSpeakPreference(next);
  if (state.socket?.isOpen?.()) state.socket.updateTtsSettings({ auto_speak: next });
  notify();
}

/** The `ready` payload: the server's mode and per-lane cloning status win. */
export function applyVoiceSessionReady(msg) {  _options.mode = normalizeVoiceMode(msg?.voice_mode ?? _options.mode);
  _options.fallbackMode = voiceFallbackModeFor('female', _options.mode);
  const statuses = {};
  for (const laneId of LANE_IDS) {
    const entry = msg?.voice_cloning_status?.[laneId];
    if (entry) statuses[laneId] = voiceCloningStatusFromMessage(entry, _options.fallbackMode);
  }
  _options.cloningStatus = statuses;
  notify();
}

/** A `voice_cloning_status` event for one lane. */
export function applyVoiceCloningStatusMessage(msg) {
  const laneId = String(msg?.lane_id || '');
  if (!LANE_IDS.includes(laneId)) return;
  _options.cloningStatus[laneId] = voiceCloningStatusFromMessage(msg, _options.fallbackMode);
  notify();
}

/** A `voice_mode_settings` echo confirms a change made here or elsewhere. */
export function applyVoiceModeSettingsMessage(msg) {
  const mode = normalizeVoiceMode(msg?.mode ?? _options.mode);
  if (mode === _options.mode) return;
  _options.mode = mode;
  notify();
}

/** The stored preference, normalized: what a fresh app load starts from. */
export function storedVoiceMode() {
  return normalizeVoiceMode(loadVoiceModePreference());
}

/** Drop session state: the clone status and the mode both come from storage
 * again, so the next session starts from the user's stored choice. */
export function resetVoiceOptions() {
  _options.cloningStatus = {};
  _options.mode = storedVoiceMode();
  _options.fallbackMode = voiceFallbackModeFor(DEFAULT_VOICE_MODE, _options.mode);
  notify();
}

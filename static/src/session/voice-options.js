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
import { ttsSupportsVoiceSelection } from '../settings/tts.js';
import { LANE_IDS } from '../shared/constants.js';

/** Called when a message carries voice state that the open sheet also shows. */
let _onChange = null;
/** The shared audio queue, so enabling automatic speaking unlocks playback
 *  inside the user's tap. Mirrors the existing controls in settings/tts.js. */
let _audioQueue = null;
/**
 * Automatic speaking that the user changed and the server has not confirmed.
 * `value` is what the user last chose, so the control keeps showing it while
 * echoes are outstanding; `count` is how many echoes that takes. A repeated
 * value makes an older echo indistinguishable from a newer one, which is why
 * the count is tracked rather than the value alone.
 */
let _pendingAutoSpeak = null;

let _options = {
  mode: DEFAULT_VOICE_MODE,
  fallbackMode: DEFAULT_VOICE_MODE,
  cloningStatus: {},
};

export function configureVoiceOptions({ onChange = null, audioQueue = null } = {}) {
  _onChange = typeof onChange === 'function' ? onChange : null;
  if (audioQueue) _audioQueue = audioQueue;
  // The stored preferences outlive a reload, exactly like the desktop choice;
  // without them the session defaults stand.
  const stored = loadAutoSpeakPreference();
  if (stored !== null) state.ttsSettings.auto_speak = stored;
  resetVoiceOptions();
}

/**
 * Whether the modes can be offered right now. This follows the settings that
 * are actually submitted with a session, not just the startup capability: the
 * backend can be switched independently of the advertised default.
 */
export function voiceModeAvailable() {
  return ttsSupportsVoiceSelection();
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

/**
 * The mode a new session should start with, or null when the effective backend
 * cannot select one. The server rejects an explicit mode it cannot honour, so
 * an unavailable mode must be omitted rather than sent as the default.
 */
export function sessionVoiceMode() {
  return voiceModeAvailable() ? _options.mode : null;
}

function notify() {
  if (_onChange) _onChange();
}

/** Re-render whatever shows voice state, after an authoritative server update. */
export function notifyVoiceOptionsChanged() {
  notify();
}

/**
 * Apply the mode, whether or not a session is live: the socket carries it when
 * one is, and the stored choice decides the next session otherwise.
 */
export function setVoiceMode(mode) {
  if (!voiceModeAvailable()) return;
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
  const wasOn = Boolean(state.ttsSettings.auto_speak);
  state.ttsSettings.auto_speak = next;
  _pendingAutoSpeak = {
    value: next,
    count: (_pendingAutoSpeak?.count || 0) + 1,
  };
  persistAutoSpeakPreference(next);
  // Unlock playback inside the tap that turned it on, as the other two
  // automatic-speaking controls do.
  if (next && !wasOn) _audioQueue?.preparePcmPlayback?.();
  notify();
}

/** The `ready` payload: the server's mode and per-lane cloning status win. */
export function applyVoiceSessionReady(msg) {
  _options.mode = normalizeVoiceMode(msg?.voice_mode ?? _options.mode);
  _options.fallbackMode = voiceFallbackModeFor('female', _options.mode);
  const statuses = {};
  for (const laneId of LANE_IDS) {
    const entry = msg?.voice_cloning_status?.[laneId];
    if (entry) statuses[laneId] = voiceCloningStatusFromMessage(entry, _options.fallbackMode);
  }
  _options.cloningStatus = statuses;
  notify();
}

/**
 * Apply a `tts_settings` snapshot from the server. While a change of our own is
 * still waiting for its echo, an older snapshot is ignored for that field, so
 * the control cannot flip back in front of the user.
 */
export function applyTtsSettingsEcho(settings = {}) {
  const snapshot = settings && typeof settings === 'object' ? settings : {};
  const pending = _pendingAutoSpeak;
  if (pending && typeof snapshot.auto_speak === 'boolean') {
    // While echoes are outstanding the user's latest choice is what the control
    // shows: an echo can only answer an older tap, whatever value it carries.
    delete snapshot.auto_speak;
    pending.count -= 1;
    _pendingAutoSpeak = pending.count > 0 ? pending : null;
  }
  return snapshot;
}

/**
 * A rejected update leaves nothing outstanding: the server's next snapshot
 * becomes authoritative for the field again.
 */
export function applyTtsSettingsRejection() {
  _pendingAutoSpeak = null;
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

/** Drop session state: the clone status clears and the mode comes from storage
 * again, so the next session starts from the user's stored choice. */
export function resetVoiceOptions() {
  // A session that ended cannot deliver the echoes any more.
  _pendingAutoSpeak = null;
  _options.cloningStatus = {};
  _options.mode = storedVoiceMode();
  _options.fallbackMode = voiceFallbackModeFor(DEFAULT_VOICE_MODE, _options.mode);
  notify();
}

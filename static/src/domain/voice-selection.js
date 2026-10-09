// Product voice choices for translated speech, plus the state rules that decide
// which voice actually speaks. Shared by both frontends: the UI differs, the
// behaviour does not. The backend mirrors these values in app/voice/mode.py.

export const VOICE_MODE_FEMALE = 'female';
export const VOICE_MODE_MALE = 'male';
export const VOICE_MODE_SPEAKER_CLONE = 'speaker_clone';

/** Voices that are always available, and the fallback while cloning prepares. */
export const STABLE_VOICE_MODES = [VOICE_MODE_FEMALE, VOICE_MODE_MALE];

export const VOICE_MODES = [...STABLE_VOICE_MODES, VOICE_MODE_SPEAKER_CLONE];

export const DEFAULT_VOICE_MODE = VOICE_MODE_FEMALE;

const STABLE = new Set(STABLE_VOICE_MODES);
const ALL = new Set(VOICE_MODES);

/** A stored or requested mode, or null when it is not one of the product modes. */
export function voiceModeOrNull(mode) {
  const value = String(mode ?? '').trim().toLowerCase();
  return ALL.has(value) ? value : null;
}

/** A stored or requested mode, with unknown values resolving to the default. */
export function normalizeVoiceMode(mode) {
  return voiceModeOrNull(mode) ?? DEFAULT_VOICE_MODE;
}

/**
 * The voice that speaks while the speaker clone still collects speech. It only
 * ever names a stable voice: choosing a stable mode makes it the fallback, and
 * choosing the clone keeps the previous fallback.
 */
export function voiceFallbackModeFor(currentFallback, mode) {
  const selected = voiceModeOrNull(mode);
  if (selected && STABLE.has(selected)) return selected;
  const previous = voiceModeOrNull(currentFallback);
  return previous && STABLE.has(previous) ? previous : DEFAULT_VOICE_MODE;
}

/** The cloning status a lane carries for a freshly selected mode. */
export function voiceModeSelectionStatus(mode, fallbackVoiceMode, reason = 'insufficient_clear_speech') {
  const cloning = mode === VOICE_MODE_SPEAKER_CLONE;
  return {
    state: cloning ? 'preparing' : 'off',
    reason: cloning ? String(reason || '') : 'disabled',
    fallbackVoiceMode: voiceFallbackModeFor(fallbackVoiceMode, mode),
  };
}

/** A `voice_cloning_status` websocket message for one lane, in local shape. */
export function voiceCloningStatusFromMessage(message, fallbackVoiceMode) {
  const fallback = voiceModeOrNull(fallbackVoiceMode);
  return {
    state: String(message?.state || 'off'),
    reason: String(message?.reason || ''),
    fallbackVoiceMode: String(
      message?.fallback_voice_mode
        || (fallback && STABLE.has(fallback) ? fallback : DEFAULT_VOICE_MODE),
    ),
  };
}

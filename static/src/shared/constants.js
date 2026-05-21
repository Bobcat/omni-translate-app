// Cross-domain constants. TTS-specific defaults (VOXCPM2_*) intentionally
// stay in app.js for now; they'll move with the TTS-settings extract.

export const LANE_IDS = ['a_to_b', 'b_to_a'];

export const TURN_STATES = {
  OPEN_EMPTY: 'open_empty',
  OPEN_ACTIVE_UNSPOKEN: 'open_active_unspoken',
  OPEN_SPEAKING: 'open_speaking',
  OPEN_SPOKEN_IDLE: 'open_spoken_idle',
};

export const SESSION_STATES = {
  SETUP: 'setup',
  RUNNING: 'running',
};

export const MIC_STATES = {
  LISTENING: 'listening',
  OFF: 'off',
};

export const DEFAULT_AUDIO_SETTINGS = {
  preGain: 1.5,
  autoGainControl: true,
  // Auto-off the mic after N seconds without backend-detected speech.
  // 0 disables the silence-trigger. Choices in the UI:
  // 3 / 5 / 10 / 15 / 30 / 60 / 0(off).
  autoOffSilenceSeconds: 10,
  // Auto-off the mic right after a bubble closes on a heuristic
  // (sentence boundary or VAD silence). Not on the hard duration cap.
  autoOffAfterBubble: false,
  // Subtle Web Audio chirp when the app auto-stops the mic.
  autoOffCueEnabled: true,
};

export const AUTO_OFF_SILENCE_CHOICES = [3, 5, 10, 15, 30, 60, 0];

export const DEFAULT_TUNING_SETTINGS = {
  timing: { emit_min_ms: 120 },
  asr: {
    backend: 'whisperx',
    beam_size: 5,
    chunk_size: 10,
    chunk_length: null,
    vad_filter: true,
    align_enabled: false,
    diarize_enabled: false,
    word_timestamps: null,
  },
  rolling: {
    min_infer_audio_ms: 500,
    single_segment_commit_min_ms: 12000,
    force_commit_repeats: 3,
    max_uncommitted_ms: 30000,
    hard_clip_keep_tail_ms: 5000,
    max_decode_window_ms: 12000,
    buffer_trim_threshold_ms: 30000,
    buffer_trim_drop_ms: 20000,
    min_new_audio_ms: 500,
    pacing: {
      base_emit_ms: 250,
      startup: {
        duration_ms: 1200,
        emit_ms: 100,
        min_infer_audio_ms: 250,
        min_new_audio_ms: 200,
      },
    },
    vad: {
      enabled: false,
      threshold: 0.35,
      max_speech_duration_s: 12,
      min_speech_ms: 120,
      hangover_ms: 600,
    },
    speech_gate: {
      silence_enter_ms: 900,
      rearm_hits: 2,
      rearm_window_ms: 500,
      force_commit_silence_ms: 2500,
    },
  },
};

export const DEFAULT_TTS_SETTINGS = {
  enabled: false,
  backend: 'kokoro',
  kokoro: {
    voices: {},
  },
  voxcpm2: {
    languages: {},
    ultimate_cloning: {
      stable_generated: { enabled: true, also_use_as_reference: true },
      last_speech: { enabled: false, also_use_as_reference: true },
    },
  },
};

export const DEFAULT_TTS_OPTIONS = {
  backends: [
    { value: 'kokoro', label: 'Kokoro' },
    { value: 'voxcpm2', label: 'VoxCPM2' },
    { value: 'nanovllm_voxcpm', label: 'NanoVLLM VoxCPM' },
  ],
  kokoro_voices: {},
  voxcpm2_modes: [
    { value: 'description', label: 'From description' },
    { value: 'reference_audio', label: 'From reference audio' },
  ],
  voxcpm2_genders: [
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
  ],
  voxcpm2_styles: [
    { value: 'neutral', label: 'Neutral' },
    { value: 'warm', label: 'Warm' },
    { value: 'calm', label: 'Calm' },
    { value: 'clear', label: 'Clear' },
  ],
  voxcpm2_reference_sources: [
    { value: 'last_speech', label: 'Last speech fragment' },
    { value: 'stable_generated', label: 'Stable generated' },
  ],
};

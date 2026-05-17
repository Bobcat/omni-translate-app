import { api, SessionSocket } from './api-client.js';
import { AudioCapture } from './shared/audio-capture.js';
import { AudioQueue } from './shared/audio-playback.js';
import { languages } from './shared/languages.js';

const LANE_IDS = ['a_to_b', 'b_to_a'];
const TURN_STATES = {
  OPEN_EMPTY: 'open_empty',
  OPEN_ACTIVE_UNSPOKEN: 'open_active_unspoken',
  OPEN_SPEAKING: 'open_speaking',
  OPEN_SPOKEN_IDLE: 'open_spoken_idle',
};
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPrompt = e;
  if (typeof els !== 'undefined') _updateInstallRow();
});

window.addEventListener('appinstalled', () => {
  _installPrompt = null;
  if (typeof els !== 'undefined') _updateInstallRow();
});

function _isIosInstallable() {
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) && !/crios|fxios/i.test(ua);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return isIos && !isStandalone;
}

function _updateInstallRow() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const available = !isStandalone && (_installPrompt !== null || _isIosInstallable());
  els.installAppRow.hidden = !available;
  if (_isIosInstallable()) {
    els.installAppHint.textContent = 'Share menu, then Add to Home Screen';
  } else {
    els.installAppHint.textContent = 'Experimental, may not work in all browsers';
  }
}

async function handleInstallApp() {
  if (_installPrompt) {
    const { outcome } = await _installPrompt.prompt();
    _installPrompt = null;
    _updateInstallRow();
    els.installAppHint.textContent = outcome === 'accepted' ? 'Installing…' : 'Cancelled';
    return;
  }
  if (_isIosInstallable()) {
    closeSettingsSheet();
    return;
  }
  els.installAppHint.textContent = 'Try reloading the page first';
}

const SESSION_STATES = {
  SETUP: 'setup',
  RUNNING: 'running',
};
const MIC_STATES = {
  LISTENING: 'listening',
  OFF: 'off',
};
const DEFAULT_AUDIO_SETTINGS = {
  preGain: 1.5,
  autoGainControl: true,
};
const DEFAULT_TUNING_SETTINGS = {
  timing: { emit_min_ms: 120 },
  asr: {
    backend: 'whisperx',
    beam_size: 5,
    chunk_size: 10,
    chunk_length: null,
    vad_filter: null,
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
const DEFAULT_TTS_SETTINGS = {
  enabled: false,
  backend: 'kokoro',
  kokoro: {
    voices: {},
  },
  voxcpm2: {
    languages: {},
  },
};
const DEFAULT_TTS_OPTIONS = {
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
    { value: 'own_voice', label: 'Own voice (later)', disabled: true },
  ],
};
const VOXCPM2_DEFAULT_LANGUAGE_CONFIG = {
  mode: 'reference_audio',
  reference_source: 'stable_generated',
  stable_gender: 'female',
};
const VOXCPM2_DEFAULT_TRIM_SECONDS = 4;
const VOXCPM2_VOICE_CONFIG_STORAGE_KEY = 'voxcpm2_voice_config';
const TTS_GLOBAL_STORAGE_KEY = 'tts_global';
const VOXCPM2_GENDER_CLAUSES = {
  female: 'Use a natural adult female voice.',
  male: 'Use a natural adult male voice.',
};
const VOXCPM2_STYLE_CLAUSES = {
  neutral: 'Use a neutral, natural speaking style.',
  warm: 'Use a warm, natural speaking style.',
  calm: 'Use a calm, measured speaking style.',
  clear: 'Use a clear, articulate speaking style.',
};
const TUNING_CONTROLS = [
  { group: 'Backend selection', key: 'asr.backend', label: 'Backend', type: 'select', options: [['whisperx', 'WhisperX'], ['faster_whisper_direct', 'Faster Whisper']] },
  { group: 'Common decode', key: 'asr.beam_size', label: 'Beam size', type: 'number', min: 1, max: 16, step: 1 },
  { group: 'WhisperX decode', key: 'asr.chunk_size', label: 'Chunk size', type: 'number', min: 1, max: 60, step: 1, unit: 's', backend: 'whisperx' },
  { group: 'WhisperX decode', key: 'asr.align_enabled', label: 'Alignment', type: 'checkbox', backend: 'whisperx', lock: 'disabled' },
  { group: 'WhisperX decode', key: 'asr.diarize_enabled', label: 'Diarization', type: 'checkbox', backend: 'whisperx', lock: 'disabled' },
  { group: 'WhisperX decode', key: 'asr.diarize_speaker_mode', label: 'Speaker mode', type: 'select', options: [['none', 'None'], ['auto', 'Auto'], ['fixed', 'Fixed']], backend: 'whisperx', lock: 'disabled' },
  { group: 'WhisperX decode', key: 'asr.diarize_min_speakers', label: 'Min speakers', type: 'number', min: 1, max: 16, step: 1, backend: 'whisperx', lock: 'disabled' },
  { group: 'WhisperX decode', key: 'asr.diarize_max_speakers', label: 'Max speakers', type: 'number', min: 1, max: 16, step: 1, backend: 'whisperx', lock: 'disabled' },
  { group: 'Faster Whisper decode', key: 'asr.chunk_length', label: 'Chunk length', type: 'number', min: 1, max: 60, step: 1, unit: 's', nullable: true, backend: 'faster_whisper_direct' },
  { group: 'Faster Whisper decode', key: 'asr.vad_filter', label: 'VAD filter', type: 'nullableBool', backend: 'faster_whisper_direct' },
  { group: 'Faster Whisper decode', key: 'asr.word_timestamps', label: 'Word timestamps', type: 'nullableBool', backend: 'faster_whisper_direct', lock: 'disabled' },
  { group: 'Faster Whisper decode', key: 'asr.max_new_tokens', label: 'Max new tokens', type: 'number', min: 1, max: 512, step: 1, nullable: true, backend: 'faster_whisper_direct', lock: 'disabled' },
  { group: 'Faster Whisper decode', key: 'asr.hotwords', label: 'Hotwords', type: 'text', nullable: true, backend: 'faster_whisper_direct', lock: 'disabled' },
  { group: 'Faster Whisper decode', key: 'asr.compression_ratio_threshold', label: 'Compression threshold', type: 'number', min: 0.1, max: 10, step: 0.1, nullable: true, backend: 'faster_whisper_direct', lock: 'disabled' },
  { group: 'Faster Whisper decode', key: 'asr.log_prob_threshold', label: 'Log prob threshold', type: 'number', min: -10, max: 0, step: 0.1, nullable: true, backend: 'faster_whisper_direct', lock: 'disabled' },
  { group: 'Faster Whisper decode', key: 'asr.no_speech_threshold', label: 'No speech threshold', type: 'number', min: 0, max: 1, step: 0.05, nullable: true, backend: 'faster_whisper_direct', lock: 'disabled' },
  { group: 'Faster Whisper decode', key: 'asr.language_detection_threshold', label: 'Language threshold', type: 'number', min: 0, max: 1, step: 0.05, nullable: true, backend: 'faster_whisper_direct', lock: 'disabled' },
  { group: 'Faster Whisper decode', key: 'asr.language_detection_segments', label: 'Language segments', type: 'number', min: 1, max: 10, step: 1, nullable: true, backend: 'faster_whisper_direct', lock: 'disabled' },
  { group: 'Dispatch pacing', key: 'timing.emit_min_ms', label: 'Emit interval', type: 'number', min: 0, max: 60000, step: 10, unit: 'ms' },
  { group: 'Dispatch pacing', key: 'rolling.min_infer_audio_ms', label: 'Min infer audio', type: 'number', min: 1, max: 60000, step: 50, unit: 'ms' },
  { group: 'Dispatch pacing', key: 'rolling.min_new_audio_ms', label: 'Min new audio', type: 'number', min: 0, max: 60000, step: 50, unit: 'ms' },
  { group: 'Dispatch pacing', key: 'rolling.pacing.base_emit_ms', label: 'Base pacing interval', type: 'number', min: 1, max: 60000, step: 10, unit: 'ms' },
  { group: 'Dispatch pacing', key: 'rolling.pacing.startup.duration_ms', label: 'Initial phase length', type: 'number', min: 0, max: 60000, step: 50, unit: 'ms' },
  { group: 'Dispatch pacing', key: 'rolling.pacing.startup.emit_ms', label: 'Initial emit interval', type: 'number', min: 1, max: 60000, step: 10, unit: 'ms' },
  { group: 'Dispatch pacing', key: 'rolling.pacing.startup.min_infer_audio_ms', label: 'Initial min infer audio', type: 'number', min: 0, max: 60000, step: 50, unit: 'ms' },
  { group: 'Dispatch pacing', key: 'rolling.pacing.startup.min_new_audio_ms', label: 'Initial min new audio', type: 'number', min: 0, max: 60000, step: 50, unit: 'ms' },
  { group: 'Commit heuristics', key: 'rolling.single_segment_commit_min_ms', label: 'Single segment commit', type: 'number', min: 1, max: 120000, step: 100, unit: 'ms' },
  { group: 'Commit heuristics', key: 'rolling.force_commit_repeats', label: 'Force commit repeats', type: 'number', min: 1, max: 32, step: 1 },
  { group: 'Commit heuristics', key: 'rolling.speech_gate.silence_enter_ms', label: 'Silence enter', type: 'number', min: 100, max: 60000, step: 50, unit: 'ms' },
  { group: 'Commit heuristics', key: 'rolling.speech_gate.force_commit_silence_ms', label: 'Force commit silence', type: 'number', min: 100, max: 60000, step: 50, unit: 'ms' },
  { group: 'Window and buffer', key: 'rolling.max_uncommitted_ms', label: 'Max uncommitted', type: 'number', min: 1, max: 180000, step: 500, unit: 'ms' },
  { group: 'Window and buffer', key: 'rolling.max_decode_window_ms', label: 'Max decode window', type: 'number', min: 1, max: 120000, step: 100, unit: 'ms' },
  { group: 'Window and buffer', key: 'rolling.hard_clip_keep_tail_ms', label: 'Hard clip tail', type: 'number', min: 1, max: 120000, step: 100, unit: 'ms' },
  { group: 'Window and buffer', key: 'rolling.buffer_trim_threshold_ms', label: 'Buffer trim threshold', type: 'number', min: 1, max: 300000, step: 500, unit: 'ms' },
  { group: 'Window and buffer', key: 'rolling.buffer_trim_drop_ms', label: 'Buffer trim drop', type: 'number', min: 1, max: 300000, step: 500, unit: 'ms' },
  { group: 'VAD', key: 'rolling.vad.enabled', label: 'Rolling VAD', type: 'checkbox', lock: 'disabled' },
  { group: 'VAD', key: 'rolling.vad.threshold', label: 'VAD threshold', type: 'number', min: 0, max: 1, step: 0.05, lock: 'disabled' },
  { group: 'VAD', key: 'rolling.vad.max_speech_duration_s', label: 'Max speech', type: 'number', min: 0.1, max: 120, step: 0.1, unit: 's', lock: 'disabled' },
  { group: 'VAD', key: 'rolling.vad.min_speech_ms', label: 'Min speech', type: 'number', min: 0, max: 10000, step: 10, unit: 'ms', lock: 'disabled' },
  { group: 'VAD', key: 'rolling.vad.hangover_ms', label: 'Hangover', type: 'number', min: 0, max: 10000, step: 10, unit: 'ms', lock: 'disabled' },
  { group: 'Speech dispatch gate', key: 'rolling.speech_gate.rearm_hits', label: 'Rearm hits', type: 'number', min: 1, max: 16, step: 1 },
  { group: 'Speech dispatch gate', key: 'rolling.speech_gate.rearm_window_ms', label: 'Rearm window', type: 'number', min: 100, max: 60000, step: 50, unit: 'ms' },
];
const LANGUAGE_FLAGS = {
  ar: '🇸🇦',
  de: '🇩🇪',
  en: '🇬🇧',
  es: '🇪🇸',
  fr: '🇫🇷',
  hi: '🇮🇳',
  it: '🇮🇹',
  ja: '🇯🇵',
  ko: '🇰🇷',
  nl: '🇳🇱',
  pl: '🇵🇱',
  pt: '🇵🇹',
  tr: '🇹🇷',
  uk: '🇺🇦',
  zh: '🇨🇳',
};

const els = {
  app: document.querySelector('.app'),
  turnModeButton: document.querySelector('#turnModeButton'),
  conversationModeButton: document.querySelector('#conversationModeButton'),
  setupStartPanel: document.querySelector('#setupStartPanel'),
  startButton: document.querySelector('#startButton'),
  micToggleButton: document.querySelector('#micToggleButton'),
  pcExportButton: document.querySelector('#pcExportButton'),
  swapButton: document.querySelector('#swapButton'),
  turnSourceLanguage: document.querySelector('#turnSourceLanguage'),
  turnTargetLanguage: document.querySelector('#turnTargetLanguage'),
  sourceLanguagePill: document.querySelector('#sourceLanguagePill'),
  sourceLanguagePillText: document.querySelector('#sourceLanguagePill .language-pill-text'),
  targetLanguagePill: document.querySelector('#targetLanguagePill'),
  targetLanguagePillText: document.querySelector('#targetLanguagePill .language-pill-text'),
  languageSheet: document.querySelector('#languageSheet'),
  languageSheetScrim: document.querySelector('#languageSheetScrim'),
  languageSheetTitle: document.querySelector('#languageSheetTitle'),
  closeLanguageSheetButton: document.querySelector('#closeLanguageSheetButton'),
  languageSearch: document.querySelector('#languageSearch'),
  languageSheetList: document.querySelector('#languageSheetList'),
  setupSwapButton: document.querySelector('#setupSwapButton'),
  installAppRow: document.querySelector('#installAppRow'),
  installAppHint: document.querySelector('#installAppHint'),
  vadBadge: document.querySelector('#vadBadge'),
  settingsButton: document.querySelector('#settingsButton'),
  dockSettingsButton: document.querySelector('#dockSettingsButton'),
  titlebarBackButton: document.querySelector('#titlebarBackButton'),
  sourceText: document.querySelector('#sourceText'),
  targetText: document.querySelector('#targetText'),
  translateNowButton: document.querySelector('#translateNowButton'),
  speakNowButton: document.querySelector('#speakNowButton'),
  audioResumeButton: document.querySelector('#audioResumeButton'),
  ttsAudio: document.querySelector('#ttsAudio'),
  settingsSheet: document.querySelector('#settingsSheet'),
  settingsSheetTitle: document.querySelector('#settingsSheetTitle'),
  settingsSheetScrim: document.querySelector('#settingsSheetScrim'),
  settingsBackButton: document.querySelector('#settingsBackButton'),
  settingsHomePage: document.querySelector('#settingsHomePage'),
  settingsMicrophoneNav: document.querySelector('#settingsMicrophoneNav'),
  settingsAudioNav: document.querySelector('#settingsAudioNav'),
  settingsHistoryNav: document.querySelector('#settingsHistoryNav'),
  settingsDevToolsNav: document.querySelector('#settingsDevToolsNav'),
  settingsTuningNav: document.querySelector('#settingsTuningNav'),
  settingsTuningPage: document.querySelector('#settingsTuningPage'),
  devToolsShowPcExport: document.querySelector('#devToolsShowPcExport'),
  settingsMicrophonePage: document.querySelector('#settingsMicrophonePage'),
  settingsAudioPage: document.querySelector('#settingsAudioPage'),
  settingsHistoryPage: document.querySelector('#settingsHistoryPage'),
  settingsDevToolsPage: document.querySelector('#settingsDevToolsPage'),
  settingsVoiceLibraryNav: document.querySelector('#settingsVoiceLibraryNav'),
  settingsVoiceLibraryPage: document.querySelector('#settingsVoiceLibraryPage'),
  voiceLibraryControls: document.querySelector('#voiceLibraryControls'),
  tuningSettingsGroups: document.querySelector('#tuningSettingsGroups'),
  historySettingsSummary: document.querySelector('#historySettingsSummary'),
  historySaveSessions: document.querySelector('#historySaveSessions'),
  historyRetentionDays: document.querySelector('#historyRetentionDays'),
  settingsStartButton: document.querySelector('#settingsStartButton'),
  micPreGain: document.querySelector('#micPreGain'),
  micPreGainValue: document.querySelector('#micPreGainValue'),
  micSettingsSummary: document.querySelector('#micSettingsSummary'),
  micAutoGainControl: document.querySelector('#micAutoGainControl'),
  micLevel: document.querySelector('.mic-level'),
  micLevelFill: document.querySelector('#micLevelFill'),
  audioSettingsReset: document.querySelector('#audioSettingsReset'),
  ttsOutputState: document.querySelector('#ttsOutputState'),
  ttsEnabled: document.querySelector('#ttsEnabled'),
  ttsBackendSelect: document.querySelector('#ttsBackendSelect'),
  ttsSettingsGroups: document.querySelector('#ttsSettingsGroups'),
};

const initialLanes = buildLocalLanes('Dutch', 'English');

const state = {
  socket: null,
  sessionId: null,
  capture: null,
  sideALanguage: 'Dutch',
  sideBLanguage: 'English',
  requestedStartLaneId: 'a_to_b',
  lanes: initialLanes,
  currentTurn: createLocalTurn('a_to_b', initialLanes),
  audioStatus: '',
  status: 'idle',
  sessionState: SESSION_STATES.SETUP,
  micState: MIC_STATES.OFF,
  pcExportBusy: false,
  audioInputSampleRate: 16000,
  viewMode: 'turn',
  captureMutedForPlayback: false,
  settingsPage: 'home',
  vadHintTimer: null,
  audioSettings: {
    preGain: DEFAULT_AUDIO_SETTINGS.preGain,
    autoGainControl: DEFAULT_AUDIO_SETTINGS.autoGainControl,
    autoGainControlBusy: false,
    inputLevel: 0,
  },
  tuningSettings: cloneSettings(DEFAULT_TUNING_SETTINGS),
  tuningExpandedGroups: new Set(),
  ttsSettings: cloneSettings(DEFAULT_TTS_SETTINGS),
  devToolsSettings: loadDevToolsSettings(),
  ttsOptions: cloneSettings(DEFAULT_TTS_OPTIONS),
  ttsExpandedGroups: new Set(),
  ttsVoxcpm2SelectedTag: '',
  ttsPromptInspectOpen: false,
  ttsUpdateBusy: false,
  voiceLibraryStable: {},
  voiceLibraryBusyTag: '',
  voiceLibraryEngine: '',
  voiceLibraryLanguageTag: '',
  voiceLibraryGender: 'female',
  speakNowPending: false,
  speakNowPendingTimer: null,
  audioPlayback: null,
};

let audioQueue;


audioQueue = new AudioQueue({
  audio: els.ttsAudio,
  resumeButton: els.audioResumeButton,
  onStatus: (text) => {
    state.audioStatus = text;
    updateActionButtons();
  },
  onPlaybackStart: (item) => {
    state.captureMutedForPlayback = true;
    state.audioPlayback = item || null;
    renderTranscript();
  },
  onPlaybackIdle: () => {
    state.captureMutedForPlayback = false;
    state.audioPlayback = null;
    renderTranscript();
  },
  onPlaybackComplete: () => {
    if (state.sessionState !== SESSION_STATES.RUNNING || state.micState !== MIC_STATES.LISTENING) return;
    stopMicrophoneCapture();
  },
  onItemEnded: (item) => {
    if (item.replay) return;
    const speakingPart = (state.currentTurn?.parts || []).find((p) => p.speechState === 'speaking');
    if (speakingPart) speakingPart.speechState = 'spoken';
    state.socket?.ttsPlaybackComplete({
      laneId: item.laneId,
      turnId: item.turnId,
      artifactId: item.artifactId,
    });
  },
});

init().catch((error) => {
  setStatus('error');
});

async function init() {
  const config = await api.getConfig();
  state.sideALanguage = normalizeLanguageName(config.conversation?.side_a_language || 'Dutch');
  state.sideBLanguage = normalizeLanguageName(config.conversation?.side_b_language || 'English');
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  state.audioInputSampleRate = config.audio_input?.sample_rate_hz || 16000;
  state.tuningSettings = mergeSettings(DEFAULT_TUNING_SETTINGS, config.live_settings || {});
  applyTtsConfig(config.tts || {});
  mergeStoredTtsConfigIntoState();
  applyVoiceLibraryStatus(config.voice_library?.stable || {});
  syncVoxcpm2VoiceConfigToBackend();

  els.startButton.addEventListener('click', handleStartButton);
  els.micToggleButton.addEventListener('click', handleMicToggle);
  els.pcExportButton.addEventListener('click', exportPcTranscript);
  els.turnModeButton?.addEventListener('click', () => setViewMode('turn'));
  els.sourceLanguagePill.addEventListener('click', () => openLanguageSheet('source'));
  els.targetLanguagePill.addEventListener('click', () => openLanguageSheet('target'));
  els.languageSheetScrim.addEventListener('click', closeLanguageSheet);
  els.closeLanguageSheetButton.addEventListener('click', closeLanguageSheet);
  els.languageSearch.addEventListener('input', () => {
    const lane = currentLane();
    const currentLang = _languageSheetSide === 'source' ? lane.sourceLanguage : lane.targetLanguage;
    renderLanguageSheetList(currentLang, els.languageSearch.value.trim());
  });
  window.visualViewport?.addEventListener('resize', _onViewportResize);
  els.setupSwapButton.addEventListener('click', swapSetupLanguages);
  els.translateNowButton.addEventListener('click', translateNow);
  els.speakNowButton.addEventListener('click', speakNow);
  els.swapButton.addEventListener('click', swapDirection);
  els.settingsButton.addEventListener('click', openSettingsSheet);
  els.dockSettingsButton.addEventListener('click', openSettingsSheet);
  els.titlebarBackButton.addEventListener('click', finishSession);
  els.settingsBackButton.addEventListener('click', handleSettingsBack);
  els.settingsMicrophoneNav.addEventListener('click', () => navigateSettingsPage('microphone'));
  els.settingsAudioNav.addEventListener('click', () => navigateSettingsPage('audio'));
  els.settingsHistoryNav.addEventListener('click', () => navigateSettingsPage('history'));
  els.settingsDevToolsNav.addEventListener('click', () => navigateSettingsPage('dev-tools'));
  els.settingsTuningNav.addEventListener('click', () => navigateSettingsPage('tuning'));
  els.settingsVoiceLibraryNav.addEventListener('click', () => navigateSettingsPage('voice-library'));
  els.voiceLibraryControls.addEventListener('change', handleVoiceLibraryChange);
  els.voiceLibraryControls.addEventListener('click', handleVoiceLibraryClick);
  els.devToolsShowPcExport.addEventListener('change', handleDevToolsShowPcExportChange);
  els.installAppRow.addEventListener('click', handleInstallApp);
  els.settingsStartButton.addEventListener('click', startFromSettings);
  els.micPreGain.addEventListener('input', handlePreGainInput);
  els.micAutoGainControl.addEventListener('change', handleAutoGainControlChange);
  els.audioSettingsReset.addEventListener('click', resetAudioSettings);
  els.tuningSettingsGroups.addEventListener('change', handleTuningSettingChange);
  els.ttsEnabled.addEventListener('change', handleTtsEnabledChange);
  els.ttsBackendSelect.addEventListener('change', handleTtsBackendChange);
  els.ttsSettingsGroups.addEventListener('change', handleTtsSettingChange);
  els.ttsSettingsGroups.addEventListener('click', handleTtsSettingsClick);
  els.targetText.addEventListener('click', handleTargetTextClick);
  els.settingsSheetScrim.addEventListener('click', closeSettingsSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeSettingsSheet();
  });
  window.addEventListener('popstate', handlePopstateBack);
  setupSheetSwipeClose({
    layer: els.languageSheet,
    sheet: els.languageSheet.querySelector('.bottom-sheet'),
    scrollContainer: els.languageSheetList,
    onClose: closeLanguageSheet,
  });
  setupSheetSwipeClose({
    layer: els.settingsSheet,
    sheet: els.settingsSheet.querySelector('.bottom-sheet'),
    scrollContainer: els.settingsSheet.querySelector('.settings-views'),
    onClose: closeSettingsSheet,
    isAllowed: () => state.settingsPage === 'home',
  });
  if (history.state?.view === 'running') {
    history.replaceState({}, '');
  }


  renderLanguageControls();
  setupAutoFollow(els.sourceText);
  setupAutoFollow(els.targetText);
  renderTranscript();
  renderAudioSettings();
  renderTuningSettings();
  renderTtsSettings();
  renderHistorySettings();
  updateActionButtons();
  renderLifecycle();
  setStatus('idle');
  _updateInstallRow();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

async function startListening() {
  const startLaneId = currentLaneId();
  clearAllLanes({ laneId: startLaneId });
  state.requestedStartLaneId = startLaneId;
  state.micState = MIC_STATES.OFF;
  state.pcExportBusy = false;
  setListenBusy(true);
  setStatus('connecting');
  let socket = null;
  let capture = null;
  try {
    const capturePromise = createStartedAudioCapture({ targetSampleRate: state.audioInputSampleRate });
    const session = await api.createSession({
      sideALanguage: state.sideALanguage,
      sideBLanguage: state.sideBLanguage,
      liveSettings: state.tuningSettings,
    });
    const sessionId = String(session.session?.session_id || session.session_id || '').trim();
    if (!sessionId) throw new Error('Missing session id');
    state.sessionId = sessionId;
    socket = new SessionSocket(
      session.ws_url,
      handleMessage,
      () => {
        if (state.socket !== socket) return;
        cleanupClientSession({ keepSocket: false });
        resetSessionToSetup();
        setStatus('idle');
      },
    );
    await Promise.all([
      socket.connect(),
      capturePromise.then((startedCapture) => {
        capture = startedCapture;
      }),
    ]);
    state.socket = socket;
    state.audioInputSampleRate = session.audio_input?.sample_rate_hz || 16000;
    state.capture = capture;
    state.audioSettings.autoGainControl = state.capture.autoGainControl;
    state.socket.startListening();
    state.micState = MIC_STATES.LISTENING;
    renderAudioSettings();
    setSessionState(SESSION_STATES.RUNNING);
    setStatus('listening');
  } catch (error) {
    state.captureMutedForPlayback = false;
    capture?.stop();
    socket?.close();
    cleanupClientSession();
    state.sessionId = null;
    setSessionState(SESSION_STATES.SETUP);
    setStatus('error');
  } finally {
    setListenBusy(false);
    renderLifecycle();
  }
}

function handleStartButton() {
  if (state.sessionState === SESSION_STATES.SETUP) {
    startListening();
  }
}

function handleMicToggle() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (state.micState === MIC_STATES.LISTENING) {
    stopMicrophoneCapture();
    return;
  }
  if (state.micState === MIC_STATES.OFF) {
    startMicrophoneCapture();
  }
}

function finishSession() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (!state.socket?.isOpen()) {
    cleanupClientSession();
    state.sessionId = null;
    setSessionState(SESSION_STATES.SETUP);
    return;
  }
  const finishingSocket = state.socket;
  finishingSocket.finishListening();
  if (state.socket === finishingSocket) {
    state.socket = null;
  }
  state.sessionId = null;
  state.captureMutedForPlayback = false;
  state.pcExportBusy = false;
  state.capture?.stop();
  state.capture = null;
  state.micState = MIC_STATES.OFF;
  hideVadHint();
  renderMicLevel(0);
  renderAudioSettings();
  resetSessionToSetup();
}

async function startMicrophoneCapture() {
  if (state.sessionState !== SESSION_STATES.RUNNING || state.micState !== MIC_STATES.OFF) return;
  if (!state.socket?.isOpen()) return;
  setListenBusy(true);
  try {
    state.capture = createAudioCapture({ targetSampleRate: state.audioInputSampleRate });
    await state.capture.start();
    state.audioSettings.autoGainControl = state.capture.autoGainControl;
    state.socket.startListening();
    state.micState = MIC_STATES.LISTENING;
    state.captureMutedForPlayback = false;
    renderAudioSettings();
    renderTranscript();
    setStatus('listening');
  } catch (error) {
    state.capture?.stop();
    state.capture = null;
    state.micState = MIC_STATES.OFF;
    renderMicLevel(0);
    renderAudioSettings();
    setStatus('error');
  } finally {
    setListenBusy(false);
    renderLifecycle();
  }
}

function stopMicrophoneCapture() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  state.captureMutedForPlayback = false;
  state.capture?.stop();
  state.capture = null;
  state.micState = MIC_STATES.OFF;
  hideVadHint();
  renderMicLevel(0);
  renderAudioSettings();
  renderTranscript();
  setStatus('listening');
}

function speakNow() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (audioQueue.hasNonReplayAudio()) {
    audioQueue.playOrResume();
    return;
  }
  if (state.currentTurn.speakableTargetText && state.currentTurn.state !== TURN_STATES.OPEN_SPEAKING && state.socket?.speakNow()) {
    state.speakNowPending = true;
    if (state.speakNowPendingTimer) clearTimeout(state.speakNowPendingTimer);
    state.speakNowPendingTimer = setTimeout(() => {
      state.speakNowPending = false;
      state.speakNowPendingTimer = null;
      updateActionButtons();
    }, 1500);
    if (state.micState === MIC_STATES.LISTENING) {
      stopMicrophoneCapture();
    }
    updateActionButtons();
  }
}

function clearSpeakNowPending() {
  if (!state.speakNowPending && !state.speakNowPendingTimer) return;
  state.speakNowPending = false;
  if (state.speakNowPendingTimer) {
    clearTimeout(state.speakNowPendingTimer);
    state.speakNowPendingTimer = null;
  }
}

function translateNow() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (!state.currentTurn.canTranslateNow) return;
  if (state.socket?.translateNow()) {
  }
}

function swapDirection() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (!state.socket?.isOpen()) return;
  const nextLaneId = currentLaneId() === 'a_to_b' ? 'b_to_a' : 'a_to_b';
  audioQueue.clear();
  state.socket.nextTurn(nextLaneId);
}

async function exportPcTranscript() {
  if (state.sessionState !== SESSION_STATES.RUNNING || state.micState !== MIC_STATES.OFF || !state.sessionId) return;
  state.pcExportBusy = true;
  updateActionButtons();
  try {
    const { blob, filename } = await api.getSessionPcExport(state.sessionId);
    downloadBlob(blob, filename);
  } catch (error) {
    setStatus('error');
  } finally {
    state.pcExportBusy = false;
    updateActionButtons();
  }
}

function resetSessionToSetup() {
  clearAllLanes({ laneId: 'a_to_b' });
  state.requestedStartLaneId = 'a_to_b';
  state.captureMutedForPlayback = false;
  setSessionState(SESSION_STATES.SETUP);
  setStatus('idle');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'transcript.pc';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function shouldSendMicrophoneAudio() {
  return state.sessionState === SESSION_STATES.RUNNING
    && state.micState === MIC_STATES.LISTENING
    && !state.captureMutedForPlayback
    && state.currentTurn.state !== TURN_STATES.OPEN_SPEAKING;
}

function createAudioCapture({ targetSampleRate = 16000 } = {}) {
  return new AudioCapture({
    targetSampleRate,
    chunkMs: 40,
    preGain: state.audioSettings.preGain,
    autoGainControl: state.audioSettings.autoGainControl,
    onChunk: (buffer) => {
      if (shouldSendMicrophoneAudio()) state.socket?.sendAudio(buffer);
    },
    onLevel: (level) => renderMicLevel(level),
  });
}

async function createStartedAudioCapture({ targetSampleRate = 16000 } = {}) {
  const capture = createAudioCapture({ targetSampleRate });
  try {
    await capture.start();
    return capture;
  } catch (error) {
    capture.stop();
    throw error;
  }
}

function handleMessage(msg) {
  const msgSessionId = String(msg?.session_id || '').trim();
  if (!state.sessionId || msgSessionId !== state.sessionId) return;
  if (msg.type === 'ready') {
    applyReady(msg);
    return;
  }
  if (msg.type === 'state') {
    setStatus(msg.state || 'idle');
    return;
  }
  if (msg.type === 'vad_state') {
    handleVadState(msg);
    return;
  }
  if (msg.type === 'turn_update') {
    applyTurnUpdate(msg);
    return;
  }
  if (msg.type === 'tts_clip_ready') {
    if (!shouldApplyCurrentTurnMessage(msg)) return;
    if (msg.tts) {
      audioQueue.enqueue({
        ...msg.tts,
        laneId: msg.lane_id,
        turnId: msg.turn_id,
        artifactId: msg.tts.artifact_id,
      });
    }
    updateActionButtons();
    return;
  }
  if (msg.type === 'tts_replay_ready') {
    if (msg.tts) {
      audioQueue.enqueue({
        ...msg.tts,
        laneId: msg.lane_id,
        artifactId: msg.tts.artifact_id,
        replay: true,
        replayText: String(msg.text || ''),
      });
    }
    updateActionButtons();
    return;
  }
  if (msg.type === 'tts_status') {
    updateActionButtons();
    return;
  }
  if (msg.type === 'translation_status') {
    updateActionButtons();
    return;
  }
  if (msg.type === 'asr_status') {
    return;
  }
  if (msg.type === 'live_settings') {
    state.tuningSettings = mergeSettings(DEFAULT_TUNING_SETTINGS, msg.live_settings || {});
    renderTuningSettings({ preserveScroll: true });
    return;
  }
  if (msg.type === 'error') {
    setStatus('error');
    return;
  }
  if (msg.type === 'ended') {
    state.captureMutedForPlayback = false;
    hideVadHint();
    cleanupClientSession({ keepSocket: false });
    state.sessionId = null;
    resetSessionToSetup();
  }
}

function applyReady(msg) {
  state.sideALanguage = normalizeLanguageName(msg.side_a_language || state.sideALanguage);
  state.sideBLanguage = normalizeLanguageName(msg.side_b_language || state.sideBLanguage);
  state.tuningSettings = mergeSettings(DEFAULT_TUNING_SETTINGS, msg.live_settings || state.tuningSettings);
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  for (const laneId of Object.keys(msg.lanes || {})) {
    mergeLanePayload(laneId, msg.lanes[laneId]);
  }
  applyCurrentTurn(msg.current_turn || createLocalTurn('a_to_b', state.lanes));
  hideVadHint();
  enableTranscriptAutoFollow();
  renderLanguageControls();
  renderTranscript();
  renderTtsSettings();
  updateActionButtons();
  if (state.requestedStartLaneId !== currentLaneId()) {
    state.socket?.nextTurn(state.requestedStartLaneId);
  }
}

function applyTurnUpdate(msg) {
  for (const laneId of Object.keys(msg.lanes || {})) {
    mergeLanePayload(laneId, msg.lanes[laneId]);
  }
  const previousLaneId = currentLaneId();
  applyCurrentTurn(msg.current_turn || state.currentTurn);
  clearSpeakNowPending();
  const laneChanged = previousLaneId !== currentLaneId();
  if (laneChanged || msg.reason === 'next_turn') {
    audioQueue.clear();
    hideVadHint();
    enableTranscriptAutoFollow();
  }
  renderLanguageControls();
  renderTranscript();
  updateActionButtons();
  renderTurnStatus(msg.reason);
}

function applyCurrentTurn(payload) {
  state.currentTurn = normalizeTurnPayload(payload);
}

function renderTurnStatus(reason) {
  if (state.audioStatus) return;
  if (reason === 'source_c') {
  } else if (reason === 'translate_now') {
  } else if (reason === 'translation_update') {
  } else if (reason === 'speak_now') {
  } else if (reason === 'next_turn' || reason === 'tts_playback_complete') {
  }
}

function cleanupClientSession({ keepSocket = false } = {}) {
  state.capture?.stop();
  state.capture = null;
  state.micState = MIC_STATES.OFF;
  state.pcExportBusy = false;
  state.captureMutedForPlayback = false;
  hideVadHint();
  renderMicLevel(0);
  renderAudioSettings();
  if (!keepSocket) {
    state.socket?.close();
    state.socket = null;
    state.sessionId = null;
  }
}

function clearAllLanes({ laneId = currentLaneId() } = {}) {
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  state.currentTurn = createLocalTurn(laneId, state.lanes);
  audioQueue.clear();
  hideVadHint();
  enableTranscriptAutoFollow();
  renderTranscript();
  updateActionButtons();
}

function setSessionState(sessionState) {
  const previous = state.sessionState;
  state.sessionState = Object.values(SESSION_STATES).includes(sessionState) ? sessionState : SESSION_STATES.SETUP;
  if (state.sessionState !== SESSION_STATES.RUNNING) {
    state.micState = MIC_STATES.OFF;
  }
  syncSessionHistory(previous, state.sessionState);
  renderLifecycle();
  renderTuningSettings({ preserveScroll: true });
  updateActionButtons();
}

let _skipHistorySync = false;

function syncSessionHistory(previous, next) {
  if (_skipHistorySync) return;
  if (previous !== SESSION_STATES.RUNNING && next === SESSION_STATES.RUNNING) {
    if (history.state?.view !== 'running') {
      history.pushState({ view: 'running' }, '');
    }
  } else if (previous === SESSION_STATES.RUNNING && next !== SESSION_STATES.RUNNING) {
    if (history.state?.view === 'running') {
      history.back();
    }
  }
}

function handlePopstateBack(event) {
  if (_skipLanguageSheetPopstate) {
    _skipLanguageSheetPopstate = false;
    return;
  }
  if (!els.languageSheet.hidden) {
    closeLanguageSheet();
    return;
  }
  if (!els.settingsSheet.hidden) {
    const newState = event?.state;
    if (newState?.view === 'settingsSheet' && newState.page) {
      _settingsSheetDepth = Math.max(1, _settingsSheetDepth - 1);
      setSettingsPage(newState.page);
    } else {
      _settingsSheetDepth = 0;
      els.settingsSheet.hidden = true;
    }
    return;
  }
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  _skipHistorySync = true;
  try {
    finishSession();
  } finally {
    _skipHistorySync = false;
  }
}

function setViewMode(viewMode) {
  state.viewMode = viewMode === 'conversation' ? 'conversation' : 'turn';
  renderLifecycle();
}

function renderLifecycle() {
  const setup = state.sessionState === SESSION_STATES.SETUP;
  const running = state.sessionState === SESSION_STATES.RUNNING;
  const micOff = running && state.micState === MIC_STATES.OFF;
  const micListening = running && state.micState === MIC_STATES.LISTENING;
  els.app.classList.toggle('is-setup', setup);
  els.app.classList.toggle('is-running', running);
  els.app.classList.toggle('is-mic-off', micOff);
  els.app.classList.toggle('is-mic-listening', micListening);
  els.setupStartPanel.hidden = !setup;
  els.sourceText.hidden = setup;
  els.setupSwapButton.hidden = !setup;
  els.translateNowButton.hidden = !running;
  els.speakNowButton.hidden = !running;
  els.micToggleButton.hidden = !running;
  els.pcExportButton.hidden = !(running && micOff && state.devToolsSettings.showPcExport);
  els.startButton.disabled = state.status === 'connecting';
  els.settingsStartButton.disabled = !(setup || micOff) || state.status === 'connecting';
  els.setupSwapButton.disabled = !setup || state.status === 'connecting';
  els.turnModeButton?.classList.toggle('is-active', state.viewMode === 'turn');
  els.turnModeButton?.setAttribute('aria-pressed', state.viewMode === 'turn' ? 'true' : 'false');
  els.conversationModeButton?.classList.toggle('is-active', state.viewMode === 'conversation');
  els.conversationModeButton?.setAttribute('aria-pressed', state.viewMode === 'conversation' ? 'true' : 'false');
  renderLanguageControls();
}

function setListenBusy(busy) {
  els.startButton.disabled = Boolean(busy);
  els.settingsStartButton.disabled = Boolean(busy);
}

function updateActionButtons() {
  updateTranslateNowButton();
  updateSpeakNowButton();
  updateMicToggleButton();
  updatePcExportButton();
  updateSwapButton();
  renderLanguageControls();
}

function updateTranslateNowButton() {
  const turnIsSpeaking = state.currentTurn.state === TURN_STATES.OPEN_SPEAKING;
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  els.translateNowButton.disabled = !(live && state.currentTurn.canTranslateNow && !turnIsSpeaking);
}

function updateSwapButton() {
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  els.swapButton.disabled = !live;
}

function updateSpeakNowButton() {
  const turnIsSpeaking = state.currentTurn.state === TURN_STATES.OPEN_SPEAKING;
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  const canSpeakTarget = Boolean(live && state.currentTurn.speakableTargetText && !turnIsSpeaking);
  const canPlayAudio = Boolean(live && audioQueue?.hasNonReplayAudio());
  els.speakNowButton.disabled = state.speakNowPending || !(canSpeakTarget || canPlayAudio);
  els.speakNowButton.classList.toggle('is-busy', turnIsSpeaking);
  let label = 'Speak now';
  if (canPlayAudio && state.audioStatus.startsWith('Playing')) {
    label = 'Playing';
  } else if (canPlayAudio) {
    label = 'Play audio';
  }
  els.speakNowButton.setAttribute('aria-label', label);
  els.speakNowButton.title = label;
}

function updateMicToggleButton() {
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  const micListening = state.micState === MIC_STATES.LISTENING;
  const micOff = state.micState === MIC_STATES.OFF;
  const enabled = live && (micListening || micOff) && state.status !== 'connecting';
  els.micToggleButton.disabled = !enabled;
  els.micToggleButton.classList.toggle('is-mic-listening-action', micListening);
  els.micToggleButton.classList.toggle('is-mic-on-action', micOff);
  const label = micListening ? 'Turn microphone off' : 'Turn microphone on';
  els.micToggleButton.setAttribute('aria-label', label);
  els.micToggleButton.title = micListening ? 'Mic off' : 'Mic on';
}

function updatePcExportButton() {
  const canExport = state.sessionState === SESSION_STATES.RUNNING
    && state.micState === MIC_STATES.OFF
    && Boolean(state.sessionId)
    && !state.pcExportBusy;
  els.pcExportButton.disabled = !canExport;
  els.pcExportButton.setAttribute('aria-label', state.pcExportBusy ? 'Exporting PC transcript' : 'Export PC transcript');
  els.pcExportButton.title = state.pcExportBusy ? 'Exporting PC' : 'Export PC';
}

function setStatus(status) {
  state.status = String(status || 'idle').toLowerCase();
  renderLifecycle();
  updateActionButtons();
}

let _settingsSheetDepth = 0;

function openSettingsSheet() {
  if (!els.settingsSheet.hidden) return;
  els.settingsSheet.hidden = false;
  setSettingsPage('home');
  renderAudioSettings();
  renderTuningSettings();
  renderTtsSettings();
  renderHistorySettings();
  history.pushState({ view: 'settingsSheet', page: 'home' }, '');
  _settingsSheetDepth = 1;
}

function closeSettingsSheet() {
  // Scrim tap / Escape / swipe-down: pop ALL settings levels at once.
  if (els.settingsSheet.hidden) return;
  if (_settingsSheetDepth > 0) {
    const depth = _settingsSheetDepth;
    _settingsSheetDepth = 0;
    history.go(-depth);
    return;
  }
  els.settingsSheet.hidden = true;
}

function navigateSettingsPage(page) {
  if (history.state?.view === 'settingsSheet' && history.state.page !== page) {
    history.pushState({ view: 'settingsSheet', page }, '');
    _settingsSheetDepth += 1;
  }
  setSettingsPage(page);
}

function handleSettingsBack() {
  // In-sheet back arrow and browser back: pop one level only.
  if (history.state?.view === 'settingsSheet') {
    history.back();
    return;
  }
  els.settingsSheet.hidden = true;
}

function setSettingsPage(page) {
  state.settingsPage = ['microphone', 'audio', 'history', 'dev-tools', 'tuning', 'voice-library'].includes(page) ? page : 'home';
  renderSettingsPage();
  if (state.settingsPage === 'dev-tools') renderDevToolsSettings();
  if (state.settingsPage === 'tuning') renderTuningSettings();
  if (state.settingsPage === 'audio') renderTtsSettings();
  if (state.settingsPage === 'voice-library') renderVoiceLibraryPage();
}

function renderDevToolsSettings() {
  els.devToolsShowPcExport.checked = state.devToolsSettings.showPcExport;
}

function renderVoiceLibraryPage() {
  if (!els.voiceLibraryControls) return;
  if (els.settingsSheet.hidden || state.settingsPage !== 'voice-library') return;
  const engines = voiceLibraryEngineOptions();
  const languageTags = voiceLibraryLanguageTags();
  const genderOptions = voxcpm2GenderOptions();
  if (!engines.some((option) => option.value === state.voiceLibraryEngine)) {
    state.voiceLibraryEngine = engines[0]?.value || '';
  }
  if (!languageTags.includes(state.voiceLibraryLanguageTag)) {
    const targetTag = bcp47ForLanguageName(currentTtsTargetLanguage());
    state.voiceLibraryLanguageTag = languageTags.includes(targetTag) ? targetTag : (languageTags[0] || '');
  }
  if (!['female', 'male'].includes(state.voiceLibraryGender)) {
    state.voiceLibraryGender = 'female';
  }
  const tag = state.voiceLibraryLanguageTag;
  const gender = state.voiceLibraryGender;
  const engine = state.voiceLibraryEngine;
  const langStatus = state.voiceLibraryStable[tag] || {
    has_reference_text: false,
    reference_text: '',
    samples: {},
  };
  const info = stableSampleInfo(tag, gender);
  const busy = state.voiceLibraryBusyTag === `${tag}:${gender}`;
  const languageOptions = languageTags.map((value) => ({
    value,
    label: languageNameForBcp47(value) || value,
  }));
  const referenceText = String(langStatus.reference_text || '');
  const languageName = languageNameForBcp47(tag) || tag || '';
  const promptText = languageName
    ? voxcpm2InstructionsPreview(languageName, { mode: 'description', gender, style: 'neutral' })
    : '';

  const fragment = document.createDocumentFragment();
  fragment.append(
    _voiceLibrarySelectRow({
      label: 'Engine',
      value: engine,
      options: engines,
      kind: 'engine',
      disabled: engines.length < 2,
      emptyText: engines.length ? '' : 'No VoxCPM engine loaded',
    }),
    _voiceLibrarySelectRow({
      label: 'Language',
      value: tag,
      options: languageOptions,
      kind: 'language',
      disabled: false,
    }),
    _voiceLibrarySelectRow({
      label: 'Gender',
      value: gender,
      options: genderOptions,
      kind: 'gender',
      disabled: false,
    }),
    _voiceLibraryStatusLine(info),
    _voiceLibraryActions({ busy, info, hasReferenceText: langStatus.has_reference_text, hasEngine: Boolean(engine) }),
    _voiceLibraryBlock('Reference text', referenceText || '(no reference text for this language)'),
    _voiceLibraryBlock('Prompt', promptText),
  );
  els.voiceLibraryControls.replaceChildren(fragment);
}

function voiceLibraryEngineOptions() {
  const all = ttsBackendOptions();
  return all.filter((option) => option.value === 'voxcpm2' || option.value === 'nanovllm_voxcpm');
}

function voiceLibraryLanguageTags() {
  const tags = [];
  const seen = new Set();
  for (const item of languages) {
    const tag = item.bcp47;
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  tags.sort((a, b) => (languageNameForBcp47(a) || a).localeCompare(languageNameForBcp47(b) || b));
  return tags;
}

function _voiceLibrarySelectRow({ label, value, options, kind, disabled, emptyText }) {
  const row = document.createElement('label');
  row.className = 'select-row voice-library-row';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const select = document.createElement('select');
  select.dataset.voiceLibraryKind = kind;
  select.disabled = disabled || !options.length;
  if (!options.length && emptyText) {
    const opt = document.createElement('option');
    opt.textContent = emptyText;
    opt.value = '';
    select.append(opt);
  } else {
    for (const option of options) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.append(opt);
    }
    select.value = value;
  }
  row.append(labelEl, select);
  return row;
}

function _voiceLibraryBlock(label, body) {
  const wrap = document.createElement('div');
  wrap.className = 'tts-prompt-preview voice-library-block';
  const labelEl = document.createElement('span');
  labelEl.className = 'tts-prompt-preview-label';
  labelEl.textContent = label;
  const code = document.createElement('code');
  code.textContent = body;
  wrap.append(labelEl, code);
  return wrap;
}

function _voiceLibraryStatusLine(info) {
  const line = document.createElement('div');
  line.className = 'voice-library-status';
  if (info?.exists && info?.generated_at) {
    try {
      const stamp = new Date(info.generated_at);
      if (!Number.isNaN(stamp.getTime())) {
        line.textContent = `Last generated: ${stamp.toLocaleString([], {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })}`;
        return line;
      }
    } catch (_) {}
    line.textContent = 'Last generated: unknown time';
  } else {
    line.textContent = 'Last generated: never';
  }
  return line;
}

function _voiceLibraryActions({ busy, info, hasReferenceText, hasEngine }) {
  const wrap = document.createElement('div');
  wrap.className = 'voice-library-actions';
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.className = 'tts-inspect-button';
  generate.dataset.voiceLibraryAction = 'generate';
  if (busy) {
    generate.textContent = 'Generating…';
  } else if (info.exists) {
    generate.textContent = 'Regenerate';
  } else {
    generate.textContent = 'Generate';
  }
  generate.disabled = busy || !hasReferenceText || !hasEngine;
  if (!hasReferenceText) generate.title = 'No reference text for this language';
  else if (!hasEngine) generate.title = 'Load a VoxCPM engine to generate samples';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'tts-play-button';
  play.dataset.voiceLibraryAction = 'play';
  play.setAttribute('aria-label', 'Play sample');
  play.title = 'Play sample';
  play.disabled = busy || !info.exists;
  play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>'
    + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
    + '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
    + '</svg>';
  wrap.append(generate, play);
  return wrap;
}

function handleVoiceLibraryChange(event) {
  const select = event.target;
  if (!select || select.tagName !== 'SELECT') return;
  const kind = select.dataset.voiceLibraryKind || '';
  const value = String(select.value || '');
  if (kind === 'engine') {
    state.voiceLibraryEngine = value;
  } else if (kind === 'language') {
    state.voiceLibraryLanguageTag = value.toLowerCase();
  } else if (kind === 'gender') {
    state.voiceLibraryGender = value;
  } else {
    return;
  }
  renderVoiceLibraryPage();
}

function handleVoiceLibraryClick(event) {
  const button = event.target?.closest?.('[data-voice-library-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.voiceLibraryAction;
  const tag = state.voiceLibraryLanguageTag;
  const gender = state.voiceLibraryGender;
  if (action === 'generate') {
    handleGenerateStableSample(tag, gender, state.voiceLibraryEngine);
    return;
  }
  if (action === 'play') {
    const info = stableSampleInfo(tag, gender);
    if (info.exists) playStableSamplePreview(tag, gender, info);
  }
}

function handleDevToolsShowPcExportChange() {
  state.devToolsSettings.showPcExport = els.devToolsShowPcExport.checked;
  saveDevToolsSettings();
  render();
}

function renderSettingsPage() {
  const page = state.settingsPage;
  const home = page === 'home';
  els.settingsHomePage.hidden = page !== 'home';
  els.settingsMicrophonePage.hidden = page !== 'microphone';
  els.settingsAudioPage.hidden = page !== 'audio';
  els.settingsHistoryPage.hidden = page !== 'history';
  els.settingsDevToolsPage.hidden = page !== 'dev-tools';
  els.settingsTuningPage.hidden = page !== 'tuning';
  els.settingsVoiceLibraryPage.hidden = page !== 'voice-library';
  els.settingsBackButton.classList.toggle('is-sheet-close', home);
  els.settingsBackButton.classList.toggle('is-subpage-back', !home);
  els.settingsBackButton.setAttribute('aria-label', home ? 'Close settings' : 'Back');
  els.settingsBackButton.title = home ? 'Close settings' : 'Back';
  if (page === 'microphone') {
    els.settingsSheetTitle.textContent = 'Microphone';
  } else if (page === 'audio') {
    els.settingsSheetTitle.textContent = 'TTS options';
  } else if (page === 'history') {
    els.settingsSheetTitle.textContent = 'History';
  } else if (page === 'dev-tools') {
    els.settingsSheetTitle.textContent = 'Dev tools';
  } else if (page === 'tuning') {
    els.settingsSheetTitle.textContent = 'ASR tuning';
  } else if (page === 'voice-library') {
    els.settingsSheetTitle.textContent = 'Voice library';
  } else {
    els.settingsSheetTitle.textContent = 'Settings';
  }
}

function setVisibleLanguage(role, value) {
  if (state.sessionState !== SESSION_STATES.SETUP) return;
  const next = normalizeLanguageName(value);
  if (currentLaneId() === 'a_to_b') {
    if (role === 'source') state.sideALanguage = next;
    else state.sideBLanguage = next;
  } else if (role === 'source') {
    state.sideBLanguage = next;
  } else {
    state.sideALanguage = next;
  }
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  state.currentTurn = createLocalTurn(currentLaneId(), state.lanes);
  renderLanguageControls();
  renderTranscript();
  renderTtsSettings();
  updateActionButtons();
}

function swapSetupLanguages() {
  if (state.sessionState !== SESSION_STATES.SETUP) return;
  const previousSideA = state.sideALanguage;
  state.sideALanguage = state.sideBLanguage;
  state.sideBLanguage = previousSideA;
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  state.currentTurn = createLocalTurn(currentLaneId(), state.lanes);
  renderLanguageControls();
  renderTranscript();
  renderTtsSettings();
  updateActionButtons();
}

function handlePreGainInput() {
  state.audioSettings.preGain = normalizePreGain(els.micPreGain.value);
  state.capture?.setPreGain(state.audioSettings.preGain);
  renderAudioSettings();
}

function startFromSettings() {
  if (state.status === 'connecting') return;
  if (state.sessionState === SESSION_STATES.SETUP) {
    startListening();
    return;
  }
  if (state.sessionState === SESSION_STATES.RUNNING && state.micState === MIC_STATES.OFF) {
    startMicrophoneCapture();
  }
}

async function handleAutoGainControlChange() {
  const requested = Boolean(els.micAutoGainControl.checked);
  if (state.sessionState === SESSION_STATES.SETUP
    || (state.sessionState === SESSION_STATES.RUNNING && state.micState === MIC_STATES.OFF)) {
    state.audioSettings.autoGainControl = requested;
    renderAudioSettings();
    return;
  }
  if (state.sessionState !== SESSION_STATES.RUNNING || !state.capture) {
    renderAudioSettings();
    return;
  }
  state.audioSettings.autoGainControl = requested;
  await restartMicrophoneCapture();
}

async function resetAudioSettings() {
  state.audioSettings.preGain = DEFAULT_AUDIO_SETTINGS.preGain;
  state.capture?.setPreGain(state.audioSettings.preGain);
  if (state.sessionState === SESSION_STATES.RUNNING && state.capture) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
    await restartMicrophoneCapture();
    return;
  }
  if (state.sessionState !== SESSION_STATES.RUNNING) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
  } else if (state.micState === MIC_STATES.OFF) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
  }
  renderAudioSettings();
}

async function restartMicrophoneCapture() {
  const previousCapture = state.capture;
  const targetSampleRate = previousCapture?.targetSampleRate || 16000;
  const previousSettings = {
    preGain: previousCapture?.preGain || state.audioSettings.preGain,
    autoGainControl: previousCapture?.autoGainControl === true,
  };
  state.audioSettings.autoGainControlBusy = true;
  renderAudioSettings();
  previousCapture?.stop();
  state.capture = null;
  renderMicLevel(0);
  try {
    const nextCapture = createAudioCapture({ targetSampleRate });
    await nextCapture.start();
    state.capture = nextCapture;
    state.micState = MIC_STATES.LISTENING;
    state.audioSettings.autoGainControl = nextCapture.autoGainControl;
  } catch (error) {
    state.audioSettings.preGain = previousSettings.preGain;
    state.audioSettings.autoGainControl = previousSettings.autoGainControl;
    try {
      const restoredCapture = createAudioCapture({ targetSampleRate });
      await restoredCapture.start();
      state.capture = restoredCapture;
      state.micState = MIC_STATES.LISTENING;
      state.audioSettings.autoGainControl = restoredCapture.autoGainControl;
    } catch {
      state.micState = MIC_STATES.OFF;
      setStatus('error');
    }
  } finally {
    state.audioSettings.autoGainControlBusy = false;
    renderAudioSettings();
  }
}

function renderAudioSettings() {
  els.micPreGain.value = String(state.audioSettings.preGain);
  const preGainLabel = `${state.audioSettings.preGain.toFixed(1)}x`;
  els.micPreGainValue.textContent = preGainLabel;
  els.micSettingsSummary.textContent = state.audioSettings.autoGainControl ? `${preGainLabel}, AGC` : preGainLabel;
  els.micAutoGainControl.checked = state.audioSettings.autoGainControl;
  const agcAvailable = state.sessionState === SESSION_STATES.SETUP
    || state.sessionState === SESSION_STATES.RUNNING;
  els.micAutoGainControl.disabled = state.audioSettings.autoGainControlBusy || !agcAvailable;
  els.audioSettingsReset.disabled = state.audioSettings.autoGainControlBusy;
  renderMicLevel(state.audioSettings.inputLevel);
}

function handleTuningSettingChange(event) {
  const input = event.target;
  const key = input?.dataset?.tuningKey;
  if (!key) return;
  const control = TUNING_CONTROLS.find((item) => item.key === key);
  if (!control || input.disabled) return;
  const value = tuningInputValue(control, input);
  setTuningValue(key, value);
  renderTuningSettings({ preserveScroll: true });
  if (state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen()) {
    state.socket.updateLiveSettings(deltaForTuningPath(key, value));
  }
}

function toggleTuningGroup(groupName) {
  if (!groupName) return;
  if (state.tuningExpandedGroups.has(groupName)) {
    state.tuningExpandedGroups.delete(groupName);
  } else {
    state.tuningExpandedGroups.add(groupName);
  }
  renderTuningSettings({ preserveScroll: true });
}

function renderTuningSettings({ preserveScroll = false } = {}) {
  if (!els.tuningSettingsGroups) return;
  if (els.settingsSheet.hidden) return;
  const scrollEl = preserveScroll ? tuningScrollElement() : null;
  const scrollTop = scrollEl?.scrollTop || 0;
  const groups = new Map();
  for (const control of TUNING_CONTROLS) {
    if (!groups.has(control.group)) groups.set(control.group, []);
    groups.get(control.group).push(control);
  }
  const fragment = document.createDocumentFragment();
  for (const [groupName, controls] of groups.entries()) {
    const expanded = state.tuningExpandedGroups.has(groupName);
    const section = document.createElement('section');
    section.className = 'setting-group tuning-group';
    section.setAttribute('aria-label', groupName);
    section.dataset.tuningGroup = groupName;
    section.classList.toggle('is-expanded', expanded);
    const title = document.createElement('button');
    title.className = 'tuning-group-toggle';
    title.type = 'button';
    title.dataset.tuningGroup = groupName;
    title.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    title.addEventListener('click', () => toggleTuningGroup(groupName));
    const titleText = document.createElement('span');
    titleText.className = 'tuning-group-title';
    titleText.textContent = groupName;
    const icon = document.createElement('span');
    icon.className = 'tuning-group-icon';
    icon.setAttribute('aria-hidden', 'true');
    title.append(titleText, icon);
    const body = document.createElement('div');
    body.className = 'tuning-group-body';
    body.hidden = !expanded;
    if (expanded) {
      for (const control of controls) {
        body.append(createTuningRow(control));
      }
    }
    section.append(title, body);
    fragment.append(section);
  }
  els.tuningSettingsGroups.replaceChildren(fragment);
  if (scrollEl) scrollEl.scrollTop = scrollTop;
}

function tuningScrollElement() {
  return els.settingsSheet?.querySelector('.settings-views') || null;
}

function createTuningRow(control) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const label = document.createElement('span');
  label.className = 'tuning-label';
  label.textContent = control.label;
  const meta = document.createElement('span');
  meta.className = 'tuning-meta';
  meta.textContent = tuningControlMeta(control);
  const input = createTuningInput(control);
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(input);
  if (control.unit) {
    const unit = document.createElement('span');
    unit.className = 'tuning-unit';
    unit.textContent = control.unit;
    valueWrap.append(unit);
  }
  row.append(label, meta, valueWrap);
  return row;
}

function createTuningInput(control) {
  const disabled = tuningControlDisabled(control);
  const value = getTuningValue(control.key);
  if (control.type === 'select' || control.type === 'nullableBool') {
    const select = document.createElement('select');
    select.dataset.tuningKey = control.key;
    select.disabled = disabled;
    const options = control.type === 'nullableBool'
      ? [['', 'default'], ['true', 'on'], ['false', 'off']]
      : control.options;
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionLabel;
      select.append(option);
    }
    select.value = control.type === 'nullableBool' ? nullableBoolSelectValue(value) : String(value ?? '');
    return select;
  }
  if (control.type === 'checkbox') {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.tuningKey = control.key;
    checkbox.checked = Boolean(value);
    checkbox.disabled = disabled;
    return checkbox;
  }
  const input = document.createElement('input');
  input.dataset.tuningKey = control.key;
  input.type = control.type === 'text' ? 'text' : 'number';
  if (control.min !== undefined) input.min = String(control.min);
  if (control.max !== undefined) input.max = String(control.max);
  if (control.step !== undefined) input.step = String(control.step);
  input.value = value === null || value === undefined ? '' : String(value);
  input.disabled = disabled;
  return input;
}

function tuningInputValue(control, input) {
  if (control.type === 'checkbox') return Boolean(input.checked);
  if (control.type === 'nullableBool') {
    if (input.value === '') return null;
    return input.value === 'true';
  }
  if (control.type === 'number') {
    if (input.value === '') return control.nullable ? null : getTuningValue(control.key);
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return getTuningValue(control.key);
    if (Number.isInteger(Number(control.step || 1))) return Math.round(raw);
    return raw;
  }
  const text = String(input.value || '').trim();
  return text || (control.nullable ? null : '');
}

function tuningControlDisabled(control) {
  if (control.lock === 'disabled') return true;
  if (control.lock === 'micOff' && state.sessionState === SESSION_STATES.RUNNING && state.micState === MIC_STATES.LISTENING) return true;
  if (control.backend && getTuningValue('asr.backend') !== control.backend) return true;
  return false;
}

function tuningControlMeta(control) {
  if (control.lock === 'disabled') return 'later';
  if (control.backend && getTuningValue('asr.backend') !== control.backend) return 'inactive';
  if (control.lock === 'micOff' && state.sessionState === SESSION_STATES.RUNNING && state.micState === MIC_STATES.LISTENING) return 'mic off';
  return 'live';
}


function nullableBoolSelectValue(value) {
  if (value === null || value === undefined) return '';
  return value ? 'true' : 'false';
}

function getTuningValue(path) {
  let cur = state.tuningSettings;
  for (const part of String(path).split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setTuningValue(path, value) {
  const parts = String(path).split('.');
  let cur = state.tuningSettings;
  for (const part of parts.slice(0, -1)) {
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function deltaForTuningPath(path, value) {
  const parts = String(path).split('.');
  const root = {};
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

function cloneSettings(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function mergeSettings(base, override) {
  const merged = cloneSettings(base);
  mergeSettingsInto(merged, override || {});
  return merged;
}

function mergeSettingsInto(target, override) {
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      mergeSettingsInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
}


function renderHistorySettings() {
  els.historySettingsSummary.textContent = 'off';
  els.historySaveSessions.checked = false;
  els.historySaveSessions.disabled = true;
  els.historyRetentionDays.value = '7';
  els.historyRetentionDays.disabled = true;
}

function applyTtsConfig(tts) {
  const settings = cloneSettings(tts || {});
  const options = cloneSettings(settings.options || {});
  delete settings.options;
  state.ttsSettings = mergeSettings(DEFAULT_TTS_SETTINGS, settings);
  state.ttsOptions = mergeSettings(DEFAULT_TTS_OPTIONS, options);
  renderTtsSettings();
}

function mergeStoredTtsConfigIntoState() {
  // localStorage-merge runs once at init only. Re-running it after every
  // submit would overwrite in-session mode/reference_source changes back to
  // defaults (those fields are intentionally not persisted).
  const stored = loadVoxcpm2VoiceConfig();
  if (Object.keys(stored).length) {
    state.ttsSettings.voxcpm2.languages = stored;
  }
  const ttsGlobal = loadTtsGlobalConfig();
  if (ttsGlobal) {
    if (typeof ttsGlobal.enabled === 'boolean') state.ttsSettings.enabled = ttsGlobal.enabled;
    if (ttsGlobal.backend) state.ttsSettings.backend = ttsGlobal.backend;
    if (ttsGlobal.kokoro_voices) {
      state.ttsSettings.kokoro = state.ttsSettings.kokoro || { voices: {} };
      state.ttsSettings.kokoro.voices = {
        ...(state.ttsSettings.kokoro.voices || {}),
        ...ttsGlobal.kokoro_voices,
      };
    }
  }
  renderTtsSettings();
}

function loadVoxcpm2VoiceConfig() {
  try {
    const raw = localStorage.getItem(VOXCPM2_VOICE_CONFIG_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const normalized = {};
    for (const [tag, entry] of Object.entries(parsed)) {
      const cleanTag = String(tag || '').trim().toLowerCase();
      if (!cleanTag) continue;
      const cleanEntry = normalizeVoxcpm2LanguageEntry(entry);
      if (cleanEntry) normalized[cleanTag] = cleanEntry;
    }
    return normalized;
  } catch (_) {
    return {};
  }
}

function loadTtsGlobalConfig() {
  try {
    const raw = localStorage.getItem(TTS_GLOBAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    if (typeof parsed.enabled === 'boolean') out.enabled = parsed.enabled;
    if (typeof parsed.backend === 'string' && parsed.backend) out.backend = parsed.backend;
    if (parsed.kokoro_voices && typeof parsed.kokoro_voices === 'object') {
      const voices = {};
      for (const [language, voice] of Object.entries(parsed.kokoro_voices)) {
        if (typeof language === 'string' && typeof voice === 'string' && language && voice) {
          voices[language] = voice;
        }
      }
      if (Object.keys(voices).length) out.kokoro_voices = voices;
    }
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
}

function persistTtsGlobalConfig() {
  try {
    const payload = {
      enabled: Boolean(state.ttsSettings.enabled),
      backend: String(state.ttsSettings.backend || ''),
      kokoro_voices: { ...(state.ttsSettings.kokoro?.voices || {}) },
    };
    localStorage.setItem(TTS_GLOBAL_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {
    // ignore quota / disabled storage
  }
}

function persistVoxcpm2VoiceConfig() {
  try {
    const stripped = {};
    const languages = state.ttsSettings.voxcpm2.languages || {};
    for (const [tag, entry] of Object.entries(languages)) {
      if (!entry || typeof entry !== 'object') continue;
      const out = {};
      // Persist only the fields we keep across reloads. mode and reference_source
      // are intentionally omitted — they always reset to defaults on hard refresh.
      if (entry.gender !== undefined) out.gender = entry.gender;
      if (entry.style !== undefined) out.style = entry.style;
      if (entry.stable_gender !== undefined) out.stable_gender = entry.stable_gender;
      if (entry.trim_seconds !== undefined) out.trim_seconds = entry.trim_seconds;
      if (Object.keys(out).length) stripped[tag] = out;
    }
    localStorage.setItem(VOXCPM2_VOICE_CONFIG_STORAGE_KEY, JSON.stringify(stripped));
  } catch (_) {
    // ignore quota / disabled storage
  }
}

function normalizeVoxcpm2LanguageEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // Mode and reference_source are not persisted: always restored from defaults.
  const out = { ...VOXCPM2_DEFAULT_LANGUAGE_CONFIG };
  const allowedGenders = new Set(['female', 'male']);
  const allowedStyles = new Set(['neutral', 'warm', 'calm', 'clear']);
  if (allowedGenders.has(entry.gender)) out.gender = entry.gender;
  if (allowedStyles.has(entry.style)) out.style = entry.style;
  if (allowedGenders.has(entry.stable_gender)) out.stable_gender = entry.stable_gender;
  const trimRaw = Number(entry.trim_seconds);
  if (Number.isFinite(trimRaw)) {
    out.trim_seconds = Math.min(60, Math.max(1, trimRaw));
  }
  return out;
}

function handleTtsEnabledChange() {
  const previous = cloneSettings(state.ttsSettings);
  const enabled = Boolean(els.ttsEnabled.checked);
  state.ttsSettings.enabled = enabled;
  persistTtsGlobalConfig();
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings({ enabled }, previous);
}

function handleTtsBackendChange() {
  const previous = cloneSettings(state.ttsSettings);
  const backend = String(els.ttsBackendSelect.value || '');
  if (!backend) return;
  state.ttsSettings.backend = backend;
  persistTtsGlobalConfig();
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings({ backend }, previous);
}

function handleTtsSettingChange(event) {
  const input = event.target;
  if (!input || input.disabled) return;
  const previous = cloneSettings(state.ttsSettings);
  const kind = input.dataset.ttsKind || '';
  const language = input.dataset.ttsLanguage || '';
  if (kind === 'kokoro-voice' && language) {
    const value = String(input.value || '');
    state.ttsSettings.kokoro.voices[language] = value;
    persistTtsGlobalConfig();
    renderTtsSettings({ preserveScroll: true });
    submitTtsSettings({ kokoro: { voices: { [language]: value } } }, previous);
    return;
  }
  if (kind === 'voxcpm2-picker-language') {
    state.ttsVoxcpm2SelectedTag = String(input.value || '').toLowerCase();
    renderTtsSettings({ preserveScroll: true });
    return;
  }
  const tag = String(language || '').toLowerCase();
  if (!tag) return;
  if (kind === 'voxcpm2-mode') {
    const nextMode = input.value === 'reference_audio' ? 'reference_audio' : 'description';
    updateVoxcpm2LanguageConfig(tag, (current) => {
      if (nextMode === 'description') {
        return {
          mode: 'description',
          gender: current.gender || 'female',
          style: current.style || 'neutral',
        };
      }
      return {
        mode: 'reference_audio',
        reference_source: 'stable_generated',
        stable_gender: current.stable_gender || 'female',
        trim_seconds: Number.isFinite(Number(current.trim_seconds))
          ? Number(current.trim_seconds)
          : VOXCPM2_DEFAULT_TRIM_SECONDS,
      };
    }, previous);
    return;
  }
  if (kind === 'voxcpm2-gender') {
    const allowed = new Set(['female', 'male']);
    const value = allowed.has(input.value) ? input.value : 'female';
    updateVoxcpm2LanguageConfig(tag, (current) => ({
      mode: 'description',
      gender: value,
      style: current.style || 'neutral',
    }), previous);
    return;
  }
  if (kind === 'voxcpm2-style') {
    const allowed = new Set(['neutral', 'warm', 'calm', 'clear']);
    const value = allowed.has(input.value) ? input.value : 'neutral';
    updateVoxcpm2LanguageConfig(tag, (current) => ({
      mode: 'description',
      gender: current.gender || 'female',
      style: value,
    }), previous);
    return;
  }
  if (kind === 'voxcpm2-reference-source') {
    const allowed = new Set(['last_speech', 'stable_generated']);
    const value = allowed.has(input.value) ? input.value : 'last_speech';
    updateVoxcpm2LanguageConfig(tag, (current) => {
      const next = {
        mode: 'reference_audio',
        reference_source: value,
        trim_seconds: Number.isFinite(Number(current.trim_seconds))
          ? Number(current.trim_seconds)
          : VOXCPM2_DEFAULT_TRIM_SECONDS,
      };
      if (value === 'stable_generated') {
        next.stable_gender = current.stable_gender || 'female';
      }
      return next;
    }, previous);
    return;
  }
  if (kind === 'voxcpm2-stable-gender') {
    const allowed = new Set(['female', 'male']);
    const value = allowed.has(input.value) ? input.value : 'female';
    updateVoxcpm2LanguageConfig(tag, (current) => ({
      mode: 'reference_audio',
      reference_source: 'stable_generated',
      trim_seconds: Number.isFinite(Number(current.trim_seconds))
        ? Number(current.trim_seconds)
        : VOXCPM2_DEFAULT_TRIM_SECONDS,
      stable_gender: value,
    }), previous);
    return;
  }
  if (kind === 'voxcpm2-trim-seconds') {
    const value = normalizeTtsNumber(input.value, VOXCPM2_DEFAULT_TRIM_SECONDS, 1, 60);
    updateVoxcpm2LanguageConfig(tag, (current) => {
      const allowed = new Set(['last_speech', 'stable_generated']);
      const source = allowed.has(current.reference_source) ? current.reference_source : 'last_speech';
      const next = { mode: 'reference_audio', reference_source: source, trim_seconds: value };
      if (source === 'stable_generated') {
        next.stable_gender = current.stable_gender || 'female';
      }
      return next;
    }, previous);
    return;
  }
}

function updateVoxcpm2LanguageConfig(tag, updater, previous) {
  const stored = state.ttsSettings.voxcpm2.languages?.[tag];
  const current = { ...VOXCPM2_DEFAULT_LANGUAGE_CONFIG, ...(stored || {}) };
  const next = updater(current);
  state.ttsSettings.voxcpm2.languages = {
    ...(state.ttsSettings.voxcpm2.languages || {}),
    [tag]: next,
  };
  persistVoxcpm2VoiceConfig();
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings(
    { voxcpm2: { languages: state.ttsSettings.voxcpm2.languages } },
    previous,
  );
}

function syncVoxcpm2VoiceConfigToBackend() {
  // Push localStorage-restored TTS settings to the backend after page load,
  // so the backend's runtime overrides match what the UI shows.
  const delta = {
    enabled: Boolean(state.ttsSettings.enabled),
    backend: String(state.ttsSettings.backend || ''),
    kokoro: { voices: { ...(state.ttsSettings.kokoro?.voices || {}) } },
    voxcpm2: { languages: state.ttsSettings.voxcpm2.languages || {} },
  };
  submitTtsSettings(delta, cloneSettings(state.ttsSettings));
}

function handleTargetTextClick(event) {
  const button = event.target?.closest?.('.bubble-speak-button');
  if (button && els.targetText.contains(button)) {
    handleBubbleAudioAction(button, button.closest('.turn-part'));
    return;
  }
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    const row = event.target?.closest?.('.turn-part.is-replayable');
    if (row && els.targetText.contains(row)) {
      const innerButton = row.querySelector('.bubble-speak-button');
      if (innerButton) handleBubbleAudioAction(innerButton, row);
    }
  }
}

function handleBubbleAudioAction(button, bubble) {
  const action = button.dataset.audioAction || 'replay';
  if (action === 'stop') {
    flashReplayBubble(bubble);
    audioQueue.stop();
    return;
  }
  flashReplayBubble(bubble);
  triggerReplayFromButton(button);
}

function flashReplayBubble(bubble) {
  if (!bubble) return;
  bubble.classList.add('is-replay-flash');
  setTimeout(() => bubble.classList.remove('is-replay-flash'), 200);
}

function triggerReplayFromButton(button) {
  const text = String(button.dataset.replayText || '').trim();
  const laneId = String(button.dataset.replayLane || '').trim();
  if (!text || !laneId) return;
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (!state.ttsSettings.enabled) return;
  state.socket?.replayTts({ laneId, text });
}

function handleTtsSettingsClick(event) {
  const button = event.target?.closest?.('[data-tts-action]');
  if (!button) return;
  if (button.dataset.ttsAction === 'toggle-prompt-preview') {
    state.ttsPromptInspectOpen = !state.ttsPromptInspectOpen;
    renderTtsSettings({ preserveScroll: true });
  }
}

function playStableSamplePreview(tag, gender, info) {
  if (!tag || !gender || !info?.exists) return;
  const cacheBust = encodeURIComponent(info.generated_at || String(Date.now()));
  const url = `/api/voice-library/stable/${encodeURIComponent(tag)}/${encodeURIComponent(gender)}/audio.wav?t=${cacheBust}`;
  audioQueue.clear();
  audioQueue.enqueue({ url, duration_ms: 0, replay: true });
}

function applyVoiceLibraryStatus(stable) {
  const next = {};
  if (stable && typeof stable === 'object') {
    for (const [tag, entry] of Object.entries(stable)) {
      next[String(tag).toLowerCase()] = entry && typeof entry === 'object'
        ? {
          has_reference_text: Boolean(entry.has_reference_text),
          reference_text: String(entry.reference_text || ''),
          samples: entry.samples && typeof entry.samples === 'object' ? entry.samples : {},
        }
        : { has_reference_text: false, reference_text: '', samples: {} };
    }
  }
  state.voiceLibraryStable = next;
}

function stableSampleInfo(tag, gender) {
  return state.voiceLibraryStable[tag]?.samples?.[gender] || { exists: false, generated_at: null };
}

async function handleGenerateStableSample(tag, gender, engine) {
  if (!tag || !gender || !engine || state.voiceLibraryBusyTag) return;
  state.voiceLibraryBusyTag = `${tag}:${gender}`;
  renderVoiceLibraryPage();
  renderTtsSettings({ preserveScroll: true });
  try {
    const result = await api.generateStableVoiceSample({ language: tag, gender, engine });
    const resolvedGender = String(result?.gender || gender);
    if (result?.info && typeof result.info === 'object') {
      const existing = state.voiceLibraryStable[tag] || { has_reference_text: false, samples: {} };
      state.voiceLibraryStable = {
        ...state.voiceLibraryStable,
        [tag]: {
          ...existing,
          samples: { ...(existing.samples || {}), [resolvedGender]: result.info },
        },
      };
      playStableSamplePreview(tag, resolvedGender, result.info);
    }
  } catch (error) {
    setStatus('error');
  } finally {
    state.voiceLibraryBusyTag = '';
    renderVoiceLibraryPage();
    renderTtsSettings({ preserveScroll: true });
  }
}

async function submitTtsSettings(delta, previousSettings) {
  state.ttsUpdateBusy = true;
  renderTtsSettings({ preserveScroll: true });
  try {
    const payload = await api.updateTtsSettings(delta);
    applyTtsConfig(payload.tts || {});
  } catch (error) {
    state.ttsSettings = previousSettings;
    setStatus('error');
  } finally {
    state.ttsUpdateBusy = false;
    renderTtsSettings({ preserveScroll: true });
  }
}

function toggleTtsGroup(groupName) {
  if (!groupName) return;
  if (state.ttsExpandedGroups.has(groupName)) {
    state.ttsExpandedGroups.delete(groupName);
  } else {
    state.ttsExpandedGroups.add(groupName);
  }
  renderTtsSettings({ preserveScroll: true });
}

function renderTtsSettings({ preserveScroll = false } = {}) {
  els.ttsOutputState.textContent = ttsSummary();
  if (!els.ttsEnabled || !els.ttsBackendSelect) return;
  els.ttsEnabled.checked = Boolean(state.ttsSettings.enabled);
  els.ttsEnabled.disabled = state.ttsUpdateBusy;
  renderTtsBackendSelect();
  if (!els.ttsSettingsGroups || els.settingsSheet.hidden || state.settingsPage !== 'audio') return;
  const scrollEl = preserveScroll ? tuningScrollElement() : null;
  const scrollTop = scrollEl?.scrollTop || 0;
  const availableBackends = new Set(ttsBackendOptions().map((option) => option.value));
  const groups = [
    { name: 'Kokoro', backend: 'kokoro', rows: kokoroTtsRows() },
    { name: 'VoxCPM2', backend: 'voxcpm2', rows: voxcpm2TtsRows('voxcpm2') },
    { name: 'NanoVLLM VoxCPM', backend: 'nanovllm_voxcpm', rows: voxcpm2TtsRows('nanovllm_voxcpm') },
  ].filter((group) => availableBackends.has(group.backend));
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const expanded = state.ttsExpandedGroups.has(group.name);
    const section = document.createElement('section');
    section.className = 'setting-group tuning-group';
    section.setAttribute('aria-label', group.name);
    section.classList.toggle('is-expanded', expanded);
    const title = document.createElement('button');
    title.className = 'tuning-group-toggle';
    title.type = 'button';
    title.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    title.addEventListener('click', () => toggleTtsGroup(group.name));
    const titleText = document.createElement('span');
    titleText.className = 'tuning-group-title';
    titleText.textContent = group.name;
    const icon = document.createElement('span');
    icon.className = 'tuning-group-icon';
    icon.setAttribute('aria-hidden', 'true');
    title.append(titleText, icon);
    const body = document.createElement('div');
    body.className = 'tuning-group-body';
    body.hidden = !expanded;
    if (expanded) {
      for (const row of group.rows) body.append(row);
    }
    section.append(title, body);
    fragment.append(section);
  }
  els.ttsSettingsGroups.replaceChildren(fragment);
  if (scrollEl) scrollEl.scrollTop = scrollTop;
}

function renderTtsBackendSelect() {
  const current = String(state.ttsSettings.backend || 'kokoro');
  const options = ttsBackendOptions();
  const existing = Array.from(els.ttsBackendSelect.options).map((option) => option.value).join('|');
  const next = options.map((option) => option.value).join('|');
  if (existing !== next) {
    els.ttsBackendSelect.replaceChildren();
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      els.ttsBackendSelect.append(el);
    }
  }
  els.ttsBackendSelect.value = current;
  els.ttsBackendSelect.disabled = state.ttsUpdateBusy || options.length === 0;
}

function kokoroTtsRows() {
  const active = state.ttsSettings.backend === 'kokoro';
  return ttsPresetLanguages().map((language) => {
    const options = state.ttsOptions.kokoro_voices?.[language] || [];
    const disabled = state.ttsUpdateBusy || !active || options.length === 0;
    const value = state.ttsSettings.kokoro.voices?.[language] || options[0]?.value || '';
    return createTtsSelectRow({
      label: `${language} voice`,
      value,
      options,
      disabled,
      kind: 'kokoro-voice',
      language,
      emptyLabel: 'Unsupported',
    });
  });
}

function voxcpm2TtsRows(backend) {
  const active = state.ttsSettings.backend === backend;
  const disabled = state.ttsUpdateBusy || !active;
  const tag = currentVoxcpm2PickerTag();
  const config = voxcpm2LanguageConfig(tag);
  const rows = [createVoxcpm2LanguagePickerRow({ tag, disabled })];
  rows.push(createTtsSelectRow({
    label: 'Voice instruction',
    value: config.mode,
    options: voxcpm2ModeOptions(),
    disabled,
    kind: 'voxcpm2-mode',
    language: tag,
    emptyLabel: 'From description',
  }));
  if (config.mode === 'description') {
    rows.push(createTtsSelectRow({
      label: 'Voice gender',
      value: config.gender || 'female',
      options: voxcpm2GenderOptions(),
      disabled,
      kind: 'voxcpm2-gender',
      language: tag,
      emptyLabel: 'Female',
    }));
    rows.push(createTtsSelectRow({
      label: 'Speaking style',
      value: config.style || 'neutral',
      options: voxcpm2StyleOptions(),
      disabled,
      kind: 'voxcpm2-style',
      language: tag,
      emptyLabel: 'Neutral',
    }));
    rows.push(createDescriptionModeWarningRow());
  } else {
    rows.push(createTtsSelectRow({
      label: 'Reference audio',
      value: config.reference_source || 'last_speech',
      options: voxcpm2ReferenceSourceOptions(),
      disabled,
      kind: 'voxcpm2-reference-source',
      language: tag,
      emptyLabel: 'Last speech fragment',
    }));
    if ((config.reference_source || 'last_speech') === 'stable_generated') {
      rows.push(createTtsSelectRow({
        label: 'Voice gender',
        value: config.stable_gender || 'female',
        options: voxcpm2GenderOptions(),
        disabled,
        kind: 'voxcpm2-stable-gender',
        language: tag,
        emptyLabel: 'Female',
      }));
    }
    rows.push(createTtsNumberRow({
      label: 'Trim audio',
      value: Number.isFinite(Number(config.trim_seconds)) ? Number(config.trim_seconds) : VOXCPM2_DEFAULT_TRIM_SECONDS,
      min: 1,
      max: 60,
      step: 1,
      unit: 's',
      disabled,
      kind: 'voxcpm2-trim-seconds',
      language: tag,
    }));
    if ((config.reference_source || 'last_speech') === 'stable_generated') {
      rows.push(createStableSampleStatusRow({
        tag,
        gender: config.stable_gender || 'female',
      }));
    }
  }
  rows.push(createTtsPromptInspectRows(active, tag, config));
  return rows;
}

function createDescriptionModeWarningRow() {
  const row = document.createElement('div');
  row.className = 'tts-warning-row';
  row.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>'
    + '<path d="M12 9v4"/>'
    + '<path d="M12 17h.01"/>'
    + '</svg>';
  const text = document.createElement('span');
  text.textContent = 'Voice description is experimental. Output can differ noticeably from the prompt. Fine for tinkering, not reliable for serious use.';
  row.append(text);
  return row;
}

function createStableSampleStatusRow({ tag, gender }) {
  const row = document.createElement('div');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = 'Stable sample';
  const info = stableSampleInfo(tag, gender);
  const valueEl = document.createElement('span');
  valueEl.className = 'tts-stable-status';
  if (info.exists) {
    valueEl.textContent = formatStableSampleStatus(info);
  } else if (tag === 'en') {
    valueEl.textContent = 'Not generated yet';
  } else {
    valueEl.textContent = 'Using English sample';
  }
  row.append(labelEl, valueEl);
  return row;
}

function formatStableSampleStatus(info) {
  if (!info?.generated_at) return 'Sample · available';
  try {
    const stamp = new Date(info.generated_at);
    if (!Number.isNaN(stamp.getTime())) {
      const time = stamp.toLocaleString([], {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      return `Sample · ${time}`;
    }
  } catch (_) {}
  return 'Sample · available';
}

function createVoxcpm2LanguagePickerRow({ tag, disabled }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = 'Configure for';
  const select = document.createElement('select');
  select.dataset.ttsKind = 'voxcpm2-picker-language';
  select.disabled = disabled;
  const { active: activeTags, rest: restTags } = voxcpm2PickerLanguageGroups();
  if (activeTags.length) {
    const group = document.createElement('optgroup');
    group.label = 'This session';
    for (const t of activeTags) group.append(_voxcpm2LanguageOption(t));
    select.append(group);
  }
  if (restTags.length) {
    const group = document.createElement('optgroup');
    group.label = 'All languages';
    for (const t of restTags) group.append(_voxcpm2LanguageOption(t));
    select.append(group);
  }
  select.value = tag;
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(select);
  row.append(labelEl, valueWrap);
  return row;
}

function _voxcpm2LanguageOption(tag) {
  const option = document.createElement('option');
  option.value = tag;
  option.textContent = languageNameForBcp47(tag) || tag;
  return option;
}

function voxcpm2PickerLanguageGroups() {
  const sessionTags = [];
  const seen = new Set();
  for (const name of ttsPresetLanguages()) {
    const tag = bcp47ForLanguageName(name);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    sessionTags.push(tag);
  }
  const restTags = [];
  for (const item of languages) {
    const tag = item.bcp47;
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    restTags.push(tag);
  }
  restTags.sort((a, b) => (languageNameForBcp47(a) || a).localeCompare(languageNameForBcp47(b) || b));
  return { active: sessionTags, rest: restTags };
}

function createTtsPromptInspectRows(active, tag, config) {
  const fragment = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'tuning-row tts-action-row';
  const label = document.createElement('span');
  label.className = 'tuning-label';
  label.textContent = 'Prompt';
  const button = document.createElement('button');
  button.className = 'tts-inspect-button';
  button.type = 'button';
  button.dataset.ttsAction = 'toggle-prompt-preview';
  button.disabled = !active;
  button.textContent = state.ttsPromptInspectOpen ? 'Hide prompt' : 'Inspect prompt';
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(button);
  row.append(label, valueWrap);
  fragment.append(row);
  if (state.ttsPromptInspectOpen && active) {
    fragment.append(createVoxcpm2PromptPreview(tag, config));
  }
  return fragment;
}

function createVoxcpm2PromptPreview(tag, config) {
  const languageName = languageNameForBcp47(tag) || tag;
  const preview = document.createElement('div');
  preview.className = 'tts-prompt-preview';
  const textLabel = document.createElement('span');
  textLabel.className = 'tts-prompt-preview-label';
  textLabel.textContent = `Text instruction for ${languageName}`;
  const textValue = document.createElement('code');
  textValue.textContent = voxcpm2InstructionsPreview(languageName, config);
  const sampleLabel = document.createElement('span');
  sampleLabel.className = 'tts-prompt-preview-label';
  sampleLabel.textContent = 'Reference audio';
  const sampleValue = document.createElement('code');
  if (config.mode === 'reference_audio') {
    const trim = Number.isFinite(Number(config.trim_seconds)) ? Number(config.trim_seconds) : VOXCPM2_DEFAULT_TRIM_SECONDS;
    sampleValue.textContent = `Last speech fragment from this session, trimmed to ${trim}s.`;
  } else {
    sampleValue.textContent = 'None';
  }
  preview.append(textLabel, textValue, sampleLabel, sampleValue);
  return preview;
}

function voxcpm2InstructionsPreview(languageName, config) {
  if (config.mode === 'reference_audio') {
    return [
      `Speak in ${languageName}.`,
      `Pronounce numbers, abbreviations, and short fragments in ${languageName}.`,
      'Use the reference audio as the voice reference.',
      `Do not infer the output language from the reference audio; the output language is ${languageName}.`,
      'Do not copy or continue the content of the reference audio.',
      'Speak clearly and generate only the requested text.',
    ].join(' ');
  }
  const gender = VOXCPM2_GENDER_CLAUSES[config.gender] || VOXCPM2_GENDER_CLAUSES.female;
  const style = VOXCPM2_STYLE_CLAUSES[config.style] || VOXCPM2_STYLE_CLAUSES.neutral;
  return [
    `Speak in ${languageName}.`,
    `Pronounce numbers, abbreviations, and short fragments in ${languageName}.`,
    gender,
    style,
    'Speak clearly and generate only the requested text.',
  ].join(' ');
}

function createTtsSelectRow({ label, value, options, disabled, kind, language, emptyLabel }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const select = document.createElement('select');
  select.dataset.ttsKind = kind;
  select.dataset.ttsLanguage = language;
  select.disabled = disabled;
  const safeOptions = options.length ? options : [{ value: '', label: emptyLabel }];
  for (const option of safeOptions) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    optionEl.disabled = option.disabled === true;
    select.append(optionEl);
  }
  select.value = value;
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(select);
  row.append(labelEl, valueWrap);
  return row;
}

function createTtsNumberRow({ label, value, min, max, step, unit, disabled, kind, language }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.dataset.ttsKind = kind;
  if (language) input.dataset.ttsLanguage = language;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.disabled = disabled;
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(input);
  if (unit) {
    const unitEl = document.createElement('span');
    unitEl.className = 'tuning-unit';
    unitEl.textContent = unit;
    valueWrap.append(unitEl);
  }
  row.append(labelEl, valueWrap);
  return row;
}

function voxcpm2LanguageConfig(tag) {
  const stored = state.ttsSettings.voxcpm2.languages?.[tag];
  if (!stored || typeof stored !== 'object') {
    return { ...VOXCPM2_DEFAULT_LANGUAGE_CONFIG };
  }
  if (stored.mode === 'reference_audio') {
    const cfg = {
      mode: 'reference_audio',
      reference_source: stored.reference_source || 'stable_generated',
      trim_seconds: Number.isFinite(Number(stored.trim_seconds))
        ? Number(stored.trim_seconds)
        : VOXCPM2_DEFAULT_TRIM_SECONDS,
    };
    if (cfg.reference_source === 'stable_generated') {
      cfg.stable_gender = stored.stable_gender || 'female';
    }
    return cfg;
  }
  return {
    mode: 'description',
    gender: stored.gender || 'female',
    style: stored.style || 'neutral',
  };
}

function voxcpm2ModeOptions() {
  return state.ttsOptions.voxcpm2_modes || DEFAULT_TTS_OPTIONS.voxcpm2_modes;
}

function voxcpm2GenderOptions() {
  return state.ttsOptions.voxcpm2_genders || DEFAULT_TTS_OPTIONS.voxcpm2_genders;
}

function voxcpm2StyleOptions() {
  return state.ttsOptions.voxcpm2_styles || DEFAULT_TTS_OPTIONS.voxcpm2_styles;
}

function voxcpm2ReferenceSourceOptions() {
  return state.ttsOptions.voxcpm2_reference_sources || DEFAULT_TTS_OPTIONS.voxcpm2_reference_sources;
}

function currentVoxcpm2PickerTag() {
  const known = new Set(languages.map((item) => item.bcp47).filter(Boolean));
  if (state.ttsVoxcpm2SelectedTag && known.has(state.ttsVoxcpm2SelectedTag)) {
    return state.ttsVoxcpm2SelectedTag;
  }
  const targetTag = bcp47ForLanguageName(currentTtsTargetLanguage());
  if (targetTag && known.has(targetTag)) return targetTag;
  return languages[0]?.bcp47 || 'en';
}

function bcp47ForLanguageName(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  const match = languages.find((item) => item.name === text);
  return match?.bcp47 || '';
}

function languageNameForBcp47(tag) {
  const text = String(tag || '').trim().toLowerCase();
  if (!text) return '';
  const match = languages.find((item) => item.bcp47 === text);
  return match?.name || '';
}

function normalizeTtsNumber(value, fallback, min, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function ttsPresetLanguages() {
  const seen = new Set();
  const out = [];
  for (const language of [state.sideALanguage, state.sideBLanguage]) {
    const normalized = normalizeLanguageName(language);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function currentTtsTargetLanguage() {
  return normalizeLanguageName(currentLane().targetLanguage || state.sideBLanguage);
}

function ttsSummary() {
  if (!state.ttsSettings.enabled) return 'off';
  if (!ttsBackendOptions().length) return 'none loaded';
  return ttsBackendLabel(state.ttsSettings.backend);
}

function ttsBackendLabel(backend) {
  const options = ttsBackendOptions();
  const match = options.find((option) => option.value === backend);
  return match?.label || String(backend || '');
}

function ttsBackendOptions() {
  return Array.isArray(state.ttsOptions.backends) ? state.ttsOptions.backends : DEFAULT_TTS_OPTIONS.backends;
}

function handleVadState(msg) {
  if (!shouldApplyCurrentTurnMessage(msg)) return;
  if (state.sessionState !== SESSION_STATES.RUNNING) {
    hideVadHint();
    return;
  }
  if (msg.speech_detected !== true) {
    hideVadHint();
    return;
  }
  showVadHint();
}

function showVadHint() {
  els.vadBadge.hidden = false;
  if (state.vadHintTimer) {
    clearTimeout(state.vadHintTimer);
  }
  state.vadHintTimer = setTimeout(() => {
    state.vadHintTimer = null;
    hideVadHint();
  }, 900);
}

function hideVadHint() {
  if (state.vadHintTimer) {
    clearTimeout(state.vadHintTimer);
    state.vadHintTimer = null;
  }
  els.vadBadge.hidden = true;
}

function levelToHaloUnit(level) {
  // Visual-only gain so the halo stays responsive on devices that hand back
  // very low raw peaks (older iPhones, web audio with internal AGC).
  const visual = Math.min(1, level * 8);
  if (visual <= 0) return 0;
  // dB mapping (-50 dB → 0, 0 dB → 1) spreads quiet→loud across the range.
  const db = 20 * Math.log10(visual);
  return Math.max(0, Math.min(1, (db + 50) / 50));
}

function renderMicLevel(value) {
  const level = normalizeLevel(value);
  state.audioSettings.inputLevel = level;
  const percent = Math.round(level * 100);
  els.micLevelFill.style.transform = `scaleX(${level.toFixed(3)})`;
  els.micLevel.setAttribute('aria-valuenow', String(percent));
  els.micLevel.classList.toggle('is-hot', level >= 0.9);
  // Baseline halo when listening (always-visible mic-ready indicator); audio
  // level adds on top so any sound is reflected even at quiet levels.
  const BASELINE_HALO = 0.4;
  const haloLevel = state.micState === MIC_STATES.LISTENING
    ? Math.min(1, BASELINE_HALO + (1 - BASELINE_HALO) * levelToHaloUnit(level))
    : 0;
  const clipRisk = state.micState === MIC_STATES.LISTENING && level >= 0.95;
  const hot = level >= 0.85;
  els.micToggleButton.classList.toggle('is-clip-risk', clipRisk);
  const r = clipRisk ? 185 : hot ? 245 : 59;
  const g = clipRisk ? 28 : hot ? 158 : 130;
  const b = clipRisk ? 28 : hot ? 11 : 246;
  const alpha = haloLevel ? 0.08 + haloLevel * (clipRisk ? 0.42 : hot ? 0.36 : 0.3) : 0;
  const scale = 1 + haloLevel * 0.55;
  els.micToggleButton.style.setProperty('--mic-toggle-halo-scale', scale.toFixed(3));
  els.micToggleButton.style.setProperty(
    '--mic-toggle-halo-color',
    haloLevel ? `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})` : 'transparent',
  );
  els.micToggleButton.style.boxShadow = '';
}

function renderLanguageControls() {
  const lane = currentLane();
  const setup = state.sessionState === SESSION_STATES.SETUP;
  const isConnecting = state.status === 'connecting';
  const shouldDisable = !setup || isConnecting;

  els.sourceLanguagePillText.textContent = lane.sourceLanguage;
  els.targetLanguagePillText.textContent = lane.targetLanguage;

  els.sourceLanguagePill.hidden = !setup;
  els.targetLanguagePill.hidden = !setup;

  els.sourceLanguagePill.disabled = isConnecting;
  els.targetLanguagePill.disabled = isConnecting;

  els.sourceLanguagePill.setAttribute('aria-label', `Source language: ${lane.sourceLanguage}`);
  els.targetLanguagePill.setAttribute('aria-label', `Target language: ${lane.targetLanguage}`);
}

const RECENT_LANGUAGES_KEY = 'recent_languages';
const DEV_TOOLS_SETTINGS_KEY = 'dev_tools_settings';

function loadDevToolsSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEV_TOOLS_SETTINGS_KEY) || '{}');
    return { showPcExport: Boolean(saved.showPcExport) };
  } catch {
    return { showPcExport: false };
  }
}

function saveDevToolsSettings() {
  localStorage.setItem(DEV_TOOLS_SETTINGS_KEY, JSON.stringify(state.devToolsSettings));
}
const RECENT_MAX = 4;

function getRecentLanguages() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_LANGUAGES_KEY) || '[]');
  } catch {
    return [];
  }
}

function pushRecentLanguage(name) {
  const recent = getRecentLanguages().filter((n) => n !== name);
  recent.unshift(name);
  localStorage.setItem(RECENT_LANGUAGES_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)));
}

let _languageSheetSide = 'source';

function openLanguageSheet(side) {
  _languageSheetSide = side;
  const lane = currentLane();
  const currentLang = side === 'source' ? lane.sourceLanguage : lane.targetLanguage;
  els.languageSheetTitle.textContent = side === 'source' ? 'Source language' : 'Target language';
  els.languageSearch.value = '';
  renderLanguageSheetList(currentLang, '');
  els.languageSheet.hidden = false;
  if (history.state?.view !== 'languageSheet') {
    history.pushState({ view: 'languageSheet' }, '');
  }
}

let _skipLanguageSheetPopstate = false;

function closeLanguageSheet() {
  const wasOpen = !els.languageSheet.hidden;
  els.languageSheet.hidden = true;
  els.languageSearch.value = '';
  _resetLanguageSheetPosition();
  if (wasOpen && history.state?.view === 'languageSheet') {
    _skipLanguageSheetPopstate = true;
    history.back();
  }
}

function setupSheetSwipeClose({ layer, sheet, scrollContainer, onClose, isAllowed }) {
  if (!layer || !sheet) return;
  const SWIPE_CLOSE_THRESHOLD_PCT = 0.40;
  let startY = null;
  let startScrollTop = 0;
  let dragging = false;
  let currentDelta = 0;
  let sheetHeight = 0;
  const onStart = (e) => {
    if (layer.hidden) return;
    if (e.touches.length !== 1) return;
    if (isAllowed && !isAllowed()) return;
    startY = e.touches[0].clientY;
    startScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    sheetHeight = sheet.getBoundingClientRect().height || 0;
    dragging = false;
    currentDelta = 0;
  };
  const onMove = (e) => {
    if (startY === null) return;
    const y = e.touches[0].clientY;
    const delta = y - startY;
    if (delta <= 0) return;
    if (startScrollTop > 0) return;
    if (scrollContainer && scrollContainer.scrollTop > 0) {
      sheet.style.removeProperty('transform');
      sheet.style.removeProperty('transition');
      dragging = false;
      return;
    }
    dragging = true;
    currentDelta = delta;
    // !important needed to beat the entry animation's fill-mode:both,
    // which otherwise keeps "transform: translateY(0)" pinned.
    sheet.style.setProperty('transition', 'none', 'important');
    sheet.style.setProperty('transform', `translateY(${delta}px)`, 'important');
    e.preventDefault();
  };
  const onEnd = () => {
    if (dragging) {
      const threshold = Math.max(40, sheetHeight * SWIPE_CLOSE_THRESHOLD_PCT);
      if (currentDelta > threshold) {
        // Animate the layer opacity together with the sheet so the scrim
        // fades instead of popping when we hide it.
        sheet.style.setProperty('transition', 'transform 0.18s ease', 'important');
        sheet.style.setProperty('transform', 'translateY(100%)', 'important');
        layer.style.setProperty('transition', 'opacity 0.18s ease', 'important');
        layer.style.setProperty('opacity', '0', 'important');
        setTimeout(() => {
          onClose();
          sheet.style.removeProperty('transform');
          sheet.style.removeProperty('transition');
          layer.style.removeProperty('opacity');
          layer.style.removeProperty('transition');
        }, 170);
      } else {
        sheet.style.setProperty('transition', 'transform 0.18s ease', 'important');
        sheet.style.setProperty('transform', 'translateY(0)', 'important');
        // Clear inline after the snap-back transition completes so the
        // entry animation can take over again on next open.
        setTimeout(() => {
          sheet.style.removeProperty('transform');
          sheet.style.removeProperty('transition');
        }, 200);
      }
    }
    startY = null;
    dragging = false;
    currentDelta = 0;
  };
  sheet.addEventListener('touchstart', onStart, { passive: true });
  sheet.addEventListener('touchmove', onMove, { passive: false });
  sheet.addEventListener('touchend', onEnd);
  sheet.addEventListener('touchcancel', onEnd);
}

function _resetLanguageSheetPosition() {
  const sheet = els.languageSheet.querySelector('.bottom-sheet');
  if (!sheet) return;
  sheet.style.marginBottom = '';
  sheet.style.height = '';
}

function _onViewportResize() {
  if (els.languageSheet.hidden) return;
  const vv = window.visualViewport;
  if (!vv) return;
  const kbHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  const sheet = els.languageSheet.querySelector('.bottom-sheet');
  if (!sheet) return;
  if (kbHeight > 50) {
    sheet.style.marginBottom = `${kbHeight}px`;
    sheet.style.height = `${vv.height}px`;
  } else {
    _resetLanguageSheetPosition();
  }
}

function renderLanguageSheetList(currentLang, query) {
  const fragment = document.createDocumentFragment();
  const q = query.toLowerCase();

  if (q) {
    const filtered = languages.filter((l) => l.name.toLowerCase().includes(q));
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'language-option-empty';
      empty.textContent = 'No languages found';
      fragment.appendChild(empty);
    } else {
      for (const item of filtered) fragment.appendChild(_languageRow(item, currentLang));
    }
  } else {
    const recentNames = getRecentLanguages().filter((n) => languages.some((l) => l.name === n));
    if (recentNames.length) {
      fragment.appendChild(_sectionHeader('Recent'));
      for (const name of recentNames) {
        const item = languages.find((l) => l.name === name);
        if (item) fragment.appendChild(_languageRow(item, currentLang));
      }
    }
    const groups = {};
    for (const item of languages) {
      const letter = item.name[0].toUpperCase();
      (groups[letter] = groups[letter] || []).push(item);
    }
    for (const letter of Object.keys(groups).sort()) {
      fragment.appendChild(_sectionHeader(letter));
      for (const item of groups[letter]) fragment.appendChild(_languageRow(item, currentLang));
    }
  }

  els.languageSheetList.replaceChildren(fragment);
}

function _sectionHeader(label) {
  const el = document.createElement('div');
  el.className = 'language-section-header';
  el.textContent = label;
  return el;
}

function _languageRow(item, currentLang) {
  const isActive = item.name === currentLang;
  const row = document.createElement('button');
  row.className = `language-option-row${isActive ? ' is-active' : ''}`;
  row.type = 'button';
  row.innerHTML = `<span>${flagForLanguage(item.name)} ${item.name}</span>${isActive ? '<svg class="language-option-check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}`;
  row.addEventListener('click', () => {
    pushRecentLanguage(item.name);
    setVisibleLanguage(_languageSheetSide, item.name);
    closeLanguageSheet();
  });
  return row;
}

function renderTranscript() {
  renderTurnStream(els.sourceText, state.currentTurn.parts, 'source', state.currentTurn.sourceText);
  renderTurnStream(els.targetText, state.currentTurn.parts, 'target', state.currentTurn.targetText);
  renderDirectionLabels(currentLane());
  pinToBottomIfFollowing(els.sourceText);
  pinToBottomIfFollowing(els.targetText);
}

function renderDirectionLabels(lane) {
  els.turnSourceLanguage.textContent = codeForLanguage(lane.sourceLanguage);
  els.turnTargetLanguage.textContent = codeForLanguage(lane.targetLanguage);
  els.turnSourceLanguage.title = lane.sourceLanguage;
  els.turnTargetLanguage.title = lane.targetLanguage;
}

function codeForLanguage(name) {
  const match = languages.find((item) => item.name === name);
  return (match?.asr || String(name || '').slice(0, 2)).toUpperCase();
}

function renderTurnStream(el, parts, role, fallbackText) {
  const fragment = document.createDocumentFragment();
  for (const part of parts || []) {
    const committedText = role === 'source' ? part.sourceCommittedText : part.targetCommittedText;
    const previewText = role === 'source' ? part.sourcePreviewText : part.targetPreviewText;
    if (!visibleText(committedText, previewText)) continue;
    const row = document.createElement('div');
    row.className = 'turn-part';
    if (part.speechState === 'spoken') row.classList.add('is-spoken');
    if (part.speechState === 'speaking') row.classList.add('is-speaking');
    if (role === 'target' && part.lowQualityReference) row.classList.add('is-low-quality-ref');
    renderTextStream(row, committedText, previewText);
    if (role === 'target' && state.ttsSettings.enabled) {
      const replayText = String(committedText || '').trim();
      const playing = state.audioPlayback;
      const isStopForThis = Boolean(
        playing && (
          (!playing.replay && part.speechState === 'speaking')
          || (playing.replay && part.speechState === 'spoken' && replayText && replayText === String(playing.replayText || ''))
        ),
      );
      if (isStopForThis) {
        row.classList.add('is-replayable');
        row.classList.add('is-playing-audio');
        row.append(createBubbleSpeakButton(replayText, state.currentTurn.laneId, 'stop'));
      } else if (part.speechState === 'spoken' && replayText) {
        row.classList.add('is-replayable');
        row.append(createBubbleSpeakButton(replayText, state.currentTurn.laneId, 'replay'));
      }
    }
    fragment.append(row);
  }
  if (!fragment.childNodes.length && fallbackText) {
    const row = document.createElement('div');
    row.className = 'turn-part';
    row.textContent = String(fallbackText || '');
    fragment.append(row);
  }
  if (!fragment.childNodes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = String(el.dataset.empty || '');
    fragment.append(empty);
  }
  el.replaceChildren(fragment);
}

function createBubbleSpeakButton(text, laneId, mode = 'replay') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bubble-speak-button';
  button.dataset.replayText = text;
  button.dataset.replayLane = laneId;
  if (mode === 'stop') {
    button.classList.add('is-stop');
    button.dataset.audioAction = 'stop';
    button.setAttribute('aria-label', 'Stop playback');
    button.title = 'Stop';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="10"/>'
      + '<rect x="9" y="9" width="6" height="6" rx="1"/>'
      + '</svg>';
  } else {
    button.dataset.audioAction = 'replay';
    button.setAttribute('aria-label', 'Speak');
    button.title = 'Speak';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>'
      + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
      + '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
      + '</svg>';
  }
  return button;
}

function renderTextStream(el, committed, preview) {
  const committedText = String(committed || '');
  const previewText = previewSuffixText(committedText, preview);
  if (!committedText && !previewText) {
    el.replaceChildren();
    return;
  }
  const committedSpan = document.createElement('span');
  committedSpan.className = 'text-committed';
  committedSpan.textContent = committedText;
  const previewSpan = document.createElement('span');
  previewSpan.className = 'text-preview';
  previewSpan.textContent = previewText;
  el.replaceChildren(committedSpan, previewSpan);
}

function buildLocalLanes(sideALanguage, sideBLanguage) {
  return {
    a_to_b: createLane('a_to_b', sideALanguage, sideBLanguage),
    b_to_a: createLane('b_to_a', sideBLanguage, sideALanguage),
  };
}

function createLane(laneId, sourceLanguage, targetLanguage) {
  return {
    laneId,
    sourceLanguage,
    targetLanguage,
  };
}

function createLocalTurn(laneId, lanes) {
  const safeLaneId = LANE_IDS.includes(laneId) ? laneId : 'a_to_b';
  const lane = lanes?.[safeLaneId] || createLane(safeLaneId, 'Dutch', 'English');
  return {
    turnId: '',
    laneId: safeLaneId,
    direction: `${lane.sourceLanguage}->${lane.targetLanguage}`,
    state: TURN_STATES.OPEN_EMPTY,
    sourceLanguage: lane.sourceLanguage,
    targetLanguage: lane.targetLanguage,
    sourceText: '',
    targetText: '',
    speakableTargetText: '',
    canTranslateNow: false,
    canSpeakNow: false,
    parts: [],
  };
}

function normalizeTurnPayload(payload) {
  const fallback = createLocalTurn(currentLaneId(), state.lanes);
  const laneId = LANE_IDS.includes(payload?.lane_id) ? payload.lane_id : fallback.laneId;
  const lane = ensureLane(laneId);
  const parts = Array.isArray(payload?.parts) ? payload.parts.map(normalizeTurnPart) : [];
  const sourceText = String(payload?.source_text || joinPartText(parts, 'source') || '');
  const targetText = String(payload?.target_text || joinPartText(parts, 'target') || '');
  const speakableTargetText = String(payload?.speakable_target_text || joinSpeakableTargetText(parts) || '');
  return {
    turnId: String(payload?.turn_id || fallback.turnId),
    laneId,
    direction: String(payload?.direction || `${lane.sourceLanguage}->${lane.targetLanguage}`),
    state: String(payload?.state || TURN_STATES.OPEN_EMPTY),
    sourceLanguage: normalizeLanguageName(payload?.source_language || lane.sourceLanguage),
    targetLanguage: normalizeLanguageName(payload?.target_language || lane.targetLanguage),
    sourceText,
    targetText,
    speakableTargetText,
    canTranslateNow: Boolean(payload?.can_translate_now ?? joinTranslatableSourcePreviewText(parts)),
    canSpeakNow: Boolean(payload?.can_speak_now ?? speakableTargetText),
    parts,
  };
}

function normalizeTurnPart(part) {
  const sourceCommittedText = String(part?.source_committed_text || '');
  const sourcePreviewText = String(part?.source_preview_text || '');
  const targetCommittedText = String(part?.target_committed_text || '');
  const targetPreviewText = String(part?.target_preview_text || '');
  return {
    partId: String(part?.part_id || ''),
    speechState: String(part?.speech_state || 'pending'),
    sourceCommittedText,
    sourcePreviewText,
    sourceText: String(part?.source_text || visibleText(sourceCommittedText, sourcePreviewText)),
    targetCommittedText,
    targetPreviewText,
    targetText: String(part?.target_text || visibleText(targetCommittedText, targetPreviewText)),
    lowQualityReference: Boolean(part?.low_quality_reference),
  };
}

function joinPartText(parts, role) {
  return (parts || [])
    .map((part) => role === 'source' ? part.sourceText : part.targetText)
    .filter(Boolean)
    .join('\n\n');
}

function joinSpeakableTargetText(parts) {
  return (parts || [])
    .filter((part) => part.speechState !== 'spoken')
    .map((part) => part.targetText)
    .filter(Boolean)
    .join('\n\n');
}

function joinTranslatableSourcePreviewText(parts) {
  return (parts || [])
    .filter((part) => part.speechState !== 'spoken')
    .map((part) => part.sourcePreviewText)
    .filter(Boolean)
    .join('\n\n');
}

function mergeLanePayload(laneId, payload) {
  const lane = ensureLane(laneId);
  lane.sourceLanguage = normalizeLanguageName(payload.source_language || lane.sourceLanguage);
  lane.targetLanguage = normalizeLanguageName(payload.target_language || lane.targetLanguage);
}

function shouldApplyCurrentTurnMessage(msg) {
  const laneId = String(msg.lane_id || '').trim();
  if (laneId && laneId !== currentLaneId()) return false;
  const msgTurnId = String(msg.turn_id || '').trim();
  if (!msgTurnId) return true;
  return msgTurnId === state.currentTurn.turnId;
}

function ensureLane(laneId) {
  const safeLaneId = LANE_IDS.includes(laneId) ? laneId : currentLaneId();
  if (!state.lanes[safeLaneId]) {
    state.lanes[safeLaneId] = createLane(safeLaneId, state.sideALanguage, state.sideBLanguage);
  }
  return state.lanes[safeLaneId];
}

function currentLaneId() {
  return LANE_IDS.includes(state.currentTurn?.laneId) ? state.currentTurn.laneId : 'a_to_b';
}

function currentLane() {
  return ensureLane(currentLaneId());
}

function visibleText(committed, preview) {
  const left = String(committed || '').trim();
  const right = String(preview || '').trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

function previewSuffixText(committed, preview) {
  const left = String(committed || '');
  const right = String(preview || '').trim();
  if (!right) return '';
  return /\s$/.test(left) || !left ? right : ` ${right}`;
}

function normalizePreGain(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0.5, Math.min(3.0, numeric)) : 1;
}

function normalizeLevel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

function normalizeLanguageName(value) {
  const fallback = languages[0]?.name || 'English';
  const text = String(value || '').trim();
  return languages.some((item) => item.name === text) ? text : fallback;
}

function flagForLanguage(name) {
  const match = languages.find((item) => item.name === name);
  return match?.flag || LANGUAGE_FLAGS[match?.asr] || '';
}

function setupAutoFollow(el) {
  if (!el) return;
  enableAutoFollow(el);
  updateClipTop(el);
  el.addEventListener('scroll', () => {
    el.dataset.autofollow = isNearBottom(el) ? 'on' : 'off';
    updateClipTop(el);
  });
}

function updateClipTop(el) {
  el.dataset.clipTop = el.scrollTop > 0 ? 'on' : 'off';
}

function enableTranscriptAutoFollow() {
  enableAutoFollow(els.sourceText);
  enableAutoFollow(els.targetText);
}

function enableAutoFollow(el) {
  if (el) el.dataset.autofollow = 'on';
}

function pinToBottomIfFollowing(el) {
  if (!el || el.dataset.autofollow === 'off') return;
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    if (el.dataset.autofollow !== 'off') el.scrollTop = el.scrollHeight;
  });
}

function isNearBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
}

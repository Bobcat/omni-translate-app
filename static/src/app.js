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
    voice_presets: {},
    use_input_audio_reference: false,
    reference_max_duration_s: 8,
  },
};
const DEFAULT_TTS_OPTIONS = {
  backends: [
    { value: 'kokoro', label: 'Kokoro' },
    { value: 'voxcpm2', label: 'VoxCPM2' },
  ],
  kokoro_voices: {},
  voxcpm2_voice_presets: [
    { value: 'configured', label: 'Default', prompt: '' },
  ],
  voxcpm2_reference_prompt: 'Match the speaking pace, rhythm, and articulation of the reference audio.',
};
const VOXCPM2_EXTRA_INFO_OPTIONS = [
  { value: 'none', label: 'Nothing extra' },
  { value: 'description', label: 'Voice description' },
  { value: 'sample', label: 'Speech sample' },
  { value: 'both', label: 'Description + speech sample' },
];
const VOXCPM2_SAMPLE_SOURCE_OPTIONS = [
  { value: 'last_speech', label: 'Last speech fragment' },
  { value: 'own_wav', label: 'Own WAV (later)', disabled: true },
];
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
  sessionStatusPill: document.querySelector('#sessionStatusPill'),
  turnModeButton: document.querySelector('#turnModeButton'),
  conversationModeButton: document.querySelector('#conversationModeButton'),
  setupStartPanel: document.querySelector('#setupStartPanel'),
  startButton: document.querySelector('#startButton'),
  turnHeaderActions: document.querySelector('#turnHeaderActions'),
  micToggleButton: document.querySelector('#micToggleButton'),
  pcExportButton: document.querySelector('#pcExportButton'),
  finishButton: document.querySelector('#finishButton'),
  miniStatus: document.querySelector('#miniStatus'),
  sourceLanguageSelect: document.querySelector('#sourceLanguageSelect'),
  targetLanguageSelect: document.querySelector('#targetLanguageSelect'),
  setupSwapButton: document.querySelector('#setupSwapButton'),
  setupSourceLanguage: document.querySelector('#setupSourceLanguage'),
  setupTargetLanguage: document.querySelector('#setupTargetLanguage'),
  turnSourceLanguage: document.querySelector('#turnSourceLanguage'),
  turnTargetLanguage: document.querySelector('#turnTargetLanguage'),
  vadBadge: document.querySelector('#vadBadge'),
  settingsButton: document.querySelector('#settingsButton'),
  sourceText: document.querySelector('#sourceText'),
  targetText: document.querySelector('#targetText'),
  translateNowButton: document.querySelector('#translateNowButton'),
  speakNowButton: document.querySelector('#speakNowButton'),
  clearTurnButton: document.querySelector('#clearTurnButton'),
  swapButton: document.querySelector('#swapButton'),
  audioResumeButton: document.querySelector('#audioResumeButton'),
  ttsAudio: document.querySelector('#ttsAudio'),
  settingsSheet: document.querySelector('#settingsSheet'),
  settingsSheetTitle: document.querySelector('#settingsSheetTitle'),
  settingsSheetScrim: document.querySelector('#settingsSheetScrim'),
  settingsBackButton: document.querySelector('#settingsBackButton'),
  settingsHomePage: document.querySelector('#settingsHomePage'),
  settingsMicrophoneNav: document.querySelector('#settingsMicrophoneNav'),
  settingsTuningNav: document.querySelector('#settingsTuningNav'),
  settingsAudioNav: document.querySelector('#settingsAudioNav'),
  settingsHistoryNav: document.querySelector('#settingsHistoryNav'),
  settingsDebugNav: document.querySelector('#settingsDebugNav'),
  settingsMicrophonePage: document.querySelector('#settingsMicrophonePage'),
  settingsTuningPage: document.querySelector('#settingsTuningPage'),
  settingsAudioPage: document.querySelector('#settingsAudioPage'),
  settingsHistoryPage: document.querySelector('#settingsHistoryPage'),
  settingsDebugPage: document.querySelector('#settingsDebugPage'),
  tuningSettingsSummary: document.querySelector('#tuningSettingsSummary'),
  tuningSettingsGroups: document.querySelector('#tuningSettingsGroups'),
  historySettingsSummary: document.querySelector('#historySettingsSummary'),
  historySaveSessions: document.querySelector('#historySaveSessions'),
  historyRetentionDays: document.querySelector('#historyRetentionDays'),
  debugSettingsSummary: document.querySelector('#debugSettingsSummary'),
  showStatusLine: document.querySelector('#showStatusLine'),
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
  ttsOptions: cloneSettings(DEFAULT_TTS_OPTIONS),
  ttsExpandedGroups: new Set(),
  ttsVoxcpm2ExtraInfoMode: null,
  ttsPromptInspectOpen: false,
  ttsUpdateBusy: false,
  debugSettings: {
    showStatusLine: false,
  },
};

let audioQueue;
let languageSelectMeasureCanvas = null;

audioQueue = new AudioQueue({
  audio: els.ttsAudio,
  resumeButton: els.audioResumeButton,
  onStatus: (text) => {
    state.audioStatus = text;
    if (text) {
      els.miniStatus.textContent = text;
      if (text.startsWith('Playing')) renderStatus('speaking');
    } else if (state.sessionState === SESSION_STATES.RUNNING) {
      renderStatus('listening');
    }
    updateActionButtons();
  },
  onPlaybackStart: () => {
    state.captureMutedForPlayback = true;
    renderStatus('speaking');
  },
  onPlaybackIdle: () => {
    state.captureMutedForPlayback = false;
    renderStatus(state.sessionState === SESSION_STATES.RUNNING ? 'listening' : state.status);
  },
  onPlaybackComplete: () => {
    if (state.sessionState !== SESSION_STATES.RUNNING || state.micState !== MIC_STATES.LISTENING) return;
    stopMicrophoneCapture({ statusText: 'Mic off' });
  },
  onItemEnded: (item) => {
    state.socket?.ttsPlaybackComplete({
      laneId: item.laneId,
      turnId: item.turnId,
      artifactId: item.artifactId,
    });
  },
});

init().catch((error) => {
  setStatus('error', error.message || String(error));
});

async function init() {
  const config = await api.getConfig();
  state.sideALanguage = normalizeLanguageName(config.conversation?.side_a_language || 'Dutch');
  state.sideBLanguage = normalizeLanguageName(config.conversation?.side_b_language || 'English');
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  state.audioInputSampleRate = config.audio_input?.sample_rate_hz || 16000;
  state.tuningSettings = mergeSettings(DEFAULT_TUNING_SETTINGS, config.live_settings || {});
  applyTtsConfig(config.tts || {});

  els.startButton.addEventListener('click', handleStartButton);
  els.micToggleButton.addEventListener('click', handleMicToggle);
  els.pcExportButton.addEventListener('click', exportPcTranscript);
  els.finishButton.addEventListener('click', handleSessionRightAction);
  els.turnModeButton.addEventListener('click', () => setViewMode('turn'));
  els.sourceLanguageSelect.addEventListener('change', () => setVisibleLanguage('source', els.sourceLanguageSelect.value));
  els.targetLanguageSelect.addEventListener('change', () => setVisibleLanguage('target', els.targetLanguageSelect.value));
  els.setupSwapButton.addEventListener('click', swapSetupLanguages);
  els.swapButton.addEventListener('click', swapDirection);
  els.translateNowButton.addEventListener('click', translateNow);
  els.speakNowButton.addEventListener('click', speakNow);
  els.clearTurnButton.addEventListener('click', clearTurn);
  els.settingsButton.addEventListener('click', openSettingsSheet);
  els.settingsBackButton.addEventListener('click', handleSettingsBack);
  els.settingsMicrophoneNav.addEventListener('click', () => setSettingsPage('microphone'));
  els.settingsTuningNav.addEventListener('click', () => setSettingsPage('tuning'));
  els.settingsAudioNav.addEventListener('click', () => setSettingsPage('audio'));
  els.settingsHistoryNav.addEventListener('click', () => setSettingsPage('history'));
  els.settingsDebugNav.addEventListener('click', () => setSettingsPage('debug'));
  els.settingsStartButton.addEventListener('click', startFromSettings);
  els.micPreGain.addEventListener('input', handlePreGainInput);
  els.micAutoGainControl.addEventListener('change', handleAutoGainControlChange);
  els.audioSettingsReset.addEventListener('click', resetAudioSettings);
  els.showStatusLine.addEventListener('change', handleShowStatusLineChange);
  els.tuningSettingsGroups.addEventListener('change', handleTuningSettingChange);
  els.ttsEnabled.addEventListener('change', handleTtsEnabledChange);
  els.ttsBackendSelect.addEventListener('change', handleTtsBackendChange);
  els.ttsSettingsGroups.addEventListener('change', handleTtsSettingChange);
  els.ttsSettingsGroups.addEventListener('click', handleTtsSettingsClick);
  els.settingsSheetScrim.addEventListener('click', closeSettingsSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeSettingsSheet();
  });

  renderLanguageSelectOptions();
  renderLanguageControls();
  setupAutoFollow(els.sourceText);
  setupAutoFollow(els.targetText);
  renderTranscript();
  renderAudioSettings();
  renderTuningSettings();
  renderTtsSettings();
  renderHistorySettings();
  renderDebugSettings();
  updateActionButtons();
  renderLifecycle();
  setStatus('idle', '');
}

async function startListening({ statusDetail = 'Opening connection' } = {}) {
  const startLaneId = currentLaneId();
  clearAllLanes({ laneId: startLaneId });
  state.requestedStartLaneId = startLaneId;
  state.micState = MIC_STATES.OFF;
  state.pcExportBusy = false;
  setListenBusy(true);
  setStatus('connecting', statusDetail);
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
        state.captureMutedForPlayback = false;
        state.sessionId = null;
        renderAudioSettings();
        setSessionState(SESSION_STATES.SETUP);
        setStatus('idle', '');
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
    setStatus('listening', '');
  } catch (error) {
    state.captureMutedForPlayback = false;
    capture?.stop();
    socket?.close();
    cleanupClientSession();
    state.sessionId = null;
    setSessionState(SESSION_STATES.SETUP);
    setStatus('error', error.message || String(error));
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
    stopMicrophoneCapture({ statusText: 'Mic off' });
    return;
  }
  if (state.micState === MIC_STATES.OFF) {
    startMicrophoneCapture();
  }
}

function handleSessionRightAction() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  finishSession();
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
    setStatus('listening', '');
  } catch (error) {
    state.capture?.stop();
    state.capture = null;
    state.micState = MIC_STATES.OFF;
    renderMicLevel(0);
    renderAudioSettings();
    setStatus('error', error.message || 'Microphone unavailable');
  } finally {
    setListenBusy(false);
    renderLifecycle();
  }
}

function stopMicrophoneCapture({ statusText = 'Mic off' } = {}) {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  state.captureMutedForPlayback = false;
  state.capture?.stop();
  state.capture = null;
  state.micState = MIC_STATES.OFF;
  hideVadHint();
  renderMicLevel(0);
  renderAudioSettings();
  renderTranscript();
  setStatus('listening', statusText);
}

function speakNow() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (audioQueue.hasAudio()) {
    audioQueue.playOrResume();
    return;
  }
  if (state.currentTurn.speakableTargetText && state.currentTurn.state !== TURN_STATES.OPEN_SPEAKING && state.socket?.speakNow()) {
    els.miniStatus.textContent = 'Creating audio';
  }
}

function translateNow() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (!state.currentTurn.canTranslateNow) return;
  if (state.socket?.translateNow()) {
    els.miniStatus.textContent = 'Translating';
  }
}

async function exportPcTranscript() {
  if (state.sessionState !== SESSION_STATES.RUNNING || state.micState !== MIC_STATES.OFF || !state.sessionId) return;
  state.pcExportBusy = true;
  els.miniStatus.textContent = 'Exporting PC';
  updateActionButtons();
  try {
    const { blob, filename } = await api.getSessionPcExport(state.sessionId);
    downloadBlob(blob, filename);
    els.miniStatus.textContent = 'PC exported';
  } catch (error) {
    setStatus('error', error.message || 'PC export failed');
  } finally {
    state.pcExportBusy = false;
    updateActionButtons();
  }
}

function clearTurn() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (state.socket?.clearTurn()) {
    audioQueue.clear();
    els.miniStatus.textContent = 'Clearing turn';
  }
}

function resetSessionToSetup() {
  clearAllLanes({ laneId: 'a_to_b' });
  state.requestedStartLaneId = 'a_to_b';
  state.captureMutedForPlayback = false;
  setSessionState(SESSION_STATES.SETUP);
  setStatus('idle', '');
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

function swapDirection() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  const nextLaneId = currentLaneId() === 'a_to_b' ? 'b_to_a' : 'a_to_b';
  if (!state.socket?.isOpen()) return;
  audioQueue.clear();
  state.socket.nextTurn(nextLaneId);
  els.miniStatus.textContent = 'Switching direction';
}

function handleMessage(msg) {
  const msgSessionId = String(msg?.session_id || '').trim();
  if (!state.sessionId || msgSessionId !== state.sessionId) return;
  if (msg.type === 'ready') {
    applyReady(msg);
    return;
  }
  if (msg.type === 'state') {
    setStatus(msg.state || 'idle', '');
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
      els.miniStatus.textContent = 'Audio ready';
    }
    updateActionButtons();
    return;
  }
  if (msg.type === 'tts_status') {
    els.miniStatus.textContent = msg.message || msg.reason || '';
    updateActionButtons();
    return;
  }
  if (msg.type === 'translation_status') {
    els.miniStatus.textContent = msg.message || msg.reason || '';
    updateActionButtons();
    return;
  }
  if (msg.type === 'asr_status') {
    if (!els.miniStatus.textContent) {
      els.miniStatus.textContent = 'Processing speech';
    }
    return;
  }
  if (msg.type === 'live_settings') {
    state.tuningSettings = mergeSettings(DEFAULT_TUNING_SETTINGS, msg.live_settings || {});
    renderTuningSettings({ preserveScroll: true });
    return;
  }
  if (msg.type === 'error') {
    setStatus('error', msg.message || msg.code || 'Error');
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
  els.miniStatus.textContent = directionLabel();
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
  const laneChanged = previousLaneId !== currentLaneId();
  if (laneChanged || msg.reason === 'clear_turn' || msg.reason === 'next_turn') {
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
    els.miniStatus.textContent = 'Translating';
  } else if (reason === 'translate_now') {
    els.miniStatus.textContent = 'Translating';
  } else if (reason === 'translation_update') {
    els.miniStatus.textContent = 'Translation ready';
  } else if (reason === 'speak_now') {
    els.miniStatus.textContent = 'Creating audio';
  } else if (reason === 'clear_turn') {
    els.miniStatus.textContent = 'Turn cleared';
  } else if (reason === 'next_turn' || reason === 'tts_playback_complete') {
    els.miniStatus.textContent = directionLabel();
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
  els.miniStatus.textContent = '';
  audioQueue.clear();
  hideVadHint();
  enableTranscriptAutoFollow();
  renderTranscript();
  updateActionButtons();
}

function setSessionState(sessionState) {
  state.sessionState = Object.values(SESSION_STATES).includes(sessionState) ? sessionState : SESSION_STATES.SETUP;
  if (state.sessionState !== SESSION_STATES.RUNNING) {
    state.micState = MIC_STATES.OFF;
  }
  renderLifecycle();
  renderTuningSettings({ preserveScroll: true });
  updateActionButtons();
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
  els.turnHeaderActions.hidden = !running;
  els.setupSwapButton.hidden = !setup;
  els.translateNowButton.hidden = !running;
  els.speakNowButton.hidden = !running;
  els.micToggleButton.hidden = !running;
  els.pcExportButton.hidden = !(running && micOff);
  els.finishButton.hidden = !running;
  els.miniStatus.hidden = !state.debugSettings.showStatusLine;
  els.startButton.disabled = state.status === 'connecting';
  els.settingsStartButton.disabled = !(setup || micOff) || state.status === 'connecting';
  els.setupSwapButton.disabled = !setup || state.status === 'connecting';
  els.turnModeButton.classList.toggle('is-active', state.viewMode === 'turn');
  els.turnModeButton.setAttribute('aria-pressed', state.viewMode === 'turn' ? 'true' : 'false');
  els.conversationModeButton.classList.toggle('is-active', state.viewMode === 'conversation');
  els.conversationModeButton.setAttribute('aria-pressed', state.viewMode === 'conversation' ? 'true' : 'false');
  renderLanguageControls();
  renderStatus(state.status);
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
  updateClearTurnButton();
  updateSessionRightAction();
  renderLanguageControls();
}

function updateTranslateNowButton() {
  const turnIsSpeaking = state.currentTurn.state === TURN_STATES.OPEN_SPEAKING;
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  els.translateNowButton.disabled = !(live && state.currentTurn.canTranslateNow && !turnIsSpeaking);
}

function updateSpeakNowButton() {
  const turnIsSpeaking = state.currentTurn.state === TURN_STATES.OPEN_SPEAKING;
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  const canSpeakTarget = Boolean(live && state.currentTurn.speakableTargetText && !turnIsSpeaking);
  const canPlayAudio = Boolean(live && audioQueue?.hasAudio());
  els.speakNowButton.disabled = !(canSpeakTarget || canPlayAudio);
  els.speakNowButton.classList.toggle('is-busy', turnIsSpeaking);
  let label = 'Speak now';
  if (state.audioStatus.startsWith('Playing')) {
    label = 'Playing';
  } else if (canPlayAudio) {
    label = 'Play audio';
  }
  els.speakNowButton.setAttribute('aria-label', label);
  els.speakNowButton.title = label;
}

function updateClearTurnButton() {
  const hasText = Boolean(state.currentTurn.sourceText || state.currentTurn.targetText || state.currentTurn.parts.length);
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  els.clearTurnButton.disabled = !hasText || !live;
  els.swapButton.disabled = !live;
}

function updateSessionRightAction() {
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  els.finishButton.disabled = !live;
  els.finishButton.setAttribute('aria-label', 'Finish session');
  els.finishButton.title = 'Finish';
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

function setStatus(status, detail) {
  state.status = String(status || 'idle').toLowerCase();
  els.miniStatus.textContent = detail || '';
  renderLifecycle();
  updateActionButtons();
}

function renderStatus(status) {
  const normalized = String(status || 'idle').toLowerCase();
  const micOff = state.sessionState === SESSION_STATES.RUNNING
    && state.micState === MIC_STATES.OFF
    && normalized !== 'speaking'
    && normalized !== 'error';
  const visible = state.sessionState !== SESSION_STATES.SETUP
    || normalized === 'connecting'
    || normalized === 'error';
  els.sessionStatusPill.hidden = !visible;
  els.sessionStatusPill.className = 'session-status-pill';
  if (normalized === 'connecting') els.sessionStatusPill.classList.add('is-connecting');
  if (normalized === 'listening' && !micOff) els.sessionStatusPill.classList.add('is-listening');
  if (micOff) els.sessionStatusPill.classList.add('is-mic-off');
  if (normalized === 'speaking') els.sessionStatusPill.classList.add('is-speaking');
  if (normalized === 'error') els.sessionStatusPill.classList.add('is-error');
  els.sessionStatusPill.textContent = statusLabel(normalized);
}

function statusLabel(status) {
  const normalized = String(status || 'idle').toLowerCase();
  if (state.sessionState === SESSION_STATES.RUNNING && state.micState === MIC_STATES.OFF && normalized !== 'speaking' && normalized !== 'error') return 'Mic off';
  if (normalized === 'listening') return 'Listening...';
  if (normalized === 'connecting') return 'Connecting...';
  if (normalized === 'speaking') return 'Playing...';
  if (normalized === 'error') return 'Error';
  return 'Ready';
}

function openSettingsSheet() {
  els.settingsSheet.hidden = false;
  setSettingsPage('home');
  renderAudioSettings();
  renderTuningSettings();
  renderTtsSettings();
  renderHistorySettings();
  renderDebugSettings();
}

function closeSettingsSheet() {
  els.settingsSheet.hidden = true;
}

function handleSettingsBack() {
  if (state.settingsPage === 'home') {
    closeSettingsSheet();
    return;
  }
  setSettingsPage('home');
}

function setSettingsPage(page) {
  state.settingsPage = ['microphone', 'tuning', 'audio', 'history', 'debug'].includes(page) ? page : 'home';
  renderSettingsPage();
  if (state.settingsPage === 'tuning') renderTuningSettings();
  if (state.settingsPage === 'audio') renderTtsSettings();
}

function renderSettingsPage() {
  const page = state.settingsPage;
  const home = page === 'home';
  els.settingsHomePage.hidden = page !== 'home';
  els.settingsMicrophonePage.hidden = page !== 'microphone';
  els.settingsTuningPage.hidden = page !== 'tuning';
  els.settingsAudioPage.hidden = page !== 'audio';
  els.settingsHistoryPage.hidden = page !== 'history';
  els.settingsDebugPage.hidden = page !== 'debug';
  els.settingsBackButton.classList.toggle('is-sheet-close', home);
  els.settingsBackButton.classList.toggle('is-subpage-back', !home);
  els.settingsBackButton.setAttribute('aria-label', home ? 'Close settings' : 'Back');
  els.settingsBackButton.title = home ? 'Close settings' : 'Back';
  if (page === 'microphone') {
    els.settingsSheetTitle.textContent = 'Microphone';
  } else if (page === 'tuning') {
    els.settingsSheetTitle.textContent = 'ASR tuning';
  } else if (page === 'audio') {
    els.settingsSheetTitle.textContent = 'TTS options';
  } else if (page === 'history') {
    els.settingsSheetTitle.textContent = 'History';
  } else if (page === 'debug') {
    els.settingsSheetTitle.textContent = 'Debug';
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
  els.miniStatus.textContent = directionLabel();
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
  els.miniStatus.textContent = directionLabel();
}

function handlePreGainInput() {
  state.audioSettings.preGain = normalizePreGain(els.micPreGain.value);
  state.capture?.setPreGain(state.audioSettings.preGain);
  renderAudioSettings();
}

function startFromSettings() {
  if (state.status === 'connecting') return;
  if (state.sessionState === SESSION_STATES.SETUP) {
    startListening({ statusDetail: 'Opening microphone' });
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
  await restartMicrophoneCapture({ statusText: requested ? 'Auto gain on' : 'Auto gain off' });
}

async function resetAudioSettings() {
  state.audioSettings.preGain = DEFAULT_AUDIO_SETTINGS.preGain;
  state.capture?.setPreGain(state.audioSettings.preGain);
  if (state.sessionState === SESSION_STATES.RUNNING && state.capture) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
    await restartMicrophoneCapture({ statusText: 'Audio reset' });
    return;
  }
  if (state.sessionState !== SESSION_STATES.RUNNING) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
  } else if (state.micState === MIC_STATES.OFF) {
    state.audioSettings.autoGainControl = DEFAULT_AUDIO_SETTINGS.autoGainControl;
  }
  renderAudioSettings();
}

async function restartMicrophoneCapture({ statusText = '' } = {}) {
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
    els.miniStatus.textContent = statusText;
  } catch (error) {
    state.audioSettings.preGain = previousSettings.preGain;
    state.audioSettings.autoGainControl = previousSettings.autoGainControl;
    try {
      const restoredCapture = createAudioCapture({ targetSampleRate });
      await restoredCapture.start();
      state.capture = restoredCapture;
      state.micState = MIC_STATES.LISTENING;
      state.audioSettings.autoGainControl = restoredCapture.autoGainControl;
      els.miniStatus.textContent = 'Auto gain unavailable';
    } catch {
      state.micState = MIC_STATES.OFF;
      setStatus('error', error.message || 'Microphone unavailable');
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
  els.tuningSettingsSummary.textContent = tuningSummary();
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

function tuningSummary() {
  const direct = getTuningValue('asr.backend') === 'faster_whisper_direct';
  const backend = direct ? 'Faster Whisper' : 'WhisperX';
  const chunkKey = direct ? 'asr.chunk_length' : 'asr.chunk_size';
  const chunk = getTuningValue(chunkKey);
  return chunk ? `${backend}, ${chunk}s` : backend;
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

function handleShowStatusLineChange() {
  state.debugSettings.showStatusLine = Boolean(els.showStatusLine.checked);
  renderDebugSettings();
  renderLifecycle();
}

function renderDebugSettings() {
  els.showStatusLine.checked = state.debugSettings.showStatusLine;
  els.debugSettingsSummary.textContent = state.debugSettings.showStatusLine ? 'on' : 'off';
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

function handleTtsEnabledChange() {
  const previous = cloneSettings(state.ttsSettings);
  const enabled = Boolean(els.ttsEnabled.checked);
  state.ttsSettings.enabled = enabled;
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings({ enabled }, previous);
}

function handleTtsBackendChange() {
  const previous = cloneSettings(state.ttsSettings);
  const backend = String(els.ttsBackendSelect.value || 'kokoro');
  state.ttsSettings.backend = backend;
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings({ backend }, previous);
}

function handleTtsSettingChange(event) {
  const input = event.target;
  if (!input || input.disabled) return;
  const previous = cloneSettings(state.ttsSettings);
  const kind = input.dataset.ttsKind || '';
  const language = input.dataset.ttsLanguage || '';
  if (kind === 'voxcpm2-extra-info') {
    const previousMode = state.ttsVoxcpm2ExtraInfoMode;
    const mode = String(input.value || 'none');
    const next = ttsSettingsForVoxcpm2Mode(mode);
    state.ttsVoxcpm2ExtraInfoMode = mode;
    state.ttsSettings.voxcpm2.voice_presets = next.voicePresets;
    state.ttsSettings.voxcpm2.use_input_audio_reference = next.useReference;
    renderTtsSettings({ preserveScroll: true });
    submitTtsSettings({
      voxcpm2: {
        voice_presets: next.voicePresets,
        use_input_audio_reference: next.useReference,
      },
    }, previous, previousMode);
    return;
  }
  if (kind === 'voxcpm2-sample-source') {
    input.value = 'last_speech';
    return;
  }
  if (kind === 'kokoro-voice' && language) {
    const value = String(input.value || '');
    state.ttsSettings.kokoro.voices[language] = value;
    renderTtsSettings({ preserveScroll: true });
    submitTtsSettings({ kokoro: { voices: { [language]: value } } }, previous);
    return;
  }
  if (kind === 'voxcpm2-preset' && language) {
    const value = String(input.value || 'configured');
    state.ttsSettings.voxcpm2.voice_presets[language] = value;
    renderTtsSettings({ preserveScroll: true });
    submitTtsSettings({ voxcpm2: { voice_presets: { [language]: value } } }, previous);
    return;
  }
  if (kind === 'voxcpm2-reference-max-duration') {
    const value = normalizeTtsNumber(input.value, state.ttsSettings.voxcpm2.reference_max_duration_s || 8, 1, 60);
    state.ttsSettings.voxcpm2.reference_max_duration_s = value;
    renderTtsSettings({ preserveScroll: true });
    submitTtsSettings({ voxcpm2: { reference_max_duration_s: value } }, previous);
    return;
  }
}

function handleTtsSettingsClick(event) {
  const button = event.target?.closest?.('[data-tts-action]');
  if (!button) return;
  if (button.dataset.ttsAction === 'toggle-prompt-preview') {
    state.ttsPromptInspectOpen = !state.ttsPromptInspectOpen;
    renderTtsSettings({ preserveScroll: true });
  }
}

async function submitTtsSettings(delta, previousSettings, previousVoxcpm2Mode = state.ttsVoxcpm2ExtraInfoMode) {
  state.ttsUpdateBusy = true;
  renderTtsSettings({ preserveScroll: true });
  try {
    const payload = await api.updateTtsSettings(delta);
    applyTtsConfig(payload.tts || {});
    els.miniStatus.textContent = 'Voice settings updated';
  } catch (error) {
    state.ttsSettings = previousSettings;
    state.ttsVoxcpm2ExtraInfoMode = previousVoxcpm2Mode;
    setStatus('error', error.message || 'Voice settings failed');
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
  const groups = [
    { name: 'Kokoro', backend: 'kokoro', rows: kokoroTtsRows() },
    { name: 'VoxCPM2', backend: 'voxcpm2', rows: voxcpm2TtsRows() },
  ];
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
  const options = state.ttsOptions.backends?.length ? state.ttsOptions.backends : DEFAULT_TTS_OPTIONS.backends;
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
  els.ttsBackendSelect.disabled = state.ttsUpdateBusy;
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
      meta: ttsRowMeta({ active, available: options.length > 0 }),
      kind: 'kokoro-voice',
      language,
      emptyLabel: 'Unsupported',
    });
  });
}

function voxcpm2TtsRows() {
  const active = state.ttsSettings.backend === 'voxcpm2';
  const disabled = state.ttsUpdateBusy || !active;
  const mode = voxcpm2ExtraInfoMode();
  const rows = [createTtsSelectRow({
    label: 'Voice instructions',
    value: mode,
    options: VOXCPM2_EXTRA_INFO_OPTIONS,
    disabled,
    meta: ttsRowMeta({ active, available: true }),
    kind: 'voxcpm2-extra-info',
    emptyLabel: 'Nothing extra',
  })];
  if (mode === 'description' || mode === 'both') {
    for (const language of ttsPresetLanguages()) {
      const value = state.ttsSettings.voxcpm2.voice_presets?.[language] || defaultVoxcpm2DescriptionPreset();
      rows.push(createTtsSelectRow({
        label: `${language} description`,
        value,
        options: voxcpm2DescriptionOptions(),
        disabled,
        meta: ttsRowMeta({ active, available: true }),
        kind: 'voxcpm2-preset',
        language,
        emptyLabel: 'Neutral clear',
      }));
    }
  }
  if (mode === 'sample' || mode === 'both') {
    rows.push(createTtsSelectRow({
      label: 'Speech sample',
      value: 'last_speech',
      options: VOXCPM2_SAMPLE_SOURCE_OPTIONS,
      disabled,
      meta: ttsRowMeta({ active, available: true }),
      kind: 'voxcpm2-sample-source',
      emptyLabel: 'Last speech fragment',
    }));
    rows.push(createTtsNumberRow({
      label: 'Max duration',
      value: state.ttsSettings.voxcpm2.reference_max_duration_s || 8,
      min: 1,
      max: 60,
      step: 1,
      unit: 's',
      disabled,
      meta: ttsRowMeta({ active, available: true }),
      kind: 'voxcpm2-reference-max-duration',
    }));
    rows.push(createTtsStaticRow({
      label: 'Own WAV',
      value: 'Not selectable yet',
      meta: 'later',
    }));
  }
  rows.push(createTtsPromptInspectRows(active));
  return rows;
}

function createTtsPromptInspectRows(active) {
  const fragment = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'tuning-row tts-action-row';
  const label = document.createElement('span');
  label.className = 'tuning-label';
  label.textContent = 'Prompt';
  const meta = document.createElement('span');
  meta.className = 'tuning-meta';
  meta.textContent = active ? 'inspect' : 'inactive';
  const button = document.createElement('button');
  button.className = 'tts-inspect-button';
  button.type = 'button';
  button.dataset.ttsAction = 'toggle-prompt-preview';
  button.disabled = !active;
  button.textContent = state.ttsPromptInspectOpen ? 'Hide prompt' : 'Inspect prompt';
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(button);
  row.append(label, meta, valueWrap);
  fragment.append(row);
  if (state.ttsPromptInspectOpen && active) {
    fragment.append(createVoxcpm2PromptPreview());
  }
  return fragment;
}

function createVoxcpm2PromptPreview() {
  const targetLanguage = currentTtsTargetLanguage();
  const preview = document.createElement('div');
  preview.className = 'tts-prompt-preview';
  const textLabel = document.createElement('span');
  textLabel.className = 'tts-prompt-preview-label';
  textLabel.textContent = `Text instruction for ${targetLanguage}`;
  const textValue = document.createElement('code');
  textValue.textContent = voxcpm2TextPromptPreview() || 'None';
  const sampleLabel = document.createElement('span');
  sampleLabel.className = 'tts-prompt-preview-label';
  sampleLabel.textContent = 'Speech sample';
  const sampleValue = document.createElement('code');
  sampleValue.textContent = state.ttsSettings.voxcpm2.use_input_audio_reference
    ? `Last speech fragment from this session, max ${state.ttsSettings.voxcpm2.reference_max_duration_s || 8}s`
    : 'None';
  preview.append(textLabel, textValue, sampleLabel, sampleValue);
  return preview;
}

function createTtsSelectRow({ label, value, options, disabled, meta, kind, language, emptyLabel }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const metaEl = document.createElement('span');
  metaEl.className = 'tuning-meta';
  metaEl.textContent = meta;
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
  row.append(labelEl, metaEl, valueWrap);
  return row;
}

function createTtsNumberRow({ label, value, min, max, step, unit, disabled, meta, kind }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const metaEl = document.createElement('span');
  metaEl.className = 'tuning-meta';
  metaEl.textContent = meta;
  const input = document.createElement('input');
  input.type = 'number';
  input.dataset.ttsKind = kind;
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
  row.append(labelEl, metaEl, valueWrap);
  return row;
}

function createTtsStaticRow({ label, value, meta }) {
  const row = document.createElement('div');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const metaEl = document.createElement('span');
  metaEl.className = 'tuning-meta';
  metaEl.textContent = meta;
  const valueEl = document.createElement('span');
  valueEl.className = 'tts-static-value';
  valueEl.textContent = value;
  row.append(labelEl, metaEl, valueEl);
  return row;
}

function voxcpm2ExtraInfoMode() {
  if (VOXCPM2_EXTRA_INFO_OPTIONS.some((option) => option.value === state.ttsVoxcpm2ExtraInfoMode)) {
    return state.ttsVoxcpm2ExtraInfoMode;
  }
  const hasDescription = ttsPresetLanguages().some((language) => {
    const preset = state.ttsSettings.voxcpm2.voice_presets?.[language] || 'configured';
    return preset !== 'configured';
  });
  const hasSample = Boolean(state.ttsSettings.voxcpm2.use_input_audio_reference);
  if (hasDescription && hasSample) return 'both';
  if (hasDescription) return 'description';
  if (hasSample) return 'sample';
  return 'none';
}

function ttsSettingsForVoxcpm2Mode(mode) {
  const useDescription = mode === 'description' || mode === 'both';
  const useReference = mode === 'sample' || mode === 'both';
  const voicePresets = {};
  for (const language of ttsPresetLanguages()) {
    const current = state.ttsSettings.voxcpm2.voice_presets?.[language] || 'configured';
    if (!useDescription) {
      voicePresets[language] = 'configured';
    } else if (current !== 'configured') {
      voicePresets[language] = current;
    } else {
      voicePresets[language] = useReference ? 'configured' : defaultVoxcpm2DescriptionPreset();
    }
  }
  return { voicePresets, useReference };
}

function voxcpm2DescriptionOptions() {
  const options = state.ttsOptions.voxcpm2_voice_presets || DEFAULT_TTS_OPTIONS.voxcpm2_voice_presets;
  if (voxcpm2ExtraInfoMode() !== 'both') {
    return options.filter((option) => option.value !== 'configured');
  }
  return options.map((option) => {
    if (option.value !== 'configured') return option;
    return { ...option, label: 'From speech sample' };
  });
}

function defaultVoxcpm2DescriptionPreset() {
  return voxcpm2DescriptionOptions()[0]?.value || 'neutral_clear';
}

function voxcpm2TextPromptPreview() {
  const parts = [];
  const language = currentTtsTargetLanguage();
  const presetKey = state.ttsSettings.voxcpm2.voice_presets?.[language] || 'configured';
  const option = voxcpm2PresetOption(presetKey);
  const descriptionPrompt = String(option?.prompt || '').trim();
  if (descriptionPrompt) parts.push(descriptionPrompt);
  if (state.ttsSettings.voxcpm2.use_input_audio_reference) {
    const prompt = String(state.ttsOptions.voxcpm2_reference_prompt || DEFAULT_TTS_OPTIONS.voxcpm2_reference_prompt || '').trim();
    if (prompt && !parts.includes(prompt)) parts.push(prompt);
  }
  return parts.join(' ');
}

function voxcpm2PresetOption(value) {
  const options = state.ttsOptions.voxcpm2_voice_presets || DEFAULT_TTS_OPTIONS.voxcpm2_voice_presets;
  return options.find((option) => option.value === value);
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

function ttsRowMeta({ active, available }) {
  if (!available) return 'unavailable';
  if (!active) return 'inactive';
  return 'live';
}

function ttsSummary() {
  if (!state.ttsSettings.enabled) return 'off';
  return ttsBackendLabel(state.ttsSettings.backend);
}

function ttsBackendLabel(backend) {
  const options = state.ttsOptions.backends?.length ? state.ttsOptions.backends : DEFAULT_TTS_OPTIONS.backends;
  const match = options.find((option) => option.value === backend);
  return match?.label || String(backend || '');
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

function renderMicLevel(value) {
  const level = normalizeLevel(value);
  state.audioSettings.inputLevel = level;
  const percent = Math.round(level * 100);
  els.micLevelFill.style.transform = `scaleX(${level.toFixed(3)})`;
  els.micLevel.setAttribute('aria-valuenow', String(percent));
  els.micLevel.classList.toggle('is-hot', level >= 0.9);
  const haloLevel = state.micState === MIC_STATES.LISTENING ? Math.sqrt(level) : 0;
  const clipRisk = state.micState === MIC_STATES.LISTENING && level >= 0.95;
  const hot = level >= 0.85;
  els.micToggleButton.classList.toggle('is-clip-risk', clipRisk);
  els.micToggleButton.style.setProperty('--mic-toggle-halo-color', clipRisk ? '185, 28, 28' : hot ? '245, 158, 11' : '59, 130, 246');
  els.micToggleButton.style.setProperty('--mic-toggle-halo-alpha', (haloLevel ? 0.08 + haloLevel * (clipRisk ? 0.42 : hot ? 0.36 : 0.3) : 0).toFixed(3));
  els.micToggleButton.style.setProperty('--mic-toggle-halo-size', `${Math.round(haloLevel * 14)}px`);
}

function renderLanguageSelectOptions() {
  const fragment = document.createDocumentFragment();
  for (const item of languages) {
    const option = document.createElement('option');
    option.value = item.name;
    option.textContent = `${flagForLanguage(item.name)} ${item.name}`;
    fragment.append(option);
  }
  els.sourceLanguageSelect.replaceChildren(fragment.cloneNode(true));
  els.targetLanguageSelect.replaceChildren(fragment);
}

function renderLanguageControls() {
  const lane = currentLane();
  const setup = state.sessionState === SESSION_STATES.SETUP;
  els.sourceLanguageSelect.value = lane.sourceLanguage;
  els.targetLanguageSelect.value = lane.targetLanguage;
  fitLanguageSelectToSelectedOption(els.sourceLanguageSelect);
  fitLanguageSelectToSelectedOption(els.targetLanguageSelect);
  els.sourceLanguageSelect.hidden = !setup;
  els.targetLanguageSelect.hidden = !setup;
  els.sourceLanguageSelect.disabled = state.status === 'connecting';
  els.targetLanguageSelect.disabled = state.status === 'connecting';
  els.sourceLanguageSelect.setAttribute('aria-label', `Source language: ${lane.sourceLanguage}`);
  els.targetLanguageSelect.setAttribute('aria-label', `Target language: ${lane.targetLanguage}`);
  renderDirectionLabels(lane);
}

function fitLanguageSelectToSelectedOption(select) {
  if (!select) return;
  const option = select.options?.[Math.max(0, select.selectedIndex)] || null;
  const text = String(option?.text || '').trim();
  if (!text || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;
  try {
    if (!languageSelectMeasureCanvas) {
      languageSelectMeasureCanvas = document.createElement('canvas');
    }
    const context = languageSelectMeasureCanvas.getContext('2d');
    if (!context) return;
    const computed = window.getComputedStyle(select);
    context.font = `${computed.fontStyle || 'normal'} ${computed.fontWeight || '400'} ${computed.fontSize || '14px'} ${computed.fontFamily || 'system-ui'}`;
    const textWidth = Math.ceil(context.measureText(text).width);
    select.style.width = `${Math.max(86, Math.min(220, textWidth + 40))}px`;
  } catch {
    // CSS fallback keeps the select usable when measurement is unavailable.
  }
}

function renderTranscript() {
  const lane = currentLane();
  renderTurnStream(els.sourceText, state.currentTurn.parts, 'source', state.currentTurn.sourceText);
  renderTurnStream(els.targetText, state.currentTurn.parts, 'target', state.currentTurn.targetText);
  renderDirectionLabels(lane);
  pinToBottomIfFollowing(els.sourceText);
  pinToBottomIfFollowing(els.targetText);
}

function renderDirectionLabels(lane) {
  const sourceCode = codeForLanguage(lane.sourceLanguage);
  const targetCode = codeForLanguage(lane.targetLanguage);
  els.turnSourceLanguage.textContent = sourceCode;
  els.turnTargetLanguage.textContent = targetCode;
  els.setupSourceLanguage.textContent = sourceCode;
  els.setupTargetLanguage.textContent = targetCode;
  els.turnSourceLanguage.title = lane.sourceLanguage;
  els.turnTargetLanguage.title = lane.targetLanguage;
  els.setupSourceLanguage.title = lane.sourceLanguage;
  els.setupTargetLanguage.title = lane.targetLanguage;
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
    renderTextStream(row, committedText, previewText);
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

function directionLabel() {
  const lane = currentLane();
  return `${codeForLanguage(lane.sourceLanguage)} -> ${codeForLanguage(lane.targetLanguage)}`;
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

function codeForLanguage(name) {
  const match = languages.find((item) => item.name === name);
  return (match?.asr || String(name || '').slice(0, 2)).toUpperCase();
}

function flagForLanguage(name) {
  const match = languages.find((item) => item.name === name);
  return match?.flag || LANGUAGE_FLAGS[match?.asr] || '';
}

function setupAutoFollow(el) {
  if (!el) return;
  enableAutoFollow(el);
  el.addEventListener('scroll', () => {
    el.dataset.autofollow = isNearBottom(el) ? 'on' : 'off';
  });
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

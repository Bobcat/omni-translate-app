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
  speakNowButton: document.querySelector('#speakNowButton'),
  sessionRightLabel: document.querySelector('#sessionRightLabel'),
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
  settingsAudioNav: document.querySelector('#settingsAudioNav'),
  settingsHistoryNav: document.querySelector('#settingsHistoryNav'),
  settingsDebugNav: document.querySelector('#settingsDebugNav'),
  settingsMicrophonePage: document.querySelector('#settingsMicrophonePage'),
  settingsAudioPage: document.querySelector('#settingsAudioPage'),
  settingsHistoryPage: document.querySelector('#settingsHistoryPage'),
  settingsDebugPage: document.querySelector('#settingsDebugPage'),
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
  ttsOutputDetail: document.querySelector('#ttsOutputDetail'),
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
  audioInputSampleRate: 16000,
  viewMode: 'turn',
  captureMutedForPlayback: false,
  settingsPage: 'home',
  vadHintTimer: null,
  audioSettings: {
    preGain: 1,
    autoGainControl: false,
    autoGainControlBusy: false,
    inputLevel: 0,
  },
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
  renderTtsOutputState(config.tts);

  els.startButton.addEventListener('click', handleStartButton);
  els.finishButton.addEventListener('click', handleSessionRightAction);
  els.turnModeButton.addEventListener('click', () => setViewMode('turn'));
  els.sourceLanguageSelect.addEventListener('change', () => setVisibleLanguage('source', els.sourceLanguageSelect.value));
  els.targetLanguageSelect.addEventListener('change', () => setVisibleLanguage('target', els.targetLanguageSelect.value));
  els.setupSwapButton.addEventListener('click', swapSetupLanguages);
  els.swapButton.addEventListener('click', swapDirection);
  els.speakNowButton.addEventListener('click', speakNow);
  els.clearTurnButton.addEventListener('click', clearTurn);
  els.settingsButton.addEventListener('click', openSettingsSheet);
  els.settingsBackButton.addEventListener('click', handleSettingsBack);
  els.settingsMicrophoneNav.addEventListener('click', () => setSettingsPage('microphone'));
  els.settingsAudioNav.addEventListener('click', () => setSettingsPage('audio'));
  els.settingsHistoryNav.addEventListener('click', () => setSettingsPage('history'));
  els.settingsDebugNav.addEventListener('click', () => setSettingsPage('debug'));
  els.settingsStartButton.addEventListener('click', startFromSettings);
  els.micPreGain.addEventListener('input', handlePreGainInput);
  els.micAutoGainControl.addEventListener('change', handleAutoGainControlChange);
  els.audioSettingsReset.addEventListener('click', resetAudioSettings);
  els.showStatusLine.addEventListener('change', handleShowStatusLineChange);
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
  setListenBusy(true);
  setStatus('connecting', statusDetail);
  let socket = null;
  let capture = null;
  try {
    const capturePromise = createStartedAudioCapture({ targetSampleRate: state.audioInputSampleRate });
    const session = await api.createSession({
      sideALanguage: state.sideALanguage,
      sideBLanguage: state.sideBLanguage,
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
    return;
  }
  if (state.sessionState === SESSION_STATES.RUNNING && state.micState === MIC_STATES.OFF) {
    startMicrophoneCapture();
  }
}

function handleSessionRightAction() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (state.micState === MIC_STATES.LISTENING) {
    stopMicrophoneCapture({ statusText: 'Mic off' });
    return;
  }
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
  if (msg.type === 'asr_status') {
    if (!els.miniStatus.textContent) {
      els.miniStatus.textContent = 'Processing speech';
    }
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
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  for (const laneId of Object.keys(msg.lanes || {})) {
    mergeLanePayload(laneId, msg.lanes[laneId]);
  }
  applyCurrentTurn(msg.current_turn || createLocalTurn('a_to_b', state.lanes));
  hideVadHint();
  enableTranscriptAutoFollow();
  renderLanguageControls();
  renderTranscript();
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
  const micOffWithSourceText = micOff && hasSourceText();
  const micListening = running && state.micState === MIC_STATES.LISTENING;
  els.app.classList.toggle('is-setup', setup);
  els.app.classList.toggle('is-running', running);
  els.app.classList.toggle('is-mic-off', micOff);
  els.app.classList.toggle('is-mic-listening', micListening);
  els.setupStartPanel.hidden = !(setup || (micOff && !micOffWithSourceText));
  els.sourceText.hidden = setup;
  els.turnHeaderActions.hidden = !running;
  els.setupSwapButton.hidden = !setup;
  els.speakNowButton.hidden = !running;
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
  updateSpeakNowButton();
  updateClearTurnButton();
  updateSessionRightAction();
  renderLanguageControls();
}

function updateSpeakNowButton() {
  const turnIsSpeaking = state.currentTurn.state === TURN_STATES.OPEN_SPEAKING;
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  const canSpeakTarget = Boolean(live && state.currentTurn.speakableTargetText && !turnIsSpeaking);
  const canPlayAudio = Boolean(live && audioQueue?.hasAudio());
  els.speakNowButton.disabled = !(canSpeakTarget || canPlayAudio);
  els.speakNowButton.classList.toggle('is-busy', turnIsSpeaking);
  if (state.audioStatus.startsWith('Playing')) {
    els.speakNowButton.textContent = 'Playing...';
  } else if (canPlayAudio) {
    els.speakNowButton.textContent = 'Play audio';
  } else {
    els.speakNowButton.textContent = 'Speak now';
  }
}

function updateClearTurnButton() {
  const hasText = Boolean(state.currentTurn.sourceText || state.currentTurn.targetText || state.currentTurn.parts.length);
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  els.clearTurnButton.disabled = !hasText || !live;
  els.swapButton.disabled = !live;
}

function updateSessionRightAction() {
  const live = state.sessionState === SESSION_STATES.RUNNING && state.socket?.isOpen();
  const micListening = state.micState === MIC_STATES.LISTENING;
  els.finishButton.disabled = !live;
  els.finishButton.classList.toggle('is-mic-off-action', micListening);
  els.finishButton.classList.toggle('is-finish-action', !micListening);
  els.sessionRightLabel.textContent = micListening ? 'Mic off' : 'Finish';
  els.finishButton.setAttribute('aria-label', micListening ? 'Turn microphone off' : 'Finish session');
  els.finishButton.title = micListening ? 'Mic off' : 'Finish';
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
  setSettingsPage('home');
  renderAudioSettings();
  renderHistorySettings();
  renderDebugSettings();
  els.settingsSheet.hidden = false;
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
  state.settingsPage = page === 'microphone' || page === 'audio' || page === 'history' || page === 'debug' ? page : 'home';
  renderSettingsPage();
}

function renderSettingsPage() {
  const page = state.settingsPage;
  const home = page === 'home';
  els.settingsHomePage.hidden = page !== 'home';
  els.settingsMicrophonePage.hidden = page !== 'microphone';
  els.settingsAudioPage.hidden = page !== 'audio';
  els.settingsHistoryPage.hidden = page !== 'history';
  els.settingsDebugPage.hidden = page !== 'debug';
  els.settingsBackButton.classList.toggle('is-sheet-close', home);
  els.settingsBackButton.classList.toggle('is-subpage-back', !home);
  els.settingsBackButton.setAttribute('aria-label', home ? 'Close settings' : 'Back');
  els.settingsBackButton.title = home ? 'Close settings' : 'Back';
  if (page === 'microphone') {
    els.settingsSheetTitle.textContent = 'Microphone';
  } else if (page === 'audio') {
    els.settingsSheetTitle.textContent = 'Audio output';
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
  state.audioSettings.preGain = 1;
  state.capture?.setPreGain(state.audioSettings.preGain);
  if (state.sessionState === SESSION_STATES.RUNNING && state.capture) {
    state.audioSettings.autoGainControl = false;
    await restartMicrophoneCapture({ statusText: 'Audio reset' });
    return;
  }
  if (state.sessionState !== SESSION_STATES.RUNNING) {
    state.audioSettings.autoGainControl = false;
  } else if (state.micState === MIC_STATES.OFF) {
    state.audioSettings.autoGainControl = false;
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

function renderTtsOutputState(tts) {
  const label = tts?.enabled ? 'on' : 'off';
  els.ttsOutputState.textContent = label;
  els.ttsOutputDetail.textContent = label;
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
  const haloLevel = Math.sqrt(level);
  const clipRisk = state.micState === MIC_STATES.LISTENING && level >= 0.95;
  const hot = level >= 0.85;
  els.finishButton.classList.toggle('is-clip-risk', clipRisk);
  els.finishButton.style.setProperty('--session-right-halo-color', clipRisk ? '185, 28, 28' : hot ? '245, 158, 11' : '59, 130, 246');
  els.finishButton.style.setProperty('--session-right-halo-alpha', (0.08 + haloLevel * (clipRisk ? 0.42 : hot ? 0.36 : 0.3)).toFixed(3));
  els.finishButton.style.setProperty('--session-right-halo-size', `${Math.round(haloLevel * 14)}px`);
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
  renderInlineStartMic();
  renderDirectionLabels(lane);
  pinToBottomIfFollowing(els.sourceText);
  pinToBottomIfFollowing(els.targetText);
}

function renderInlineStartMic() {
  els.sourceText.querySelector('.inline-start-mic')?.remove();
  if (state.sessionState !== SESSION_STATES.RUNNING || state.micState !== MIC_STATES.OFF) return;
  if (!hasSourceText()) return;
  const target = [...els.sourceText.querySelectorAll('.turn-part')]
    .reverse()
    .find((part) => part.textContent.trim());
  if (!target) return;
  target.append(' ');
  target.append(createInlineStartMicButton());
}

function createInlineStartMicButton() {
  const button = document.createElement('button');
  button.className = 'inline-start-mic';
  button.type = 'button';
  button.setAttribute('aria-label', 'Start microphone');
  button.title = 'Start microphone';
  button.addEventListener('click', startMicrophoneCapture);
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
      <line x1="12" y1="19" x2="12" y2="22"></line>
    </svg>
  `;
  return button;
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

function hasSourceText() {
  return Boolean(state.currentTurn.sourceText || joinPartText(state.currentTurn.parts, 'source'));
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

import { api, SessionSocket } from './api-client.js';
import { AudioCapture } from './shared/audio-capture.js';
import { AudioQueue } from './shared/audio-playback.js';
import {
  codeForLanguage,
  normalizeLanguageName,
} from './shared/languages.js';
import {
  saveDevToolsSettings,
  getRecentLanguages,
} from './shared/storage.js';
import {
  LANE_IDS,
  TURN_STATES,
  SESSION_STATES,
  MIC_STATES,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_TUNING_SETTINGS,
} from './shared/constants.js';
import { mergeSettings } from './shared/utils.js';
import {
  buildLocalLanes,
  createLocalTurn,
  currentLane,
  currentLaneId,
  ensureLane,
} from './shared/lanes.js';
import { els } from './els.js';
import { state } from './state.js';
import {
  applyTtsConfig,
  mergeStoredTtsConfigIntoState,
  syncVoxcpm2VoiceConfigToBackend,
  handleTtsEnabledChange,
  handleTtsBackendChange,
  handleTtsSettingChange,
  handleTtsSettingsClick,
  renderTtsSettings,
} from './tts/settings.js';
import {
  setAudioQueue,
  renderVoiceLibraryPage,
  handleVoiceLibraryChange,
  handleVoiceLibraryClick,
  applyVoiceLibraryStatus,
} from './tts/voice-library.js';
import {
  renderTuningSettings,
  handleTuningSettingChange,
} from './tuning/settings.js';
import {
  setLanguagePickHandler,
  consumeLanguagePopstateSkip,
  openLanguageSheet,
  closeLanguageSheet,
  setupSheetSwipeClose,
  onLanguageSheetViewportResize,
  initLanguageSheetSearch,
} from './ui/sheets.js';
import {
  setAudioQueue as setTranscriptAudioQueue,
  renderTranscript,
  setupAutoFollow,
  enableTranscriptAutoFollow,
  handleTargetTextClick,
  normalizeTurnPayload,
} from './transcript/render.js';

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
setAudioQueue(audioQueue);
setTranscriptAudioQueue(audioQueue);

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
  initLanguageSheetSearch();
  window.visualViewport?.addEventListener('resize', onLanguageSheetViewportResize);
  setLanguagePickHandler(setVisibleLanguage);
  els.setupSwapButton.addEventListener('click', swapSetupLanguages);
  els.translateNowButton.addEventListener('click', translateNow);
  els.speakNowButton.addEventListener('click', speakNow);
  els.swapButton.addEventListener('click', swapDirection);
  els.settingsButton.addEventListener('click', openSettingsSheet);
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
  if (consumeLanguagePopstateSkip()) {
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

function handleDevToolsShowPcExportChange() {
  state.devToolsSettings.showPcExport = els.devToolsShowPcExport.checked;
  saveDevToolsSettings(state.devToolsSettings);
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


function renderHistorySettings() {
  els.historySettingsSummary.textContent = 'off';
  els.historySaveSessions.checked = false;
  els.historySaveSessions.disabled = true;
  els.historyRetentionDays.value = '7';
  els.historyRetentionDays.disabled = true;
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


function normalizePreGain(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0.5, Math.min(3.0, numeric)) : 1;
}

function normalizeLevel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}


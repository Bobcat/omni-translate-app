// Session lifecycle: connecting + starting the WS session, finishing it,
// mic capture start/stop/restart, history-stack syncing for the running
// view, popstate dispatch, VAD-hint badge, view-mode toggle, PC export.
//
// State writes happen here; UI render happens via ui/render-status.js
// and ui/action-buttons.js.

import { api, SessionSocket } from '../api-client.js';
import { AudioCapture } from '../shared/audio-capture.js';
import { state } from '../state.js';
import { els } from '../els.js';
import {
  SESSION_STATES,
  MIC_STATES,
  TURN_STATES,
} from '../shared/constants.js';
import {
  buildLocalLanes,
  createLocalTurn,
  currentLaneId,
} from '../domain/lanes.js';
import {
  setStatus,
  renderLifecycle,
  setListenBusy,
  renderMicLevel,
} from '../ui/render-status.js';
import { updateActionButtons } from '../ui/action-buttons.js';
import { renderAudioSettings } from '../settings/audio.js';
import { renderTuningSettings } from '../settings/tuning.js';
import { renderTranscript } from '../ui/render-turn.js';
import { enableTranscriptAutoFollow } from '../ui/auto-follow.js';
import {
  armAutoOffSilenceTimer,
  clearAutoOffSilenceTimer,
  registerMicAutoOffStopHandler,
} from './mic-auto-off.js';
import { playMicOffCue, playMicOnCue } from '../shared/audio-cue.js';

registerMicAutoOffStopHandler(() => stopMicrophoneCapture());
import {
  closeLanguageSheet,
  consumeLanguagePopstateSkip,
} from '../ui/language-sheet.js';
import { handleSettingsSheetPopstate } from '../settings/sheet.js';
import { audioQueue } from './audio-queue.js';
import { handleMessage } from './messages.js';

export async function startListening({ withMic = true } = {}) {
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
    const capturePromise = withMic
      ? createStartedAudioCapture({ targetSampleRate: state.audioInputSampleRate })
      : Promise.resolve(null);
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
    state.socket.startListening();
    if (withMic) {
      state.capture = capture;
      state.audioSettings.autoGainControl = state.capture.autoGainControl;
      state.micState = MIC_STATES.LISTENING;
      if (state.audioSettings.autoOffCueEnabled) {
        try { playMicOnCue(); } catch {}
      }
    } else {
      state.capture = null;
      state.micState = MIC_STATES.OFF;
    }
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

export function handleStartButton() {
  if (state.sessionState === SESSION_STATES.SETUP) {
    startListening();
  }
}

export function handleMicToggle() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (state.micState === MIC_STATES.LISTENING) {
    stopMicrophoneCapture();
    return;
  }
  if (state.micState === MIC_STATES.OFF) {
    startMicrophoneCapture();
  }
}

export function finishSession() {
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

export async function startMicrophoneCapture() {
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
    enableTranscriptAutoFollow();
    armAutoOffSilenceTimer();
    if (state.audioSettings.autoOffCueEnabled) {
      try { playMicOnCue(); } catch {}
    }
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

export function stopMicrophoneCapture() {
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  state.captureMutedForPlayback = false;
  clearAutoOffSilenceTimer();
  state.capture?.stop();
  state.capture = null;
  state.micState = MIC_STATES.OFF;
  state.socket?.discardInflight();
  if (state.audioSettings.autoOffCueEnabled) {
    try { playMicOffCue(); } catch {}
  }
  hideVadHint();
  renderMicLevel(0);
  renderAudioSettings();
  renderTranscript();
  setStatus('listening');
}

export async function restartMicrophoneCapture() {
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

function shouldSendMicrophoneAudio() {
  return state.sessionState === SESSION_STATES.RUNNING
    && state.micState === MIC_STATES.LISTENING
    && !state.captureMutedForPlayback
    && state.currentTurn.state !== TURN_STATES.OPEN_SPEAKING;
}

export function cleanupClientSession({ keepSocket = false } = {}) {
  state.capture?.stop();
  state.capture = null;
  state.micState = MIC_STATES.OFF;
  state.pcExportBusy = false;
  state.captureMutedForPlayback = false;
  state.speakInflightFilter = null;
  hideVadHint();
  renderMicLevel(0);
  renderAudioSettings();
  if (!keepSocket) {
    state.socket?.close();
    state.socket = null;
    state.sessionId = null;
  }
}

export function resetSessionToSetup() {
  clearAllLanes({ laneId: 'a_to_b' });
  state.requestedStartLaneId = 'a_to_b';
  state.captureMutedForPlayback = false;
  setSessionState(SESSION_STATES.SETUP);
  setStatus('idle');
}

export function clearAllLanes({ laneId = currentLaneId() } = {}) {
  state.lanes = buildLocalLanes(state.sideALanguage, state.sideBLanguage);
  state.currentTurn = createLocalTurn(laneId, state.lanes);
  audioQueue.clear();
  hideVadHint();
  enableTranscriptAutoFollow();
  renderTranscript();
  updateActionButtons();
}

export function setSessionState(sessionState) {
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

export function handlePopstateBack(event) {
  if (consumeLanguagePopstateSkip()) return;
  if (!els.languageSheet.hidden) {
    closeLanguageSheet();
    return;
  }
  if (handleSettingsSheetPopstate(event)) return;
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  _skipHistorySync = true;
  try {
    finishSession();
  } finally {
    _skipHistorySync = false;
  }
}

export function setViewMode(viewMode) {
  state.viewMode = viewMode === 'conversation' ? 'conversation' : 'turn';
  renderLifecycle();
}

export async function exportPcTranscript() {
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

export function startFromSettings() {
  if (state.status === 'connecting') return;
  if (state.sessionState === SESSION_STATES.RUNNING && state.micState === MIC_STATES.LISTENING) {
    stopMicrophoneCapture();
    return;
  }
  if (state.sessionState === SESSION_STATES.SETUP) {
    startListening();
    return;
  }
  if (state.sessionState === SESSION_STATES.RUNNING && state.micState === MIC_STATES.OFF) {
    startMicrophoneCapture();
  }
}

export function handleVadState(msg) {
  // shouldApplyCurrentTurnMessage lives in session/messages.js, but VAD
  // events are also dispatched there — by the time we get here the gate
  // has already been checked in handleMessage's switch.
  if (state.sessionState !== SESSION_STATES.RUNNING) {
    hideVadHint();
    return;
  }
  if (msg.speech_detected !== true) {
    hideVadHint();
    return;
  }
  showVadHint();
  // Real speech observed: restart the silence-based auto-off countdown.
  armAutoOffSilenceTimer();
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

export function hideVadHint() {
  if (state.vadHintTimer) {
    clearTimeout(state.vadHintTimer);
    state.vadHintTimer = null;
  }
  els.vadBadge.hidden = true;
}

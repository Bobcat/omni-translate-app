// WebSocket message dispatch: handleMessage routes incoming server
// events to applyReady / applyTurnUpdate / handleVadState / etc., and
// fans out into TTS audio enqueuing + action-button refreshes.

import { state } from '../state.js';
import {
  DEFAULT_TUNING_SETTINGS,
  MIC_STATES,
  TURN_STATES,
} from '../shared/constants.js';
import { mergeSettings } from '../shared/utils.js';
import { normalizeLanguageName } from '../domain/languages.js';
import {
  buildLocalLanes,
  createLocalTurn,
  currentLaneId,
  ensureLane,
} from '../domain/lanes.js';
import {
  setStatus,
  renderLanguageControls,
} from '../ui/render-status.js';
import { updateActionButtons } from '../ui/action-buttons.js';
import { renderTuningSettings } from '../settings/tuning.js';
import { renderTtsSettings } from '../settings/tts.js';
import { renderTranscript } from '../ui/render-turn.js';
import { enableTranscriptAutoFollow } from '../ui/auto-follow.js';
import { normalizeTurnPayload } from '../domain/turns.js';
import { audioQueue } from './audio-queue.js';
import {
  hideVadHint,
  handleVadState,
  resetSessionToSetup,
  cleanupClientSession,
} from './lifecycle.js';
import { clearSpeakNowPending } from './actions.js';
import {
  armAutoOffSilenceTimer,
  clearAutoOffSilenceTimer,
  performMicAutoOff,
} from './mic-auto-off.js';

export function handleMessage(msg) {
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
    if (shouldApplyCurrentTurnMessage(msg)) handleVadState(msg);
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
  const previousLaneId = currentLaneId();
  const previousTurnState = String(state.currentTurn?.state || '');
  for (const laneId of Object.keys(msg.lanes || {})) {
    mergeLanePayload(laneId, msg.lanes[laneId]);
  }
  applyCurrentTurn(msg.current_turn || state.currentTurn);
  clearSpeakNowPending();
  const laneChanged = previousLaneId !== currentLaneId();
  if (laneChanged || msg.reason === 'next_turn') {
    audioQueue.clear();
    hideVadHint();
    enableTranscriptAutoFollow();
  }
  applyMicAutoOffSideEffects(previousTurnState, String(msg.reason || ''));
  renderLanguageControls();
  renderTranscript();
  updateActionButtons();
  renderTurnStatus(msg.reason);
}

function applyMicAutoOffSideEffects(previousTurnState, reason) {
  // Pause the silence timer while TTS is playing (we don't want the
  // user's "listening to playback" time to count against them), and
  // restart it when playback completes.
  const newTurnState = String(state.currentTurn?.state || '');
  if (previousTurnState !== newTurnState) {
    if (newTurnState === TURN_STATES.OPEN_SPEAKING) {
      clearAutoOffSilenceTimer();
    } else if (
      previousTurnState === TURN_STATES.OPEN_SPEAKING
      && state.micState === MIC_STATES.LISTENING
    ) {
      armAutoOffSilenceTimer();
    }
  }
  // Opt-in: stop the mic right after a heuristic bubble close. The
  // duration-cap close is excluded — it fires when there is no natural
  // pause, so it does not indicate intent to stop talking.
  if (
    state.audioSettings.autoOffAfterBubble
    && state.micState === MIC_STATES.LISTENING
    && (reason === 'bubble_close:sentence_boundary' || reason === 'bubble_close:vad_silence')
  ) {
    performMicAutoOff('bubble_close');
  }
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

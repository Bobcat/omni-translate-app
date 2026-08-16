// Voice session state machine for the desktop view. Trimmed port of the
// mobile session flow (static/src/session/lifecycle.js + messages.js +
// audio-queue.js): same protocol against the same backend, minus the
// mobile-only concerns (tuning/live-settings, mic auto-off,
// PC export, history stack). Live/TTS settings are left at the server
// defaults — the desktop app has no tuning UI.
//
// All state lives in this closure. The shell keeps the voice view alive
// across navigation, so a running session (socket, mic capture, audio
// queue) survives view switches untouched; the view re-renders from
// `state` on every `onChange`.

import { SessionSocket } from '../../../../src/api-client.js';
import { AudioCapture } from '../../../../src/shared/audio-capture.js';
import { playMicOffCue, playMicOnCue } from '../../../../src/shared/audio-cue.js';
import { AudioQueue } from '../../../../src/shared/audio-playback.js';
import { guessSetupLanguages, normalizeLanguageName } from '../../../../src/domain/languages.js';
import { loadSetupLanguages, persistSetupLanguages } from '../../../../src/domain/storage.js';
import { getConfig, createVoiceSession as requestVoiceSession } from '../../shared/api.js';
import { publishViewBusy } from '../../shared/view-activity.js';

const LANE_IDS = ['a_to_b', 'b_to_a'];

const MIC_STATES = { LISTENING: 'listening', OFF: 'off' };
const TURN_STATES = {
  OPEN_EMPTY: 'open_empty',
  OPEN_SPEAKING: 'open_speaking',
};

function buildLanes(sideALanguage, sideBLanguage) {
  return {
    a_to_b: { laneId: 'a_to_b', sourceLanguage: sideALanguage, targetLanguage: sideBLanguage },
    b_to_a: { laneId: 'b_to_a', sourceLanguage: sideBLanguage, targetLanguage: sideALanguage },
  };
}

function createLocalTurn(laneId, lanes) {
  const safeLaneId = LANE_IDS.includes(laneId) ? laneId : 'a_to_b';
  const lane = lanes[safeLaneId];
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
    isClosed: Boolean(part?.is_closed),
  };
}

function joinPartText(parts, role) {
  return (parts || [])
    .map((part) => (role === 'source' ? part.sourceText : part.targetText))
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

export function visibleText(committed, preview) {
  const left = String(committed || '').trim();
  const right = String(preview || '').trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

// `resumeButton` is owned by the view: the AudioQueue unhides it when
// autoplay is blocked so the user can start playback manually.
export function createVoiceSession({ onChange, onMicLevel, resumeButton }) {
  const initialLanguages = loadSetupLanguages() || guessSetupLanguages();

  const state = {
    socket: null,
    sessionId: null,
    capture: null,
    live: false,
    // Async start/stop of the mic in flight; gates the mic button.
    starting: false,
    micState: MIC_STATES.OFF,
    sideALanguage: normalizeLanguageName(initialLanguages.source),
    sideBLanguage: normalizeLanguageName(initialLanguages.target),
    lanes: null,
    currentTurn: null,
    audioInputSampleRate: 16000,
    ttsEnabled: true,
    audioPlayback: null,
    captureMutedForPlayback: false,
    speakNowPending: false,
    speakInflightFilter: null,
    vadVisible: false,
    status: 'idle',
    statusMessage: '',
    audioStatus: '',
  };
  state.lanes = buildLanes(state.sideALanguage, state.sideBLanguage);
  state.currentTurn = createLocalTurn('a_to_b', state.lanes);

  let speakNowPendingTimer = null;
  let vadHintTimer = null;
  // The AudioQueue constructor fires onStatus synchronously, before the
  // view's `const session = createVoiceSession(...)` binding exists — a
  // render then would hit the TDZ. The view renders itself right after
  // construction, so suppressing onChange until then loses nothing.
  let constructed = false;

  function emit() {
    if (!constructed) return;
    onChange?.();
  }

  function currentLaneId() {
    return LANE_IDS.includes(state.currentTurn?.laneId) ? state.currentTurn.laneId : 'a_to_b';
  }

  function ensureLane(laneId) {
    const safeLaneId = LANE_IDS.includes(laneId) ? laneId : currentLaneId();
    if (!state.lanes[safeLaneId]) {
      state.lanes[safeLaneId] = {
        laneId: safeLaneId,
        sourceLanguage: state.sideALanguage,
        targetLanguage: state.sideBLanguage,
      };
    }
    return state.lanes[safeLaneId];
  }

  function currentLane() {
    return ensureLane(currentLaneId());
  }

  // The audio element is deliberately NOT attached to the DOM: playback
  // continues while the router has the view detached (keep-alive).
  const audioQueue = new AudioQueue({
    audio: new Audio(),
    resumeButton,
    onStatus: (text) => {
      state.audioStatus = text;
      emit();
    },
    onPlaybackStart: (item) => {
      state.captureMutedForPlayback = true;
      state.audioPlayback = item || null;
      emit();
    },
    onPlaybackIdle: () => {
      state.captureMutedForPlayback = false;
      state.audioPlayback = null;
      emit();
    },
    onPlaybackComplete: () => {
      // Turn flow: once the translation has been spoken, the mic goes off.
      if (!state.live || state.micState !== MIC_STATES.LISTENING) return;
      stopMic();
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

  // --- session lifecycle -------------------------------------------------

  async function start() {
    resetTranscript();
    state.starting = true;
    state.status = 'connecting';
    state.statusMessage = '';
    emit();
    let socket = null;
    let capture = null;
    let trackedCapture = Promise.resolve();
    try {
      const capturePromise = createStartedCapture({ targetSampleRate: state.audioInputSampleRate });
      // Hand the started capture over as soon as it resolves — not only on the
      // happy path — so the catch below can stop it when the session request or
      // socket connect fails while the mic is still starting. The rejection
      // swallow just silences this branch; Promise.all still sees failures.
      trackedCapture = capturePromise.then((startedCapture) => {
        capture = startedCapture;
      }, () => {});
      const session = await requestVoiceSession({
        sideA: state.sideALanguage,
        sideB: state.sideBLanguage,
      });
      const sessionId = String(session.session?.session_id || session.session_id || '').trim();
      if (!sessionId) throw new Error('Missing session id');
      state.sessionId = sessionId;
      socket = new SessionSocket(session.ws_url, handleMessage, () => {
        if (state.socket !== socket) return;
        cleanupSession({ keepSocket: false });
        resetToSetup();
        emit();
      });
      await Promise.all([
        socket.connect(),
        capturePromise,
      ]);
      state.socket = socket;
      state.audioInputSampleRate = session.audio_input?.sample_rate_hz || 16000;
      state.socket.startListening();
      state.capture = capture;
      state.micState = MIC_STATES.LISTENING;
      onMicLevel?.(0, true);
      safePlayMicOnCue();
      state.live = true;
      publishViewBusy('voice', true);
      state.status = 'listening';
    } catch (error) {
      // Wait for the mic start to settle so `capture` is final before cleanup.
      await trackedCapture;
      capture?.stop();
      socket?.close();
      cleanupSession();
      state.sessionId = null;
      resetToSetup();
      state.status = 'error';
      state.statusMessage = error?.message || 'Could not start the voice session.';
    } finally {
      state.starting = false;
      emit();
    }
  }

  function endSession() {
    if (!state.live) return;
    if (!state.socket?.isOpen()) {
      cleanupSession();
      resetToSetup();
      emit();
      return;
    }
    const finishingSocket = state.socket;
    // pause_listening makes the backend wrap up and send `ended`; that
    // message lands after we forgot the session and is ignored.
    finishingSocket.finishListening();
    if (state.socket === finishingSocket) {
      state.socket = null;
    }
    state.sessionId = null;
    state.capture?.stop();
    state.capture = null;
    state.micState = MIC_STATES.OFF;
    onMicLevel?.(0, false);
    resetToSetup();
    emit();
  }

  function cleanupSession({ keepSocket = false } = {}) {
    state.capture?.stop();
    state.capture = null;
    state.micState = MIC_STATES.OFF;
    onMicLevel?.(0, false);
    state.captureMutedForPlayback = false;
    state.speakInflightFilter = null;
    hideVadHint();
    if (!keepSocket) {
      state.socket?.close();
      state.socket = null;
      state.sessionId = null;
    }
  }

  function resetToSetup() {
    state.live = false;
    state.micState = MIC_STATES.OFF;
    onMicLevel?.(0, false);
    resetTranscript();
    publishViewBusy('voice', false);
    if (state.status !== 'error') state.status = 'idle';
  }

  function resetTranscript() {
    state.lanes = buildLanes(state.sideALanguage, state.sideBLanguage);
    state.currentTurn = createLocalTurn('a_to_b', state.lanes);
    audioQueue.clear();
    hideVadHint();
  }

  // --- microphone ----------------------------------------------------------

  function toggleMic() {
    if (state.starting) return;
    if (!state.live) {
      start();
      return;
    }
    if (state.micState === MIC_STATES.LISTENING) {
      stopMic();
      return;
    }
    startMic();
  }

  async function startMic() {
    if (!state.live || state.micState !== MIC_STATES.OFF) return;
    if (!state.socket?.isOpen()) return;
    state.starting = true;
    emit();
    try {
      const capture = createCapture({ targetSampleRate: state.audioInputSampleRate });
      await capture.start();
      state.capture = capture;
      state.socket.startListening();
      state.micState = MIC_STATES.LISTENING;
      onMicLevel?.(0, true);
      safePlayMicOnCue();
      state.captureMutedForPlayback = false;
      state.status = 'listening';
    } catch (error) {
      state.capture?.stop();
      state.capture = null;
      state.micState = MIC_STATES.OFF;
      onMicLevel?.(0, false);
      state.status = 'error';
      state.statusMessage = error?.message || 'Microphone unavailable.';
    } finally {
      state.starting = false;
      emit();
    }
  }

  function stopMic() {
    if (!state.live) return;
    state.captureMutedForPlayback = false;
    state.capture?.stop();
    state.capture = null;
    state.micState = MIC_STATES.OFF;
    onMicLevel?.(0, false);
    safePlayMicOffCue();
    if (state.currentTurn.canTranslateNow) {
      state.socket?.translateNow();
    }
    state.socket?.discardInflight();
    hideVadHint();
    state.status = 'listening';
    emit();
  }

  function createCapture({ targetSampleRate = 16000 } = {}) {
    return new AudioCapture({
      targetSampleRate,
      chunkMs: 40,
      // Same fixed input settings as the mobile defaults; the desktop app
      // has no audio-settings UI.
      preGain: 1.5,
      autoGainControl: true,
      onChunk: (buffer) => {
        if (shouldSendMicrophoneAudio()) state.socket?.sendAudio(buffer);
      },
      onLevel: (level) => onMicLevel?.(level, state.micState === MIC_STATES.LISTENING),
    });
  }

  async function createStartedCapture({ targetSampleRate = 16000 } = {}) {
    const capture = createCapture({ targetSampleRate });
    try {
      await capture.start();
      return capture;
    } catch (error) {
      capture.stop();
      throw error;
    }
  }

  function shouldSendMicrophoneAudio() {
    return state.live
      && state.micState === MIC_STATES.LISTENING
      && !state.captureMutedForPlayback
      && state.currentTurn.state !== TURN_STATES.OPEN_SPEAKING;
  }

  // --- turn actions --------------------------------------------------------

  function translateNow() {
    if (!state.live) return;
    if (!state.currentTurn.canTranslateNow) return;
    state.socket?.translateNow();
  }

  function speakNow() {
    if (!state.live) return;
    if (audioQueue.hasNonReplayAudio()) {
      audioQueue.playOrResume();
      return;
    }
    const canSpeak = state.currentTurn.speakableTargetText
      && state.currentTurn.state !== TURN_STATES.OPEN_SPEAKING
      && state.socket?.speakNow();
    if (!canSpeak) return;
    state.speakNowPending = true;
    state.speakInflightFilter = {
      turnId: String(state.currentTurn.turnId || ''),
      knownPartIds: new Set(
        (state.currentTurn.parts || [])
          .map((part) => String(part.partId || ''))
          .filter(Boolean),
      ),
    };
    if (speakNowPendingTimer) clearTimeout(speakNowPendingTimer);
    speakNowPendingTimer = setTimeout(() => {
      state.speakNowPending = false;
      speakNowPendingTimer = null;
      state.speakInflightFilter = null;
      emit();
    }, 1500);
    if (state.micState === MIC_STATES.LISTENING) {
      stopMic();
    }
    emit();
  }

  function clearSpeakNowPending() {
    if (!state.speakNowPending && !speakNowPendingTimer) return;
    state.speakNowPending = false;
    if (speakNowPendingTimer) {
      clearTimeout(speakNowPendingTimer);
      speakNowPendingTimer = null;
    }
  }

  function speakPart(partId) {
    if (!state.live || !state.ttsEnabled) return;
    const id = String(partId || '').trim();
    if (!id) return;
    state.socket?.speakPart(id);
  }

  function replayPart({ laneId, text }) {
    if (!state.live || !state.ttsEnabled) return;
    if (!String(text || '').trim()) return;
    state.socket?.replayTts({ laneId, text });
  }

  function stopAudio() {
    audioQueue.stop();
    emit();
  }

  function swap() {
    if (state.starting) return;
    if (!state.live) {
      const previousSideA = state.sideALanguage;
      state.sideALanguage = state.sideBLanguage;
      state.sideBLanguage = previousSideA;
      state.lanes = buildLanes(state.sideALanguage, state.sideBLanguage);
      state.currentTurn = createLocalTurn(currentLaneId(), state.lanes);
      persistSetupLanguages(state.sideALanguage, state.sideBLanguage);
      emit();
      return;
    }
    if (!state.socket?.isOpen()) return;
    const nextLaneId = currentLaneId() === 'a_to_b' ? 'b_to_a' : 'a_to_b';
    audioQueue.clear();
    state.socket.nextTurn(nextLaneId);
  }

  function setLanguage(role, name) {
    if (state.live || state.starting) return;
    const next = normalizeLanguageName(name);
    if (role === 'source') state.sideALanguage = next;
    else state.sideBLanguage = next;
    state.lanes = buildLanes(state.sideALanguage, state.sideBLanguage);
    state.currentTurn = createLocalTurn('a_to_b', state.lanes);
    persistSetupLanguages(state.sideALanguage, state.sideBLanguage);
    emit();
  }

  // --- server messages -----------------------------------------------------

  function handleMessage(msg) {
    const msgSessionId = String(msg?.session_id || '').trim();
    if (!state.sessionId || msgSessionId !== state.sessionId) return;
    if (msg.type === 'ready') {
      applyReady(msg);
      return;
    }
    if (msg.type === 'state') {
      state.status = msg.state || 'idle';
      emit();
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
      emit();
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
      emit();
      return;
    }
    if (msg.type === 'tts_status' || msg.type === 'translation_status') {
      emit();
      return;
    }
    if (msg.type === 'asr_status') {
      return;
    }
    if (msg.type === 'live_settings') {
      // Desktop has no tuning UI; the server defaults stand.
      return;
    }
    if (msg.type === 'error') {
      state.status = 'error';
      state.statusMessage = String(msg.message || 'Voice session error.');
      emit();
      return;
    }
    if (msg.type === 'ended') {
      state.captureMutedForPlayback = false;
      cleanupSession({ keepSocket: false });
      resetToSetup();
      emit();
    }
  }

  function applyReady(msg) {
    state.sideALanguage = normalizeLanguageName(msg.side_a_language || state.sideALanguage);
    state.sideBLanguage = normalizeLanguageName(msg.side_b_language || state.sideBLanguage);
    state.lanes = buildLanes(state.sideALanguage, state.sideBLanguage);
    for (const laneId of Object.keys(msg.lanes || {})) {
      mergeLanePayload(laneId, msg.lanes[laneId]);
    }
    state.currentTurn = normalizeTurnPayload(msg.current_turn || createLocalTurn('a_to_b', state.lanes));
    hideVadHint();
    emit();
  }

  function applyTurnUpdate(msg) {
    const previousLaneId = currentLaneId();
    for (const laneId of Object.keys(msg.lanes || {})) {
      mergeLanePayload(laneId, msg.lanes[laneId]);
    }
    state.currentTurn = normalizeTurnPayload(applySpeakInflightFilter(msg));
    clearSpeakNowPending();
    const laneChanged = previousLaneId !== currentLaneId();
    if (laneChanged || msg.reason === 'next_turn') {
      audioQueue.clear();
      hideVadHint();
    }
    emit();
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

  function applySpeakInflightFilter(msg) {
    // Drop parts created by in-flight ASR commits that landed between the
    // user's Speak click and speak_now's own turn_update — they would
    // otherwise flash into the transcript right before TTS starts.
    const filter = state.speakInflightFilter;
    const turn = msg.current_turn;
    if (!filter || !turn) return turn || state.currentTurn;
    if (String(turn.turn_id || '') !== filter.turnId) return turn;
    if (msg.reason === 'speak_now') {
      state.speakInflightFilter = null;
      return turn;
    }
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    const filteredParts = parts.filter((p) => filter.knownPartIds.has(String(p?.part_id || '')));
    if (filteredParts.length === parts.length) return turn;
    return { ...turn, parts: filteredParts };
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

  // --- VAD hint --------------------------------------------------------------

  function handleVadState(msg) {
    if (!state.live) {
      hideVadHint();
      return;
    }
    if (msg.speech_detected !== true) {
      hideVadHint();
      return;
    }
    state.vadVisible = true;
    if (vadHintTimer) clearTimeout(vadHintTimer);
    vadHintTimer = setTimeout(() => {
      vadHintTimer = null;
      state.vadVisible = false;
      emit();
    }, 900);
    emit();
  }

  function hideVadHint() {
    if (vadHintTimer) {
      clearTimeout(vadHintTimer);
      vadHintTimer = null;
    }
    state.vadVisible = false;
  }

  // --- config ------------------------------------------------------------------

  // One-shot fetch for TTS availability and the capture sample rate; the
  // defaults stand when the config cannot be loaded.
  async function loadConfig() {
    try {
      const config = await getConfig();
      state.audioInputSampleRate = config.audio_input?.sample_rate_hz || 16000;
      state.ttsEnabled = config.tts?.enabled !== false;
      emit();
    } catch {
      // Defaults stand.
    }
  }

  constructed = true;

  return {
    state,
    audioQueue,
    currentLane,
    currentLaneId,
    loadConfig,
    toggleMic,
    endSession,
    translateNow,
    speakNow,
    speakPart,
    replayPart,
    stopAudio,
    swap,
    setLanguage,
  };
}

function safePlayMicOnCue() {
  try {
    return playMicOnCue();
  } catch {
    return false;
  }
}

function safePlayMicOffCue() {
  try {
    return playMicOffCue();
  } catch {
    return false;
  }
}

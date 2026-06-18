// The single AudioQueue instance and its session-lifecycle callbacks.
// Built at module evaluation; consumers import `audioQueue` directly.
// settings/voice-library.js still uses the old setter pattern and is
// wired from app.js — out of scope to change in this refactor.

import { AudioQueue } from '../shared/audio-playback.js';
import { state } from '../state.js';
import { els } from '../els.js';
import { APP_MODES, MIC_STATES } from '../shared/constants.js';
import { updateActionButtons } from '../ui/action-buttons.js';
import { renderTranscript } from '../ui/render-turn.js';
import { stopMicrophoneCapture } from './lifecycle.js';

export const audioQueue = new AudioQueue({
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
    if (state.appMode !== APP_MODES.LIVE_RECORDING || state.micState !== MIC_STATES.LISTENING) return;
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

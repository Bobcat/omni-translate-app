// The single AudioQueue instance and its session-lifecycle callbacks.
// Built at module evaluation; consumers import `audioQueue` directly.
// settings/voice-library.js still uses the old setter pattern and is
// wired from app.js — out of scope to change in this refactor.

import { AudioQueue } from '../shared/audio-playback.js?v=20260829-ios-playback-1';
import { usesIosVoiceAudioPath } from '../shared/audio-session.js?v=20260829-ios-playback-1';
import { shouldStopMicrophoneAfterPlayback } from '../shared/voice-playback.js';
import { state } from '../state.js';
import { els } from '../els.js';
import { APP_MODES, MIC_STATES } from '../shared/constants.js';
import { updateActionButtons } from '../ui/action-buttons.js';
import { renderTranscript } from '../ui/render-turn.js';
import {
  pauseMicrophoneCaptureForIosPlayback,
  resumeMicrophoneCaptureAfterIosPlayback,
  stopMicrophoneCapture,
} from './lifecycle.js';

export const audioQueue = new AudioQueue({
  audio: els.ttsAudio,
  resumeButton: els.audioResumeButton,
  playbackStartDelayMs: usesIosVoiceAudioPath() ? 90 : 0,
  onStatus: (text) => {
    state.audioStatus = text;
    updateActionButtons();
  },
  onPlaybackWillStart: () => {
    pauseMicrophoneCaptureForIosPlayback();
  },
  onPlaybackStart: (item) => {
    state.captureMutedForPlayback = true;
    state.audioPlayback = item || null;
    renderTranscript();
  },
  onPlaybackIdle: () => {
    state.audioPlayback = null;
    if (!resumeMicrophoneCaptureAfterIosPlayback()) {
      state.captureMutedForPlayback = false;
    }
    renderTranscript();
  },
  onPlaybackComplete: (item) => {
    if (!shouldStopMicrophoneAfterPlayback(item)) return;
    if (state.appMode !== APP_MODES.LIVE_RECORDING || state.micState !== MIC_STATES.LISTENING) return;
    stopMicrophoneCapture();
  },
  onItemEnded: (item) => {
    if (item.replay) return;
    const selection = new Set(item.partIds || []);
    for (const part of state.currentTurn?.parts || []) {
      if (selection.has(part.partId) && part.speechState === 'speaking') part.speechState = 'spoken';
    }
    state.socket?.ttsPlaybackComplete({
      laneId: item.laneId,
      turnId: item.turnId,
      artifactId: item.artifactId,
    });
  },
  onItemFailed: (item) => {
    state.socket?.stopTts({
      laneId: item.laneId,
      turnId: item.turnId,
      artifactId: '',
    });
    audioQueue.stop();
  },
});

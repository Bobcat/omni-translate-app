// Voice options bottom sheet: the voice that speaks translations, whether they
// speak automatically, and what the speaker clone is reporting. The behaviour
// comes from session/voice-options.js; this module only renders and routes taps.

import { els } from '../els.js';
import { state } from '../state.js';
import { APP_MODES } from '../shared/constants.js';
import { VOICE_MODE_SPEAKER_CLONE } from '../domain/voice-selection.js';
import { visibleVoiceCloningGuidance, visibleVoiceCloningStatus } from '../domain/cloning-status.js';
import { currentLaneId } from '../domain/lanes.js';
import { setupSheetSwipeClose } from './sheets.js';
import {
  VOICE_HISTORY_LIVE,
  VOICE_HISTORY_PANEL,
  currentVoiceHistoryState,
  handleVoiceHistoryPopstate,
  requestVoiceHistoryState,
} from '../session/history.js';
import { sessionTtsSettingsPayload } from '../settings/tts.js';
import {
  autoSpeak,
  setAutoSpeak,
  setVoiceMode,
  voiceCloningStatus,
  voiceMode,
  voiceModeAvailable,
} from '../session/voice-options.js';

const VOICE_OPTION_ROWS = [
  { mode: 'female', label: 'Female' },
  { mode: 'male', label: 'Male' },
  { mode: VOICE_MODE_SPEAKER_CLONE, label: 'Clone speaker' },
];

export function initVoiceOptionsSheet() {
  els.voiceOptionsButton.addEventListener('click', openVoiceOptionsSheet);
  els.closeVoiceOptionsButton.addEventListener('click', closeVoiceOptionsSheet);
  els.voiceOptionsScrim.addEventListener('click', closeVoiceOptionsSheet);
  els.voiceModeGroup.addEventListener('change', (event) => {
    const input = event.target;
    if (input?.name !== 'voiceMode') return;
    // The session module notifies its change handler, which re-renders this
    // sheet; rendering here as well would duplicate that.
    setVoiceMode(input.value);
  });
  els.voiceAutoSpeak.addEventListener('change', () => {
    const enabled = els.voiceAutoSpeak.checked;
    setAutoSpeak(enabled);
    // The server replaces the session's TTS snapshot with what it receives, so
    // a partial update would drop the backend and voice settings. Send the same
    // full payload the TTS settings page sends.
    if (state.socket?.isOpen?.()) {
      state.socket.updateTtsSettings(sessionTtsSettingsPayload());
    }
  });
  setupSheetSwipeClose({
    layer: els.voiceOptionsSheet,
    sheet: els.voiceOptionsSheet.querySelector('.bottom-sheet'),
    scrollContainer: els.voiceOptionsBody,
    onClose: closeVoiceOptionsSheet,
  });
}

// The sheet owns no history: the voice session's history controller does, in
// session/history.js, because the panel's entry and the session's entry have to
// be managed together. This module only reacts to the state it is handed.

/** Show or hide the panel for a history state. */
export function applyVoiceOptionsVisibility(historyState) {
  els.voiceOptionsSheet.hidden = historyState !== VOICE_HISTORY_PANEL;
  if (!els.voiceOptionsSheet.hidden) renderVoiceOptionsSheet();
}

export function openVoiceOptionsSheet() {
  requestVoiceHistoryState(VOICE_HISTORY_PANEL);
}

export function closeVoiceOptionsSheet() {
  requestVoiceHistoryState(VOICE_HISTORY_LIVE);
}

/**
 * Called by the app's popstate router. The controller decides whether the event
 * is one of ours; the panel then follows the resulting state.
 */
export function handleVoiceOptionsPopstate() {
  if (!handleVoiceHistoryPopstate()) return false;
  applyVoiceOptionsVisibility(currentVoiceHistoryState());
  return true;
}

function renderModeOptions() {
  const mode = voiceMode();
  const available = voiceModeAvailable();
  els.voiceModeGroup.replaceChildren(...VOICE_OPTION_ROWS.map(({ mode: value, label }) => {
    const option = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'voiceMode';
    input.value = value;
    input.checked = value === mode;
    input.disabled = !available;
    const text = document.createElement('span');
    text.textContent = label;
    option.append(input, text);
    return option;
  }));
}

export function renderVoiceOptionsSheet() {
  if (!els.voiceOptionsSheet || els.voiceOptionsSheet.hidden) return;
  renderModeOptions();
  els.voiceAutoSpeak.checked = autoSpeak();
  // Speech playback is a separate capability from voice selection: a backend
  // that cannot switch modes can still speak translations automatically.
  els.voiceAutoSpeak.disabled = !state.ttsSettings.enabled;

  const status = visibleVoiceCloningStatus(
    {
      live: state.appMode === 'live_recording',
      voiceMode: voiceMode(),
      voiceCloningStatus: voiceCloningStatus(),
    },
    currentLaneId(),
  );
  els.voiceCloningStatus.hidden = !status;
  els.voiceCloningStatus.textContent = status ? status.text : '';

  const guidance = visibleVoiceCloningGuidance({
    ttsEnabled: true,
    voiceModeAvailable: voiceModeAvailable(),
    voiceMode: voiceMode(),
  });
  els.voiceCloningGuidance.hidden = !guidance;
  els.voiceCloningGuidance.textContent = guidance;
}

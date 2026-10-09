// Voice options bottom sheet: the voice that speaks translations, whether they
// speak automatically, and what the speaker clone is reporting. The behaviour
// comes from session/voice-options.js; this module only renders and routes taps.

import { els } from '../els.js';
import { state } from '../state.js';
import { VOICE_MODE_SPEAKER_CLONE } from '../domain/voice-selection.js';
import { visibleVoiceCloningGuidance, visibleVoiceCloningStatus } from '../domain/cloning-status.js';
import { currentLaneId } from '../domain/lanes.js';
import { setupSheetSwipeClose } from './sheets.js';
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
    setAutoSpeak(els.voiceAutoSpeak.checked);
  });
  setupSheetSwipeClose({
    layer: els.voiceOptionsSheet,
    sheet: els.voiceOptionsSheet.querySelector('.bottom-sheet'),
    scrollContainer: els.voiceOptionsBody,
    onClose: closeVoiceOptionsSheet,
  });
}

// This sheet deliberately owns no history entry. It exists only while a voice
// session runs, so it must not push or pop the page stack: closing it used to
// walk the browser back past the session and land on the setup screen.
export function openVoiceOptionsSheet() {
  els.voiceOptionsSheet.hidden = false;
  renderVoiceOptionsSheet();
}

export function closeVoiceOptionsSheet() {
  els.voiceOptionsSheet.hidden = true;
}

/** Called by the app's popstate router. */
export function handleVoiceOptionsPopstate() {
  if (els.voiceOptionsSheet.hidden) return false;
  // Back closes the panel and stops there, rather than continuing into the
  // session's own history entries.
  els.voiceOptionsSheet.hidden = true;
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
  els.voiceAutoSpeak.disabled = !voiceModeAvailable();

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

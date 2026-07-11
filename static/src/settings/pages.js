// Settings sheet page dispatcher: tracks which subpage is active and
// drives the per-page render hooks. The actual sheet open/close lives
// in ./sheet.js.

import { state } from '../state.js';
import { els } from '../els.js';
import { renderTuningSettings } from './tuning.js';
import { renderTtsSettings } from './tts.js';
import { renderVoiceLibraryPage, voiceLibraryOnExit } from './voice-library.js';
import { renderDevToolsSettings } from './dev-tools.js';
import { renderImageRenderControls } from './image-render.js';

const PAGES = ['microphone', 'audio', 'history', 'dev-tools', 'tuning', 'voice-library', 'image-render'];

export function setSettingsPage(page) {
  const previous = state.settingsPage;
  state.settingsPage = PAGES.includes(page) ? page : 'home';
  if (previous === 'voice-library' && state.settingsPage !== 'voice-library') {
    voiceLibraryOnExit();
  }
  renderSettingsPage();
  if (state.settingsPage === 'dev-tools') renderDevToolsSettings();
  if (state.settingsPage === 'tuning') renderTuningSettings();
  if (state.settingsPage === 'audio') {
    // Reset picker so the dropdown auto-selects the current target
    // language each time you enter — see currentVoxcpm2PickerTag.
    state.ttsVoxcpm2SelectedTag = '';
    renderTtsSettings();
  }
  if (state.settingsPage === 'voice-library') renderVoiceLibraryPage();
  if (state.settingsPage === 'image-render') renderImageRenderControls();
}

export function renderSettingsPage() {
  const page = state.settingsPage;
  const home = page === 'home';
  els.settingsHomePage.hidden = page !== 'home';
  els.settingsMicrophonePage.hidden = page !== 'microphone';
  els.settingsAudioPage.hidden = page !== 'audio';
  els.settingsHistoryPage.hidden = page !== 'history';
  els.settingsDevToolsPage.hidden = page !== 'dev-tools';
  els.settingsTuningPage.hidden = page !== 'tuning';
  els.settingsVoiceLibraryPage.hidden = page !== 'voice-library';
  els.settingsImageRenderPage.hidden = page !== 'image-render';
  els.settingsBackButton.classList.toggle('is-sheet-close', home);
  els.settingsBackButton.classList.toggle('is-subpage-back', !home);
  els.settingsBackButton.setAttribute('aria-label', home ? 'Close settings' : 'Back');
  els.settingsBackButton.title = home ? 'Close settings' : 'Back';
  if (page === 'microphone') {
    els.settingsSheetTitle.textContent = 'Microphone';
  } else if (page === 'audio') {
    els.settingsSheetTitle.textContent = 'Text-to-Speech options';
  } else if (page === 'history') {
    els.settingsSheetTitle.textContent = 'History';
  } else if (page === 'dev-tools') {
    els.settingsSheetTitle.textContent = 'Dev tools';
  } else if (page === 'tuning') {
    els.settingsSheetTitle.textContent = 'ASR tuning';
  } else if (page === 'voice-library') {
    els.settingsSheetTitle.textContent = 'Voice library';
  } else if (page === 'image-render') {
    els.settingsSheetTitle.textContent = 'Image translation';
  } else {
    els.settingsSheetTitle.textContent = 'Settings';
  }
}

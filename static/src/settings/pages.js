// Settings sheet page dispatcher: tracks which subpage is active and
// drives the per-page render hooks. The actual sheet open/close lives
// in ./sheet.js.

import { state } from '../state.js';
import { els } from '../els.js';
import { renderTuningSettings } from './tuning.js';
import { renderTtsSettings } from './tts.js';
import { renderVoiceLibraryPage, voiceLibraryOnExit } from './voice-library.js';
import { renderDevToolsSettings } from './dev-tools.js';

const PAGES = ['microphone', 'audio', 'history', 'dev-tools', 'tuning', 'voice-library'];

export function setSettingsPage(page) {
  const previous = state.settingsPage;
  state.settingsPage = PAGES.includes(page) ? page : 'home';
  if (previous === 'voice-library' && state.settingsPage !== 'voice-library') {
    voiceLibraryOnExit();
  }
  renderSettingsPage();
  if (state.settingsPage === 'dev-tools') renderDevToolsSettings();
  if (state.settingsPage === 'tuning') renderTuningSettings();
  if (state.settingsPage === 'audio') renderTtsSettings();
  if (state.settingsPage === 'voice-library') renderVoiceLibraryPage();
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

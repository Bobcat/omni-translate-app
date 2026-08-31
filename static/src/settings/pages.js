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
import { renderAppearanceSettings } from './appearance.js';
import { renderAccountSettings } from './account.js';
import {
  getInfoCategory,
  renderInfoArticle,
  renderInfoOverview,
} from '../../shared/info/index.js?v=20260831-pdfjs-1';

const PAGES = ['account', 'appearance', 'microphone', 'audio', 'history', 'dev-tools', 'tuning', 'voice-library', 'image-render'];

function infoCategoryForPage(page) {
  if (!page.startsWith('info-')) return null;
  return getInfoCategory(page.slice('info-'.length));
}

function isInfoPage(page) {
  return page === 'info' || Boolean(infoCategoryForPage(page));
}

function resetInfoScroll() {
  const scrollElement = els.settingsInfoPage.closest('.settings-views');
  if (scrollElement) scrollElement.scrollTop = 0;
}

export function setSettingsPage(page) {
  const previous = state.settingsPage;
  state.settingsPage = PAGES.includes(page) || isInfoPage(page) ? page : 'home';
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
  if (state.settingsPage === 'appearance') renderAppearanceSettings();
  if (state.settingsPage === 'account') renderAccountSettings();
  if (state.settingsPage === 'info') {
    renderInfoOverview(els.settingsInfoPage, { showTitle: false });
    resetInfoScroll();
  } else {
    const category = infoCategoryForPage(state.settingsPage);
    if (category) {
      renderInfoArticle(els.settingsInfoPage, category.id, { showTitle: false });
      resetInfoScroll();
    }
  }
}

export function renderSettingsPage() {
  const page = state.settingsPage;
  const root = page === state.settingsRootPage;
  els.settingsHomePage.hidden = page !== 'home';
  els.settingsAccountPage.hidden = page !== 'account';
  els.settingsInfoPage.hidden = !isInfoPage(page);
  els.settingsAppearancePage.hidden = page !== 'appearance';
  els.settingsMicrophonePage.hidden = page !== 'microphone';
  els.settingsAudioPage.hidden = page !== 'audio';
  els.settingsHistoryPage.hidden = page !== 'history';
  els.settingsDevToolsPage.hidden = page !== 'dev-tools';
  els.settingsTuningPage.hidden = page !== 'tuning';
  els.settingsVoiceLibraryPage.hidden = page !== 'voice-library';
  els.settingsImageRenderPage.hidden = page !== 'image-render';
  els.settingsBackButton.classList.toggle('is-sheet-close', root);
  els.settingsBackButton.classList.toggle('is-subpage-back', !root);
  const closeLabel = page === 'home' ? 'Close settings' : `Close ${page}`;
  els.settingsBackButton.setAttribute('aria-label', root ? closeLabel : 'Back');
  els.settingsBackButton.title = root ? 'Close' : 'Back';
  if (page === 'microphone') {
    els.settingsSheetTitle.textContent = 'Microphone';
  } else if (page === 'account') {
    els.settingsSheetTitle.textContent = 'Account';
  } else if (page === 'appearance') {
    els.settingsSheetTitle.textContent = 'Appearance';
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
  } else if (page === 'info') {
    els.settingsSheetTitle.textContent = 'Info & help';
  } else if (infoCategoryForPage(page)) {
    els.settingsSheetTitle.textContent = infoCategoryForPage(page).title;
  } else {
    els.settingsSheetTitle.textContent = 'Settings';
  }
}

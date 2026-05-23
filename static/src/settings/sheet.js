// Settings bottom-sheet: open / close / sub-page navigation, including
// the per-level history stack so that browser-back pops one sub-page at
// a time while scrim-tap / Escape / swipe-down collapses all levels.

import { els } from '../els.js';
import { state } from '../state.js';
import { setSettingsPage } from './pages.js';
import { renderAudioSettings } from './audio.js';
import { renderTuningSettings } from './tuning.js';
import { renderTtsSettings } from './tts.js';
import { renderHistorySettings } from './dev-tools.js';
import { voiceLibraryOnExit } from './voice-library.js';

let _settingsSheetDepth = 0;
// Popstates fired by our own programmatic history.go(-N) inside
// closeSettingsSheet are counted here so we can no-op them; otherwise
// browsers that fire popstate at the intermediate state (instead of
// the final destination) would leave the sheet open at the parent page
// rather than closing entirely.
let _settingsSheetPopstateSkip = 0;
let _settingsSheetPopstateSkipTimer = null;

export function openSettingsSheet() {
  if (!els.settingsSheet.hidden) return;
  els.settingsSheet.hidden = false;
  setSettingsPage('home');
  renderAudioSettings();
  renderTuningSettings();
  renderTtsSettings();
  renderHistorySettings();
  history.pushState({ view: 'settingsSheet', page: 'home' }, '');
  _settingsSheetDepth = 1;
}

export function closeSettingsSheet() {
  // Scrim tap / Escape / swipe-down: pop ALL settings levels at once.
  // Hide synchronously so the swipe-close animation doesn't leave a
  // visible gap while we wait for the popstate burst to drain.
  if (els.settingsSheet.hidden) return;
  // The popstate burst from history.go(-depth) is no-op'd here, so the
  // per-page exit hook in setSettingsPage doesn't fire. Trigger the
  // voice-library cleanup explicitly when closing from that page.
  if (state.settingsPage === 'voice-library') {
    voiceLibraryOnExit();
  }
  if (_settingsSheetDepth > 0) {
    const depth = _settingsSheetDepth;
    _settingsSheetDepth = 0;
    _settingsSheetPopstateSkip = depth;
    if (_settingsSheetPopstateSkipTimer) clearTimeout(_settingsSheetPopstateSkipTimer);
    _settingsSheetPopstateSkipTimer = setTimeout(() => {
      _settingsSheetPopstateSkip = 0;
      _settingsSheetPopstateSkipTimer = null;
    }, 100);
    els.settingsSheet.hidden = true;
    history.go(-depth);
    return;
  }
  els.settingsSheet.hidden = true;
}

export function navigateSettingsPage(page) {
  if (history.state?.view === 'settingsSheet' && history.state.page !== page) {
    history.pushState({ view: 'settingsSheet', page }, '');
    _settingsSheetDepth += 1;
  }
  setSettingsPage(page);
}

export function handleSettingsBack() {
  // On home: button is in "close" mode — collapse the whole sheet at
  // once (pops every settings history entry, regardless of how we got
  // here). On a sub-page: button is "back" — pop one level so popstate
  // can swap the page back.
  if (state.settingsPage === 'home') {
    closeSettingsSheet();
    return;
  }
  if (history.state?.view === 'settingsSheet') {
    history.back();
    return;
  }
  els.settingsSheet.hidden = true;
}

// Called by app.js's popstate handler when the settings sheet is open.
// Returns true if the event was consumed.
export function handleSettingsSheetPopstate(event) {
  if (_settingsSheetPopstateSkip > 0) {
    _settingsSheetPopstateSkip--;
    return true;
  }
  if (els.settingsSheet.hidden) return false;
  const newState = event?.state;
  if (newState?.view === 'settingsSheet' && newState.page) {
    _settingsSheetDepth = Math.max(1, _settingsSheetDepth - 1);
    setSettingsPage(newState.page);
  } else {
    _settingsSheetDepth = 0;
    els.settingsSheet.hidden = true;
  }
  return true;
}

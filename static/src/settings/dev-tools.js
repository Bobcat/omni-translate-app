// Dev-tools settings subpage + PWA install row + history-settings stub.
//
// PWA install: the beforeinstallprompt / appinstalled listeners are
// registered as side-effects when this module is first imported. App.js
// imports this module during its init phase, so the listeners attach
// before the browser would fire the events in practice.

import { state } from '../state.js';
import { els } from '../els.js';
import { clearAppLocalStorage, saveDevToolsSettings } from '../domain/storage.js';
import { renderLifecycle } from '../ui/render-status.js';
import { updateActionButtons } from '../ui/action-buttons.js';

let _installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPrompt = e;
  if (typeof els !== 'undefined') updateInstallRow();
});

window.addEventListener('appinstalled', () => {
  _installPrompt = null;
  if (typeof els !== 'undefined') updateInstallRow();
});

function isIosInstallable() {
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) && !/crios|fxios/i.test(ua);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return isIos && !isStandalone;
}

export function updateInstallRow() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const available = !isStandalone && (_installPrompt !== null || isIosInstallable());
  els.installAppRow.hidden = !available;
  if (isIosInstallable()) {
    els.installAppHint.textContent = 'Share menu, then Add to Home Screen';
  } else {
    els.installAppHint.textContent = 'Experimental, may not work in all browsers';
  }
}

export async function handleInstallApp({ closeSettings } = {}) {
  if (_installPrompt) {
    const { outcome } = await _installPrompt.prompt();
    _installPrompt = null;
    updateInstallRow();
    els.installAppHint.textContent = outcome === 'accepted' ? 'Installing…' : 'Cancelled';
    return;
  }
  if (isIosInstallable()) {
    closeSettings?.();
    return;
  }
  els.installAppHint.textContent = 'Try reloading the page first';
}

export function renderDevToolsSettings() {
  els.devToolsShowControls.checked = state.devToolsSettings.showControls;
}

export function handleDevToolsShowControlsChange() {
  state.devToolsSettings.showControls = els.devToolsShowControls.checked;
  saveDevToolsSettings(state.devToolsSettings);
  renderLifecycle();
  updateActionButtons();
}

export function handleClearAppStorage() {
  if (!window.confirm('Clear saved settings for this app and reload?')) return;
  clearAppLocalStorage();
  window.location.reload();
}

export function renderHistorySettings() {
  els.historySettingsSummary.textContent = 'off';
  els.historySaveSessions.checked = false;
  els.historySaveSessions.disabled = true;
  els.historyRetentionDays.value = '7';
  els.historyRetentionDays.disabled = true;
}

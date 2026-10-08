// Developer mode for the mobile app: the URL parameter is only a switch that
// turns the developer subpages back on, never a secret — everyone who knows the
// name can set it, so the flag hides developer surfaces from ordinary users and
// is not an access boundary. Server-side rules (e.g. the voice-library curation
// capability) stay the enforcement point.
//
// Activation is a one-time visit: `?dev` enables the mode, the choice persists
// in dev-tools storage, and the parameter is stripped from the address bar so a
// shared or bookmarked URL cannot carry it along.

import { state } from '../state.js';
import { loadDevToolsSettings, saveDevToolsSettings } from '../domain/storage.js';

const DEV_PARAM = 'dev';

/** Whether this URL carries the dev switch. */
export function isDevModeEnabled(search = '') {
  const value = new URLSearchParams(search).get(DEV_PARAM);
  if (value === null) return false;
  if (value === '') return true;
  return value !== '0' && value.toLowerCase() !== 'false';
}

function stripDevParam() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(DEV_PARAM);
    const query = url.searchParams.toString();
    window.history.replaceState(window.history.state, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash}`);
  } catch {
    // Address-bar tidiness only; storage already holds the choice.
  }
}

export function isDevMode() {
  return state.devToolsSettings.devMode;
}

export function setDevMode(enabled) {
  state.devToolsSettings.devMode = Boolean(enabled);
  saveDevToolsSettings(state.devToolsSettings);
}

/** Apply the URL switch at start-up: enabling wins, `?dev=0` turns it off. */
export function applyDevModeParam(search = window.location.search) {
  const params = new URLSearchParams(search);
  if (!params.has(DEV_PARAM)) return false;
  setDevMode(isDevModeEnabled(search));
  // Strip the parameter either way: it is a one-visit switch, and a copied URL
  // must not keep re-applying it.
  stripDevParam();
  return true;
}

export function initDevMode() {
  state.devToolsSettings = loadDevToolsSettings();
  applyDevModeParam();
}

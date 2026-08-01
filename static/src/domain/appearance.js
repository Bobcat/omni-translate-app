// Appearance settings: applies the saved theme/palette to <html> as data
// attributes. data-theme is always the *effective* theme — "system" resolves
// via matchMedia here (not in CSS), so dark.css stays a single attribute
// block and the media query only lives in this one place. The inline script
// in static/index.html does the same resolution before first paint; this
// module re-applies on setting changes and tracks OS theme changes while the
// theme axis is on "system".

import {
  DEFAULT_APPEARANCE,
  loadAppearanceSettings,
  saveAppearanceSettings,
} from './storage.js';

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

// Browser-chrome color per effective combo. Keep in sync with the --bg values
// in themes/*.css and with the inline script in static/index.html.
const THEME_COLORS = Object.freeze({
  'light-warm': '#fcfaf5',
  'light-cool': '#f5f7fa',
  'dark-warm': '#161513',
  'dark-cool': '#0e1117',
});

let current = { ...DEFAULT_APPEARANCE };

export function getAppearance() {
  return { ...current };
}

export function effectiveTheme() {
  if (current.theme === 'light' || current.theme === 'dark') return current.theme;
  return darkMedia.matches ? 'dark' : 'light';
}

function apply() {
  const theme = effectiveTheme();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.palette = current.palette;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[`${theme}-${current.palette}`];
}

export function setAppearance(partial) {
  current = { ...current, ...partial };
  saveAppearanceSettings(current);
  apply();
}

export function initAppearance() {
  current = loadAppearanceSettings();
  apply();
  darkMedia.addEventListener('change', () => {
    if (current.theme === 'system') apply();
  });
}

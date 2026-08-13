// Desktop appearance owns the effective theme and foundation preset. The
// saved theme/palette schema is shared with mobile, so switching variants on
// the same browser keeps one consistent choice.

import {
  loadAppearanceSettings,
  saveAppearanceSettings,
} from '../../../src/domain/storage.js';

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

const THEME_COLORS = Object.freeze({
  'light-warm': '#fcfaf5',
  'light-cool': '#f5f7fa',
  'dark-warm': '#161513',
  'dark-cool': '#0e1117',
});

let current = loadAppearanceSettings();
let presetStylesheet = null;

export function getDesktopAppearance() {
  return { ...current };
}

function effectiveTheme() {
  if (current.theme === 'light' || current.theme === 'dark') return current.theme;
  return darkMedia.matches ? 'dark' : 'light';
}

function apply() {
  const theme = effectiveTheme();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.palette = current.palette;
  if (presetStylesheet) {
    const nextHref = theme === 'dark'
      ? presetStylesheet.dataset.darkHref
      : presetStylesheet.dataset.modernHref;
    if (presetStylesheet.getAttribute('href') !== nextHref) {
      presetStylesheet.href = nextHref;
    }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[`${theme}-${current.palette}`];
}

export function setDesktopAppearance(partial) {
  current = { ...current, ...partial };
  saveAppearanceSettings(current);
  apply();
}

export function initDesktopAppearance(stylesheet) {
  presetStylesheet = stylesheet;
  current = loadAppearanceSettings();
  apply();
  darkMedia.addEventListener('change', () => {
    if (current.theme === 'system') apply();
  });
}

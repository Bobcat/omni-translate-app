// Settings-sheet Appearance subpage: the two axes (theme system/light/dark,
// palette warm/cool) as segmented radio controls. Changes apply immediately
// to <html> and persist to localStorage via domain/appearance.js.

import { els } from '../els.js';
import { getAppearance, setAppearance } from '../domain/appearance.js';

const OPTION_LABELS = Object.freeze({
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  warm: 'Warm',
  cool: 'Cool',
});

// Syncs both the subpage controls and the summary on the settings home row.
export function renderAppearanceSettings() {
  const current = getAppearance();
  for (const input of els.settingsAppearancePage.querySelectorAll('input[name="appearanceTheme"]')) {
    input.checked = input.value === current.theme;
  }
  for (const input of els.settingsAppearancePage.querySelectorAll('input[name="appearancePalette"]')) {
    input.checked = input.value === current.palette;
  }
  els.appearanceSettingsSummary.textContent = `${OPTION_LABELS[current.palette]} · ${OPTION_LABELS[current.theme]}`;
}

export function bindAppearanceSettings() {
  els.settingsAppearancePage.addEventListener('change', (event) => {
    const input = event.target;
    if (input.name === 'appearanceTheme') setAppearance({ theme: input.value });
    else if (input.name === 'appearancePalette') setAppearance({ palette: input.value });
    else return;
    renderAppearanceSettings();
  });
}

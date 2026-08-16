// Desktop settings. Appearance is live and local; microphone and speech stay
// as the existing UI-only previews until their backend wiring is requested.

import {
  getDesktopAppearance,
  setDesktopAppearance,
} from '../../shared/appearance.js';

function renderAppearance(container) {
  const current = getDesktopAppearance();
  for (const input of container.querySelectorAll('input[name="desktopAppearanceTheme"]')) {
    input.checked = input.value === current.theme;
  }
  for (const input of container.querySelectorAll('input[name="desktopAppearancePalette"]')) {
    input.checked = input.value === current.palette;
  }
}

export function createSettingsView() {
  const container = document.createElement('div');
  container.className = 'view settings-view';
  container.innerHTML = `
    <section class="settings-group appearance-settings" aria-labelledby="appearanceSettingsTitle">
      <h3 id="appearanceSettingsTitle">Appearance</h3>
      <div class="appearance-setting">
        <span class="appearance-setting-label">Theme</span>
        <div class="appearance-segmented" role="radiogroup" aria-label="Theme">
          <label><input type="radio" name="desktopAppearanceTheme" value="system"><span>System</span></label>
          <label><input type="radio" name="desktopAppearanceTheme" value="light"><span>Light</span></label>
          <label><input type="radio" name="desktopAppearanceTheme" value="dark"><span>Dark</span></label>
        </div>
      </div>
      <div class="appearance-setting">
        <span class="appearance-setting-label">Palette</span>
        <div class="appearance-segmented" role="radiogroup" aria-label="Palette">
          <label><input type="radio" name="desktopAppearancePalette" value="warm"><span>Warm</span></label>
          <label><input type="radio" name="desktopAppearancePalette" value="cool"><span>Cool</span></label>
        </div>
      </div>
    </section>
    <section class="settings-group" aria-label="Microphone">
      <h3>Microphone</h3>
      <label class="setting-row">
        <span>Amplification</span>
        <input type="range" min="0.5" max="3" step="0.1" value="1.5" disabled>
      </label>
      <label class="setting-row">
        <span>Stop after silence</span>
        <select disabled>
          <option>3 sec</option>
          <option>5 sec</option>
          <option>10 sec</option>
          <option>15 sec</option>
          <option>30 sec</option>
          <option>Off</option>
        </select>
      </label>
    </section>
    <section class="settings-group" aria-label="Speech">
      <h3>Speech</h3>
      <label class="setting-row">
        <span>Engine</span>
        <select disabled>
          <option>Kokoro</option>
          <option>VoxCPM2</option>
          <option>NanoVLLM VoxCPM</option>
        </select>
      </label>
    </section>
    <p class="preview-note">Microphone and speech settings are UI previews and are not wired yet.</p>
  `;
  renderAppearance(container);
  container.addEventListener('change', (event) => {
    const input = event.target;
    if (input.name === 'desktopAppearanceTheme') {
      setDesktopAppearance({ theme: input.value });
    } else if (input.name === 'desktopAppearancePalette') {
      setDesktopAppearance({ palette: input.value });
    } else {
      return;
    }
    renderAppearance(container);
  });
  return container;
}

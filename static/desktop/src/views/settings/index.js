// Settings view — UI shell only. Lean user-facing groups (microphone, speech)
// with placeholder controls; wiring and the real option set come later.

export function createSettingsView() {
  const container = document.createElement('div');
  container.className = 'view settings-view';
  container.innerHTML = `
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
    <p class="preview-note">UI preview — not wired to the backend yet.</p>
  `;
  return container;
}

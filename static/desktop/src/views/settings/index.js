// Desktop settings. Only controls that change live app behaviour belong here.

import {
  getDesktopAppearance,
  setDesktopAppearance,
} from '../../shared/appearance.js';
import {
  getDesktopMicrophoneState,
  resetDesktopMicrophoneSettings,
  setDesktopMicrophoneSettings,
  subscribeDesktopMicrophoneState,
} from '../../shared/microphone-settings.js';
import { AUTO_OFF_SILENCE_CHOICES } from '../../../../src/shared/constants.js';

function renderAppearance(container) {
  const current = getDesktopAppearance();
  for (const input of container.querySelectorAll('input[name="desktopAppearanceTheme"]')) {
    input.checked = input.value === current.theme;
  }
  for (const input of container.querySelectorAll('input[name="desktopAppearancePalette"]')) {
    input.checked = input.value === current.palette;
  }
}

function renderMicrophoneLevel(container, current = getDesktopMicrophoneState()) {
  const level = current.listening ? current.inputLevel : 0;
  const percent = Math.round(level * 100);
  const meter = container.querySelector('#desktopMicLevel');
  const fill = container.querySelector('#desktopMicLevelFill');
  meter.setAttribute('aria-valuenow', String(percent));
  meter.classList.toggle('is-hot', level >= 0.9);
  fill.style.transform = `scaleX(${level.toFixed(3)})`;
  let status = 'Not recording.';
  if (current.captureBusy) status = current.listening ? 'Updating microphone…' : 'Starting microphone…';
  else if (current.listening) status = 'Live input.';
  container.querySelector('#desktopMicLevelStatus').textContent = status;
}

function renderMicrophone(container) {
  const current = getDesktopMicrophoneState();
  container.querySelector('#desktopMicPreGain').value = String(current.preGain);
  container.querySelector('#desktopMicPreGainValue').textContent = `${current.preGain.toFixed(1)}x`;
  const autoGain = container.querySelector('#desktopMicAutoGainControl');
  autoGain.checked = current.autoGainControl;
  autoGain.disabled = current.captureBusy;
  container.querySelector('#desktopMicAutoOffSilence').value = String(current.autoOffSilenceSeconds);
  container.querySelector('#desktopMicAutoOffAfterBubble').checked = current.autoOffAfterBubble;
  container.querySelector('#desktopMicAutoOffCue').checked = current.autoOffCueEnabled;
  const recordingButton = container.querySelector('#desktopMicRecording');
  recordingButton.disabled = current.captureBusy;
  if (current.captureBusy) {
    recordingButton.textContent = current.listening ? 'Updating microphone…' : 'Starting…';
  } else {
    recordingButton.textContent = current.listening ? 'Stop recording' : 'Start recording';
  }
  container.querySelector('#desktopMicReset').disabled = current.captureBusy;
  renderMicrophoneLevel(container, current);
}

export function createSettingsView({ onToggleRecording } = {}) {
  if (typeof onToggleRecording !== 'function') {
    throw new Error('Desktop settings require a microphone recording action');
  }
  const container = document.createElement('div');
  container.className = 'view settings-view desktop-settings-view';
  const silenceOptions = AUTO_OFF_SILENCE_CHOICES.map((seconds) => `
    <option value="${seconds}">${seconds === 0 ? 'Off' : `${seconds} sec`}</option>
  `).join('');
  container.innerHTML = `
    <h1 class="visually-hidden">Settings</h1>
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
    <section class="desktop-microphone-settings" aria-labelledby="microphoneSettingsTitle">
      <h3 id="microphoneSettingsTitle">Microphone</h3>
      <div class="microphone-setting-group" role="group" aria-label="Microphone">
        <div class="microphone-setting-title-row">
          <span>Amplification</span>
          <output class="microphone-setting-value" id="desktopMicPreGainValue" for="desktopMicPreGain">1.5x</output>
        </div>
        <label class="microphone-range-row" for="desktopMicPreGain">
          <input id="desktopMicPreGain" type="range" min="0.5" max="3" step="0.1" aria-label="Amplification">
        </label>
        <div class="microphone-setting-title-row">
          <span>Input level</span>
        </div>
        <div class="settings-mic-meter" id="desktopMicLevel" role="meter" aria-label="Microphone input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <span class="settings-mic-meter-fill" id="desktopMicLevelFill"></span>
          <span class="settings-mic-meter-threshold" aria-hidden="true"></span>
        </div>
        <label class="microphone-toggle-row" for="desktopMicAutoGainControl">
          <span>Auto gain control</span>
          <span class="microphone-switch">
            <input id="desktopMicAutoGainControl" type="checkbox" role="switch">
            <span class="microphone-switch-track" aria-hidden="true"></span>
            <span class="microphone-switch-thumb" aria-hidden="true"></span>
          </span>
        </label>
        <button class="microphone-link-button" id="desktopMicRecording" type="button">Start recording</button>
        <small class="visually-hidden" id="desktopMicLevelStatus" aria-live="polite"></small>
      </div>
      <div class="microphone-setting-group" role="group" aria-label="Auto-off">
        <div class="microphone-setting-title-row">
          <span>Auto-off</span>
        </div>
        <label class="microphone-select-row" for="desktopMicAutoOffSilence">
          <span>Stop after silence</span>
          <select id="desktopMicAutoOffSilence">${silenceOptions}</select>
        </label>
        <label class="microphone-toggle-row" for="desktopMicAutoOffAfterBubble">
          <span>Stop after each bubble</span>
          <span class="microphone-switch">
            <input id="desktopMicAutoOffAfterBubble" type="checkbox" role="switch">
            <span class="microphone-switch-track" aria-hidden="true"></span>
            <span class="microphone-switch-thumb" aria-hidden="true"></span>
          </span>
        </label>
        <label class="microphone-toggle-row" for="desktopMicAutoOffCue">
          <span>Beep on mic events</span>
          <span class="microphone-switch">
            <input id="desktopMicAutoOffCue" type="checkbox" role="switch">
            <span class="microphone-switch-track" aria-hidden="true"></span>
            <span class="microphone-switch-thumb" aria-hidden="true"></span>
          </span>
        </label>
      </div>
      <div class="microphone-setting-group">
        <button class="microphone-link-button" id="desktopMicReset" type="button">Reset to defaults</button>
      </div>
    </section>
  `;
  renderAppearance(container);
  renderMicrophone(container);
  container.addEventListener('input', (event) => {
    if (event.target.id !== 'desktopMicPreGain') return;
    setDesktopMicrophoneSettings({ preGain: event.target.value });
  });
  container.addEventListener('change', (event) => {
    const input = event.target;
    if (input.name === 'desktopAppearanceTheme') {
      setDesktopAppearance({ theme: input.value });
    } else if (input.name === 'desktopAppearancePalette') {
      setDesktopAppearance({ palette: input.value });
    } else if (input.id === 'desktopMicAutoGainControl') {
      setDesktopMicrophoneSettings({ autoGainControl: input.checked });
    } else if (input.id === 'desktopMicAutoOffSilence') {
      setDesktopMicrophoneSettings({ autoOffSilenceSeconds: input.value });
    } else if (input.id === 'desktopMicAutoOffAfterBubble') {
      setDesktopMicrophoneSettings({ autoOffAfterBubble: input.checked });
    } else if (input.id === 'desktopMicAutoOffCue') {
      setDesktopMicrophoneSettings({ autoOffCueEnabled: input.checked });
    } else {
      return;
    }
    renderAppearance(container);
  });
  container.querySelector('#desktopMicReset').addEventListener('click', () => {
    resetDesktopMicrophoneSettings();
  });
  container.querySelector('#desktopMicRecording').addEventListener('click', () => {
    onToggleRecording();
  });
  let unsubscribe = null;
  container.__onActivate = () => {
    renderMicrophone(container);
    if (unsubscribe) return;
    unsubscribe = subscribeDesktopMicrophoneState(({ changed }) => {
      const meterOnly = [...changed].every((key) => key === 'inputLevel' || key === 'listening');
      if (meterOnly) renderMicrophoneLevel(container);
      else renderMicrophone(container);
    });
  };
  container.__onDeactivate = () => {
    unsubscribe?.();
    unsubscribe = null;
  };
  return container;
}

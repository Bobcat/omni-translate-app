// Status-line UI: the app-shell render (running/setup/mic class toggles,
// per-element visibility), connection status, language-pill render, mic
// level meter + halo, and the start-button busy flag.

import { state } from '../state.js';
import { els } from '../els.js';
import { SESSION_STATES, MIC_STATES } from '../shared/constants.js';
import { currentLane } from '../domain/lanes.js';
import { updateActionButtons } from './action-buttons.js';

export function setStatus(status) {
  state.status = String(status || 'idle').toLowerCase();
  renderLifecycle();
  updateActionButtons();
}

export function renderLifecycle() {
  const setup = state.sessionState === SESSION_STATES.SETUP;
  const running = state.sessionState === SESSION_STATES.RUNNING;
  const micOff = running && state.micState === MIC_STATES.OFF;
  const micListening = running && state.micState === MIC_STATES.LISTENING;
  els.app.classList.toggle('is-setup', setup);
  els.app.classList.toggle('is-running', running);
  els.app.classList.toggle('is-mic-off', micOff);
  els.app.classList.toggle('is-mic-listening', micListening);
  els.setupStartPanel.hidden = !setup;
  els.sourceText.hidden = setup;
  els.setupSwapButton.hidden = !setup;
  els.translateNowButton.hidden = !running;
  els.speakNowButton.hidden = !running;
  els.micToggleButton.hidden = !running;
  els.pcExportButton.hidden = !(running && micOff && state.devToolsSettings.showPcExport);
  els.startButton.disabled = state.status === 'connecting';
  els.settingsStartButton.disabled = state.status === 'connecting';
  els.settingsStartButton.textContent = (running && micListening) ? 'Stop recording' : 'Start recording';
  els.setupSwapButton.disabled = !setup || state.status === 'connecting';
  els.turnModeButton?.classList.toggle('is-active', state.viewMode === 'turn');
  els.turnModeButton?.setAttribute('aria-pressed', state.viewMode === 'turn' ? 'true' : 'false');
  els.conversationModeButton?.classList.toggle('is-active', state.viewMode === 'conversation');
  els.conversationModeButton?.setAttribute('aria-pressed', state.viewMode === 'conversation' ? 'true' : 'false');
  renderLanguageControls();
}

export function setListenBusy(busy) {
  els.startButton.disabled = Boolean(busy);
  els.settingsStartButton.disabled = Boolean(busy);
}

export function renderLanguageControls() {
  const lane = currentLane();
  const setup = state.sessionState === SESSION_STATES.SETUP;
  const isConnecting = state.status === 'connecting';
  els.sourceLanguagePillText.textContent = lane.sourceLanguage;
  els.targetLanguagePillText.textContent = lane.targetLanguage;
  els.sourceLanguagePill.hidden = !setup;
  els.targetLanguagePill.hidden = !setup;
  els.sourceLanguagePill.disabled = isConnecting;
  els.targetLanguagePill.disabled = isConnecting;
  els.sourceLanguagePill.setAttribute('aria-label', `Source language: ${lane.sourceLanguage}`);
  els.targetLanguagePill.setAttribute('aria-label', `Target language: ${lane.targetLanguage}`);
}

export function renderMicLevel(value) {
  const level = normalizeLevel(value);
  state.audioSettings.inputLevel = level;
  const percent = Math.round(level * 100);
  els.micLevelFill.style.transform = `scaleX(${level.toFixed(3)})`;
  els.micLevel.setAttribute('aria-valuenow', String(percent));
  els.micLevel.classList.toggle('is-hot', level >= 0.9);
  // Baseline halo when listening (always-visible mic-ready indicator); audio
  // level adds on top so any sound is reflected even at quiet levels.
  const BASELINE_HALO = 0.4;
  const haloLevel = state.micState === MIC_STATES.LISTENING
    ? Math.min(1, BASELINE_HALO + (1 - BASELINE_HALO) * levelToHaloUnit(level))
    : 0;
  const clipRisk = state.micState === MIC_STATES.LISTENING && level >= 0.95;
  const hot = level >= 0.85;
  els.micToggleButton.classList.toggle('is-clip-risk', clipRisk);
  const r = clipRisk ? 185 : hot ? 245 : 59;
  const g = clipRisk ? 28 : hot ? 158 : 130;
  const b = clipRisk ? 28 : hot ? 11 : 246;
  const alpha = haloLevel ? 0.08 + haloLevel * (clipRisk ? 0.42 : hot ? 0.36 : 0.3) : 0;
  const scale = 1 + haloLevel * 0.55;
  els.micToggleButton.style.setProperty('--mic-toggle-halo-scale', scale.toFixed(3));
  els.micToggleButton.style.setProperty(
    '--mic-toggle-halo-color',
    haloLevel ? `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})` : 'transparent',
  );
  els.micToggleButton.style.boxShadow = '';
}

function levelToHaloUnit(level) {
  // Visual-only gain so the halo stays responsive on devices that hand back
  // very low raw peaks (older iPhones, web audio with internal AGC).
  const visual = Math.min(1, level * 8);
  if (visual <= 0) return 0;
  // dB mapping (-50 dB → 0, 0 dB → 1) spreads quiet→loud across the range.
  const db = 20 * Math.log10(visual);
  return Math.max(0, Math.min(1, (db + 50) / 50));
}

function normalizeLevel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

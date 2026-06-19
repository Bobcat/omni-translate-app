// ASR tuning settings subpage. The TUNING_CONTROLS table drives both the
// rendered rows and the input parsing — adding a new knob means adding a
// row here, no other file needs to change.

import { state } from '../state.js';
import { els } from '../els.js';
import { APP_MODES, MIC_STATES } from '../shared/constants.js';

const TUNING_CONTROLS = [
  { group: 'Backend selection', key: 'asr.backend', label: 'Backend', type: 'select', options: [['whisperx', 'WhisperX'], ['faster_whisper_direct', 'Faster Whisper']] },
  { group: 'Commit timing', key: 'rolling.single_segment_commit_min_ms', label: 'Single segment commit', type: 'number', min: 1, max: 120000, step: 100, unit: 'ms' },
  { group: 'Commit timing', key: 'rolling.speech_gate.silence_enter_ms', label: 'Silence enter', type: 'number', min: 100, max: 60000, step: 50, unit: 'ms' },
  { group: 'Commit timing', key: 'rolling.speech_gate.force_commit_silence_ms', label: 'Force commit silence', type: 'number', min: 100, max: 60000, step: 50, unit: 'ms' },
  { group: 'ASR dispatch cadence', key: 'rolling.min_infer_audio_ms', label: 'Min infer audio', type: 'number', min: 1, max: 60000, step: 50, unit: 'ms' },
  { group: 'ASR dispatch cadence', key: 'rolling.min_new_audio_ms', label: 'Min new audio', type: 'number', min: 0, max: 60000, step: 50, unit: 'ms' },
  { group: 'ASR dispatch cadence', key: 'rolling.pacing.base_emit_ms', label: 'Base pacing interval', type: 'number', min: 1, max: 60000, step: 10, unit: 'ms' },
  { group: 'Startup cadence', key: 'rolling.pacing.startup.duration_ms', label: 'Initial phase length', type: 'number', min: 0, max: 60000, step: 50, unit: 'ms' },
  { group: 'Startup cadence', key: 'rolling.pacing.startup.emit_ms', label: 'Initial emit interval', type: 'number', min: 1, max: 60000, step: 10, unit: 'ms' },
  { group: 'Startup cadence', key: 'rolling.pacing.startup.min_infer_audio_ms', label: 'Initial min infer audio', type: 'number', min: 0, max: 60000, step: 50, unit: 'ms' },
  { group: 'Startup cadence', key: 'rolling.pacing.startup.min_new_audio_ms', label: 'Initial min new audio', type: 'number', min: 0, max: 60000, step: 50, unit: 'ms' },
];

export function handleTuningSettingChange(event) {
  const input = event.target;
  const key = input?.dataset?.tuningKey;
  if (!key) return;
  const control = TUNING_CONTROLS.find((item) => item.key === key);
  if (!control || input.disabled) return;
  const value = tuningInputValue(control, input);
  setTuningValue(key, value);
  renderTuningSettings({ preserveScroll: true });
  if (state.appMode === APP_MODES.LIVE_RECORDING && state.socket?.isOpen()) {
    state.socket.updateLiveSettings(deltaForTuningPath(key, value));
  }
}

function toggleTuningGroup(groupName) {
  if (!groupName) return;
  if (state.tuningExpandedGroups.has(groupName)) {
    state.tuningExpandedGroups.delete(groupName);
  } else {
    state.tuningExpandedGroups.add(groupName);
  }
  renderTuningSettings({ preserveScroll: true });
}

export function renderTuningSettings({ preserveScroll = false } = {}) {
  if (!els.tuningSettingsGroups) return;
  if (els.settingsSheet.hidden) return;
  const scrollEl = preserveScroll ? tuningScrollElement() : null;
  const scrollTop = scrollEl?.scrollTop || 0;
  const groups = new Map();
  for (const control of TUNING_CONTROLS) {
    if (!groups.has(control.group)) groups.set(control.group, []);
    groups.get(control.group).push(control);
  }
  const fragment = document.createDocumentFragment();
  for (const [groupName, controls] of groups.entries()) {
    const expanded = state.tuningExpandedGroups.has(groupName);
    const section = document.createElement('section');
    section.className = 'setting-group tuning-group';
    section.setAttribute('aria-label', groupName);
    section.dataset.tuningGroup = groupName;
    section.classList.toggle('is-expanded', expanded);
    const title = document.createElement('button');
    title.className = 'tuning-group-toggle';
    title.type = 'button';
    title.dataset.tuningGroup = groupName;
    title.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    title.addEventListener('click', () => toggleTuningGroup(groupName));
    const titleText = document.createElement('span');
    titleText.className = 'tuning-group-title';
    titleText.textContent = groupName;
    const icon = document.createElement('span');
    icon.className = 'tuning-group-icon';
    icon.setAttribute('aria-hidden', 'true');
    title.append(titleText, icon);
    const body = document.createElement('div');
    body.className = 'tuning-group-body';
    body.hidden = !expanded;
    if (expanded) {
      for (const control of controls) {
        body.append(createTuningRow(control));
      }
    }
    section.append(title, body);
    fragment.append(section);
  }
  els.tuningSettingsGroups.replaceChildren(fragment);
  if (scrollEl) scrollEl.scrollTop = scrollTop;
}

function tuningScrollElement() {
  return els.settingsSheet?.querySelector('.settings-views') || null;
}

function createTuningRow(control) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const label = document.createElement('span');
  label.className = 'tuning-label';
  label.textContent = control.label;
  const meta = document.createElement('span');
  meta.className = 'tuning-meta';
  meta.textContent = tuningControlMeta(control);
  const input = createTuningInput(control);
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(input);
  if (control.unit) {
    const unit = document.createElement('span');
    unit.className = 'tuning-unit';
    unit.textContent = control.unit;
    valueWrap.append(unit);
  }
  row.append(label, meta, valueWrap);
  return row;
}

function createTuningInput(control) {
  const disabled = tuningControlDisabled(control);
  const value = getTuningValue(control.key);
  if (control.type === 'select' || control.type === 'nullableBool') {
    const select = document.createElement('select');
    select.dataset.tuningKey = control.key;
    select.disabled = disabled;
    const options = control.type === 'nullableBool'
      ? [['', 'default'], ['true', 'on'], ['false', 'off']]
      : control.options;
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionLabel;
      select.append(option);
    }
    select.value = control.type === 'nullableBool' ? nullableBoolSelectValue(value) : String(value ?? '');
    return select;
  }
  if (control.type === 'checkbox') {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('role', 'switch');
    checkbox.dataset.tuningKey = control.key;
    checkbox.checked = Boolean(value);
    checkbox.disabled = disabled;
    const wrap = document.createElement('span');
    wrap.className = 'switch';
    const track = document.createElement('span');
    track.className = 'switch-track';
    track.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('span');
    thumb.className = 'switch-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    wrap.append(checkbox, track, thumb);
    return wrap;
  }
  const input = document.createElement('input');
  input.dataset.tuningKey = control.key;
  input.type = control.type === 'text' ? 'text' : 'number';
  if (control.min !== undefined) input.min = String(control.min);
  if (control.max !== undefined) input.max = String(control.max);
  if (control.step !== undefined) input.step = String(control.step);
  input.value = value === null || value === undefined ? '' : String(value);
  input.disabled = disabled;
  return input;
}

function tuningInputValue(control, input) {
  if (control.type === 'checkbox') return Boolean(input.checked);
  if (control.type === 'nullableBool') {
    if (input.value === '') return null;
    return input.value === 'true';
  }
  if (control.type === 'number') {
    if (input.value === '') return control.nullable ? null : getTuningValue(control.key);
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return getTuningValue(control.key);
    if (Number.isInteger(Number(control.step || 1))) return Math.round(raw);
    return raw;
  }
  const text = String(input.value || '').trim();
  return text || (control.nullable ? null : '');
}

function tuningControlDisabled(control) {
  if (control.lock === 'disabled') return true;
  if (control.lock === 'micOff' && state.appMode === APP_MODES.LIVE_RECORDING && state.micState === MIC_STATES.LISTENING) return true;
  if (control.backend && getTuningValue('asr.backend') !== control.backend) return true;
  return false;
}

function tuningControlMeta(control) {
  if (control.lock === 'disabled') return 'later';
  if (control.backend && getTuningValue('asr.backend') !== control.backend) return 'inactive';
  if (control.lock === 'micOff' && state.appMode === APP_MODES.LIVE_RECORDING && state.micState === MIC_STATES.LISTENING) return 'mic off';
  return 'live';
}

function nullableBoolSelectValue(value) {
  if (value === null || value === undefined) return '';
  return value ? 'true' : 'false';
}

function getTuningValue(path) {
  let cur = state.tuningSettings;
  for (const part of String(path).split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setTuningValue(path, value) {
  const parts = String(path).split('.');
  let cur = state.tuningSettings;
  for (const part of parts.slice(0, -1)) {
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function deltaForTuningPath(path, value) {
  const parts = String(path).split('.');
  const root = {};
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

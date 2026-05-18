// TTS settings: config load/persist/sync, change handlers, render of the
// TTS Options settings subpage. Voice library page stays in app.js for
// the moment but imports a handful of helpers from here.

import { api } from '../api-client.js';
import { state } from '../state.js';
import { els } from '../els.js';
import {
  languages,
  bcp47ForLanguageName,
  languageNameForBcp47,
  normalizeLanguageName,
} from '../shared/languages.js';
import { DEFAULT_TTS_SETTINGS, DEFAULT_TTS_OPTIONS } from '../shared/constants.js';
import { cloneSettings, mergeSettings } from '../shared/utils.js';
import { loadTtsGlobalConfig, persistTtsGlobalConfig } from '../shared/storage.js';
import { currentLane } from '../shared/lanes.js';

export const VOXCPM2_DEFAULT_LANGUAGE_CONFIG = {
  mode: 'reference_audio',
  reference_source: 'stable_generated',
  stable_gender: 'female',
};
export const VOXCPM2_DEFAULT_TRIM_SECONDS = 4;
const VOXCPM2_VOICE_CONFIG_STORAGE_KEY = 'voxcpm2_voice_config';
const VOXCPM2_GENDER_CLAUSES = {
  female: 'Use a natural adult female voice.',
  male: 'Use a natural adult male voice.',
};
const VOXCPM2_STYLE_CLAUSES = {
  neutral: 'Use a neutral, natural speaking style.',
  warm: 'Use a warm, natural speaking style.',
  calm: 'Use a calm, measured speaking style.',
  clear: 'Use a clear, articulate speaking style.',
};

function tuningScrollElement() {
  return els.settingsSheet?.querySelector('.settings-views') || null;
}

export function applyTtsConfig(tts) {
  const settings = cloneSettings(tts || {});
  const options = cloneSettings(settings.options || {});
  delete settings.options;
  state.ttsSettings = mergeSettings(DEFAULT_TTS_SETTINGS, settings);
  state.ttsOptions = mergeSettings(DEFAULT_TTS_OPTIONS, options);
  renderTtsSettings();
}

export function mergeStoredTtsConfigIntoState() {
  // localStorage-merge runs once at init only. Re-running it after every
  // submit would overwrite in-session mode/reference_source changes back to
  // defaults (those fields are intentionally not persisted).
  const stored = loadVoxcpm2VoiceConfig();
  if (Object.keys(stored).length) {
    state.ttsSettings.voxcpm2.languages = stored;
  }
  const ttsGlobal = loadTtsGlobalConfig();
  if (ttsGlobal) {
    if (typeof ttsGlobal.enabled === 'boolean') state.ttsSettings.enabled = ttsGlobal.enabled;
    if (ttsGlobal.backend) state.ttsSettings.backend = ttsGlobal.backend;
    if (ttsGlobal.kokoro_voices) {
      state.ttsSettings.kokoro = state.ttsSettings.kokoro || { voices: {} };
      state.ttsSettings.kokoro.voices = {
        ...(state.ttsSettings.kokoro.voices || {}),
        ...ttsGlobal.kokoro_voices,
      };
    }
  }
  renderTtsSettings();
}

function loadVoxcpm2VoiceConfig() {
  try {
    const raw = localStorage.getItem(VOXCPM2_VOICE_CONFIG_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const normalized = {};
    for (const [tag, entry] of Object.entries(parsed)) {
      const cleanTag = String(tag || '').trim().toLowerCase();
      if (!cleanTag) continue;
      const cleanEntry = normalizeVoxcpm2LanguageEntry(entry);
      if (cleanEntry) normalized[cleanTag] = cleanEntry;
    }
    return normalized;
  } catch (_) {
    return {};
  }
}

function persistVoxcpm2VoiceConfig() {
  try {
    const stripped = {};
    const languages = state.ttsSettings.voxcpm2.languages || {};
    for (const [tag, entry] of Object.entries(languages)) {
      if (!entry || typeof entry !== 'object') continue;
      const out = {};
      // Persist only the fields we keep across reloads. mode and reference_source
      // are intentionally omitted — they always reset to defaults on hard refresh.
      if (entry.gender !== undefined) out.gender = entry.gender;
      if (entry.style !== undefined) out.style = entry.style;
      if (entry.stable_gender !== undefined) out.stable_gender = entry.stable_gender;
      if (entry.trim_seconds !== undefined) out.trim_seconds = entry.trim_seconds;
      if (Object.keys(out).length) stripped[tag] = out;
    }
    localStorage.setItem(VOXCPM2_VOICE_CONFIG_STORAGE_KEY, JSON.stringify(stripped));
  } catch (_) {
    // ignore quota / disabled storage
  }
}

function normalizeVoxcpm2LanguageEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // Mode and reference_source are not persisted: always restored from defaults.
  const out = { ...VOXCPM2_DEFAULT_LANGUAGE_CONFIG };
  const allowedGenders = new Set(['female', 'male']);
  const allowedStyles = new Set(['neutral', 'warm', 'calm', 'clear']);
  if (allowedGenders.has(entry.gender)) out.gender = entry.gender;
  if (allowedStyles.has(entry.style)) out.style = entry.style;
  if (allowedGenders.has(entry.stable_gender)) out.stable_gender = entry.stable_gender;
  const trimRaw = Number(entry.trim_seconds);
  if (Number.isFinite(trimRaw)) {
    out.trim_seconds = Math.min(60, Math.max(1, trimRaw));
  }
  return out;
}

export function handleTtsEnabledChange() {
  const previous = cloneSettings(state.ttsSettings);
  const enabled = Boolean(els.ttsEnabled.checked);
  state.ttsSettings.enabled = enabled;
  persistTtsGlobalConfig(state.ttsSettings);
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings({ enabled }, previous);
}

export function handleTtsBackendChange() {
  const previous = cloneSettings(state.ttsSettings);
  const backend = String(els.ttsBackendSelect.value || '');
  if (!backend) return;
  state.ttsSettings.backend = backend;
  persistTtsGlobalConfig(state.ttsSettings);
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings({ backend }, previous);
}

export function handleTtsSettingChange(event) {
  const input = event.target;
  if (!input || input.disabled) return;
  const previous = cloneSettings(state.ttsSettings);
  const kind = input.dataset.ttsKind || '';
  const language = input.dataset.ttsLanguage || '';
  if (kind === 'kokoro-voice' && language) {
    const value = String(input.value || '');
    state.ttsSettings.kokoro.voices[language] = value;
    persistTtsGlobalConfig(state.ttsSettings);
    renderTtsSettings({ preserveScroll: true });
    submitTtsSettings({ kokoro: { voices: { [language]: value } } }, previous);
    return;
  }
  if (kind === 'voxcpm2-picker-language') {
    state.ttsVoxcpm2SelectedTag = String(input.value || '').toLowerCase();
    renderTtsSettings({ preserveScroll: true });
    return;
  }
  const tag = String(language || '').toLowerCase();
  if (!tag) return;
  if (kind === 'voxcpm2-mode') {
    const nextMode = input.value === 'reference_audio' ? 'reference_audio' : 'description';
    updateVoxcpm2LanguageConfig(tag, (current) => {
      if (nextMode === 'description') {
        return {
          mode: 'description',
          gender: current.gender || 'female',
          style: current.style || 'neutral',
        };
      }
      return {
        mode: 'reference_audio',
        reference_source: 'stable_generated',
        stable_gender: current.stable_gender || 'female',
        trim_seconds: Number.isFinite(Number(current.trim_seconds))
          ? Number(current.trim_seconds)
          : VOXCPM2_DEFAULT_TRIM_SECONDS,
      };
    }, previous);
    return;
  }
  if (kind === 'voxcpm2-gender') {
    const allowed = new Set(['female', 'male']);
    const value = allowed.has(input.value) ? input.value : 'female';
    updateVoxcpm2LanguageConfig(tag, (current) => ({
      mode: 'description',
      gender: value,
      style: current.style || 'neutral',
    }), previous);
    return;
  }
  if (kind === 'voxcpm2-style') {
    const allowed = new Set(['neutral', 'warm', 'calm', 'clear']);
    const value = allowed.has(input.value) ? input.value : 'neutral';
    updateVoxcpm2LanguageConfig(tag, (current) => ({
      mode: 'description',
      gender: current.gender || 'female',
      style: value,
    }), previous);
    return;
  }
  if (kind === 'voxcpm2-reference-source') {
    const allowed = new Set(['last_speech', 'stable_generated']);
    const value = allowed.has(input.value) ? input.value : 'last_speech';
    updateVoxcpm2LanguageConfig(tag, (current) => {
      const next = {
        mode: 'reference_audio',
        reference_source: value,
        trim_seconds: Number.isFinite(Number(current.trim_seconds))
          ? Number(current.trim_seconds)
          : VOXCPM2_DEFAULT_TRIM_SECONDS,
      };
      if (value === 'stable_generated') {
        next.stable_gender = current.stable_gender || 'female';
      }
      return next;
    }, previous);
    return;
  }
  if (kind === 'voxcpm2-stable-gender') {
    const allowed = new Set(['female', 'male']);
    const value = allowed.has(input.value) ? input.value : 'female';
    updateVoxcpm2LanguageConfig(tag, (current) => ({
      mode: 'reference_audio',
      reference_source: 'stable_generated',
      trim_seconds: Number.isFinite(Number(current.trim_seconds))
        ? Number(current.trim_seconds)
        : VOXCPM2_DEFAULT_TRIM_SECONDS,
      stable_gender: value,
    }), previous);
    return;
  }
  if (kind === 'voxcpm2-trim-seconds') {
    const value = normalizeTtsNumber(input.value, VOXCPM2_DEFAULT_TRIM_SECONDS, 1, 60);
    updateVoxcpm2LanguageConfig(tag, (current) => {
      const allowed = new Set(['last_speech', 'stable_generated']);
      const source = allowed.has(current.reference_source) ? current.reference_source : 'last_speech';
      const next = { mode: 'reference_audio', reference_source: source, trim_seconds: value };
      if (source === 'stable_generated') {
        next.stable_gender = current.stable_gender || 'female';
      }
      return next;
    }, previous);
    return;
  }
}

function updateVoxcpm2LanguageConfig(tag, updater, previous) {
  const stored = state.ttsSettings.voxcpm2.languages?.[tag];
  const current = { ...VOXCPM2_DEFAULT_LANGUAGE_CONFIG, ...(stored || {}) };
  const next = updater(current);
  state.ttsSettings.voxcpm2.languages = {
    ...(state.ttsSettings.voxcpm2.languages || {}),
    [tag]: next,
  };
  persistVoxcpm2VoiceConfig();
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings(
    { voxcpm2: { languages: state.ttsSettings.voxcpm2.languages } },
    previous,
  );
}

export function syncVoxcpm2VoiceConfigToBackend() {
  // Push localStorage-restored TTS settings to the backend after page load,
  // so the backend's runtime overrides match what the UI shows.
  const delta = {
    enabled: Boolean(state.ttsSettings.enabled),
    backend: String(state.ttsSettings.backend || ''),
    kokoro: { voices: { ...(state.ttsSettings.kokoro?.voices || {}) } },
    voxcpm2: { languages: state.ttsSettings.voxcpm2.languages || {} },
  };
  submitTtsSettings(delta, cloneSettings(state.ttsSettings));
}

export function handleTtsSettingsClick(event) {
  const button = event.target?.closest?.('[data-tts-action]');
  if (!button) return;
  if (button.dataset.ttsAction === 'toggle-prompt-preview') {
    state.ttsPromptInspectOpen = !state.ttsPromptInspectOpen;
    renderTtsSettings({ preserveScroll: true });
  }
}

export function stableSampleInfo(tag, gender) {
  return state.voiceLibraryStable[tag]?.samples?.[gender] || { exists: false, generated_at: null };
}

async function submitTtsSettings(delta, previousSettings) {
  state.ttsUpdateBusy = true;
  renderTtsSettings({ preserveScroll: true });
  try {
    const payload = await api.updateTtsSettings(delta);
    applyTtsConfig(payload.tts || {});
  } catch (error) {
    state.ttsSettings = previousSettings;
    state.status = 'error';
  } finally {
    state.ttsUpdateBusy = false;
    renderTtsSettings({ preserveScroll: true });
  }
}

function toggleTtsGroup(groupName) {
  if (!groupName) return;
  if (state.ttsExpandedGroups.has(groupName)) {
    state.ttsExpandedGroups.delete(groupName);
  } else {
    state.ttsExpandedGroups.add(groupName);
  }
  renderTtsSettings({ preserveScroll: true });
}

export function renderTtsSettings({ preserveScroll = false } = {}) {
  els.ttsOutputState.textContent = ttsSummary();
  if (!els.ttsEnabled || !els.ttsBackendSelect) return;
  els.ttsEnabled.checked = Boolean(state.ttsSettings.enabled);
  els.ttsEnabled.disabled = state.ttsUpdateBusy;
  renderTtsBackendSelect();
  if (!els.ttsSettingsGroups || els.settingsSheet.hidden || state.settingsPage !== 'audio') return;
  const scrollEl = preserveScroll ? tuningScrollElement() : null;
  const scrollTop = scrollEl?.scrollTop || 0;
  const availableBackends = new Set(ttsBackendOptions().map((option) => option.value));
  const groups = [
    { name: 'Kokoro', backend: 'kokoro', rows: kokoroTtsRows() },
    { name: 'VoxCPM2', backend: 'voxcpm2', rows: voxcpm2TtsRows('voxcpm2') },
    { name: 'NanoVLLM VoxCPM', backend: 'nanovllm_voxcpm', rows: voxcpm2TtsRows('nanovllm_voxcpm') },
  ].filter((group) => availableBackends.has(group.backend));
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const expanded = state.ttsExpandedGroups.has(group.name);
    const section = document.createElement('section');
    section.className = 'setting-group tuning-group';
    section.setAttribute('aria-label', group.name);
    section.classList.toggle('is-expanded', expanded);
    const title = document.createElement('button');
    title.className = 'tuning-group-toggle';
    title.type = 'button';
    title.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    title.addEventListener('click', () => toggleTtsGroup(group.name));
    const titleText = document.createElement('span');
    titleText.className = 'tuning-group-title';
    titleText.textContent = group.name;
    const icon = document.createElement('span');
    icon.className = 'tuning-group-icon';
    icon.setAttribute('aria-hidden', 'true');
    title.append(titleText, icon);
    const body = document.createElement('div');
    body.className = 'tuning-group-body';
    body.hidden = !expanded;
    if (expanded) {
      for (const row of group.rows) body.append(row);
    }
    section.append(title, body);
    fragment.append(section);
  }
  els.ttsSettingsGroups.replaceChildren(fragment);
  if (scrollEl) scrollEl.scrollTop = scrollTop;
}

function renderTtsBackendSelect() {
  const current = String(state.ttsSettings.backend || 'kokoro');
  const options = ttsBackendOptions();
  const existing = Array.from(els.ttsBackendSelect.options).map((option) => option.value).join('|');
  const next = options.map((option) => option.value).join('|');
  if (existing !== next) {
    els.ttsBackendSelect.replaceChildren();
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      els.ttsBackendSelect.append(el);
    }
  }
  els.ttsBackendSelect.value = current;
  els.ttsBackendSelect.disabled = state.ttsUpdateBusy || options.length === 0;
}

function kokoroTtsRows() {
  const active = state.ttsSettings.backend === 'kokoro';
  return ttsPresetLanguages().map((language) => {
    const options = state.ttsOptions.kokoro_voices?.[language] || [];
    const disabled = state.ttsUpdateBusy || !active || options.length === 0;
    const value = state.ttsSettings.kokoro.voices?.[language] || options[0]?.value || '';
    return createTtsSelectRow({
      label: `${language} voice`,
      value,
      options,
      disabled,
      kind: 'kokoro-voice',
      language,
      emptyLabel: 'Unsupported',
    });
  });
}

function voxcpm2TtsRows(backend) {
  const active = state.ttsSettings.backend === backend;
  const disabled = state.ttsUpdateBusy || !active;
  const tag = currentVoxcpm2PickerTag();
  const config = voxcpm2LanguageConfig(tag);
  const rows = [createVoxcpm2LanguagePickerRow({ tag, disabled })];
  rows.push(createTtsSelectRow({
    label: 'Voice instruction',
    value: config.mode,
    options: voxcpm2ModeOptions(),
    disabled,
    kind: 'voxcpm2-mode',
    language: tag,
    emptyLabel: 'From description',
  }));
  if (config.mode === 'description') {
    rows.push(createTtsSelectRow({
      label: 'Voice gender',
      value: config.gender || 'female',
      options: voxcpm2GenderOptions(),
      disabled,
      kind: 'voxcpm2-gender',
      language: tag,
      emptyLabel: 'Female',
    }));
    rows.push(createTtsSelectRow({
      label: 'Speaking style',
      value: config.style || 'neutral',
      options: voxcpm2StyleOptions(),
      disabled,
      kind: 'voxcpm2-style',
      language: tag,
      emptyLabel: 'Neutral',
    }));
    rows.push(createDescriptionModeWarningRow());
  } else {
    rows.push(createTtsSelectRow({
      label: 'Reference audio',
      value: config.reference_source || 'last_speech',
      options: voxcpm2ReferenceSourceOptions(),
      disabled,
      kind: 'voxcpm2-reference-source',
      language: tag,
      emptyLabel: 'Last speech fragment',
    }));
    if ((config.reference_source || 'last_speech') === 'stable_generated') {
      rows.push(createTtsSelectRow({
        label: 'Voice gender',
        value: config.stable_gender || 'female',
        options: voxcpm2GenderOptions(),
        disabled,
        kind: 'voxcpm2-stable-gender',
        language: tag,
        emptyLabel: 'Female',
      }));
    }
    rows.push(createTtsNumberRow({
      label: 'Trim audio',
      value: Number.isFinite(Number(config.trim_seconds)) ? Number(config.trim_seconds) : VOXCPM2_DEFAULT_TRIM_SECONDS,
      min: 1,
      max: 60,
      step: 1,
      unit: 's',
      disabled,
      kind: 'voxcpm2-trim-seconds',
      language: tag,
    }));
    if ((config.reference_source || 'last_speech') === 'stable_generated') {
      rows.push(createStableSampleStatusRow({
        tag,
        gender: config.stable_gender || 'female',
      }));
    }
  }
  rows.push(createTtsPromptInspectRows(active, tag, config));
  return rows;
}

function createDescriptionModeWarningRow() {
  const row = document.createElement('div');
  row.className = 'tts-warning-row';
  row.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>'
    + '<path d="M12 9v4"/>'
    + '<path d="M12 17h.01"/>'
    + '</svg>';
  const text = document.createElement('span');
  text.textContent = 'Voice description is experimental. Output can differ noticeably from the prompt. Fine for tinkering, not reliable for serious use.';
  row.append(text);
  return row;
}

function createStableSampleStatusRow({ tag, gender }) {
  const row = document.createElement('div');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = 'Stable sample';
  const info = stableSampleInfo(tag, gender);
  const valueEl = document.createElement('span');
  valueEl.className = 'tts-stable-status';
  if (info.exists) {
    valueEl.textContent = formatStableSampleStatus(info);
  } else if (tag === 'en') {
    valueEl.textContent = 'Not generated yet';
  } else {
    valueEl.textContent = 'Using English sample';
  }
  row.append(labelEl, valueEl);
  return row;
}

function formatStableSampleStatus(info) {
  if (!info?.generated_at) return 'Sample · available';
  try {
    const stamp = new Date(info.generated_at);
    if (!Number.isNaN(stamp.getTime())) {
      const time = stamp.toLocaleString([], {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      return `Sample · ${time}`;
    }
  } catch (_) {}
  return 'Sample · available';
}

function createVoxcpm2LanguagePickerRow({ tag, disabled }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = 'Configure for';
  const select = document.createElement('select');
  select.dataset.ttsKind = 'voxcpm2-picker-language';
  select.disabled = disabled;
  const { active: activeTags, rest: restTags } = voxcpm2PickerLanguageGroups();
  if (activeTags.length) {
    const group = document.createElement('optgroup');
    group.label = 'This session';
    for (const t of activeTags) group.append(_voxcpm2LanguageOption(t));
    select.append(group);
  }
  if (restTags.length) {
    const group = document.createElement('optgroup');
    group.label = 'All languages';
    for (const t of restTags) group.append(_voxcpm2LanguageOption(t));
    select.append(group);
  }
  select.value = tag;
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(select);
  row.append(labelEl, valueWrap);
  return row;
}

function _voxcpm2LanguageOption(tag) {
  const option = document.createElement('option');
  option.value = tag;
  option.textContent = languageNameForBcp47(tag) || tag;
  return option;
}

function voxcpm2PickerLanguageGroups() {
  const sessionTags = [];
  const seen = new Set();
  for (const name of ttsPresetLanguages()) {
    const tag = bcp47ForLanguageName(name);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    sessionTags.push(tag);
  }
  const restTags = [];
  for (const item of languages) {
    const tag = item.bcp47;
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    restTags.push(tag);
  }
  restTags.sort((a, b) => (languageNameForBcp47(a) || a).localeCompare(languageNameForBcp47(b) || b));
  return { active: sessionTags, rest: restTags };
}

function createTtsPromptInspectRows(active, tag, config) {
  const fragment = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'tuning-row tts-action-row';
  const label = document.createElement('span');
  label.className = 'tuning-label';
  label.textContent = 'Prompt';
  const button = document.createElement('button');
  button.className = 'tts-inspect-button';
  button.type = 'button';
  button.dataset.ttsAction = 'toggle-prompt-preview';
  button.disabled = !active;
  button.textContent = state.ttsPromptInspectOpen ? 'Hide prompt' : 'Inspect prompt';
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(button);
  row.append(label, valueWrap);
  fragment.append(row);
  if (state.ttsPromptInspectOpen && active) {
    fragment.append(createVoxcpm2PromptPreview(tag, config));
  }
  return fragment;
}

function createVoxcpm2PromptPreview(tag, config) {
  const languageName = languageNameForBcp47(tag) || tag;
  const preview = document.createElement('div');
  preview.className = 'tts-prompt-preview';
  const textLabel = document.createElement('span');
  textLabel.className = 'tts-prompt-preview-label';
  textLabel.textContent = `Text instruction for ${languageName}`;
  const textValue = document.createElement('code');
  textValue.textContent = voxcpm2InstructionsPreview(languageName, config);
  const sampleLabel = document.createElement('span');
  sampleLabel.className = 'tts-prompt-preview-label';
  sampleLabel.textContent = 'Reference audio';
  const sampleValue = document.createElement('code');
  if (config.mode === 'reference_audio') {
    const trim = Number.isFinite(Number(config.trim_seconds)) ? Number(config.trim_seconds) : VOXCPM2_DEFAULT_TRIM_SECONDS;
    sampleValue.textContent = `Last speech fragment from this session, trimmed to ${trim}s.`;
  } else {
    sampleValue.textContent = 'None';
  }
  preview.append(textLabel, textValue, sampleLabel, sampleValue);
  return preview;
}

export function voxcpm2InstructionsPreview(languageName, config) {
  if (config.mode === 'reference_audio') {
    return [
      `Speak in ${languageName}.`,
      `Pronounce numbers, abbreviations, and short fragments in ${languageName}.`,
      'Use the reference audio as the voice reference.',
      `Do not infer the output language from the reference audio; the output language is ${languageName}.`,
      'Do not copy or continue the content of the reference audio.',
      'Speak clearly and generate only the requested text.',
    ].join(' ');
  }
  const gender = VOXCPM2_GENDER_CLAUSES[config.gender] || VOXCPM2_GENDER_CLAUSES.female;
  const style = VOXCPM2_STYLE_CLAUSES[config.style] || VOXCPM2_STYLE_CLAUSES.neutral;
  return [
    `Speak in ${languageName}.`,
    `Pronounce numbers, abbreviations, and short fragments in ${languageName}.`,
    gender,
    style,
    'Speak clearly and generate only the requested text.',
  ].join(' ');
}

function createTtsSelectRow({ label, value, options, disabled, kind, language, emptyLabel }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const select = document.createElement('select');
  select.dataset.ttsKind = kind;
  select.dataset.ttsLanguage = language;
  select.disabled = disabled;
  const safeOptions = options.length ? options : [{ value: '', label: emptyLabel }];
  for (const option of safeOptions) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    optionEl.disabled = option.disabled === true;
    select.append(optionEl);
  }
  select.value = value;
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(select);
  row.append(labelEl, valueWrap);
  return row;
}

function createTtsNumberRow({ label, value, min, max, step, unit, disabled, kind, language }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.dataset.ttsKind = kind;
  if (language) input.dataset.ttsLanguage = language;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.disabled = disabled;
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(input);
  if (unit) {
    const unitEl = document.createElement('span');
    unitEl.className = 'tuning-unit';
    unitEl.textContent = unit;
    valueWrap.append(unitEl);
  }
  row.append(labelEl, valueWrap);
  return row;
}

function voxcpm2LanguageConfig(tag) {
  const stored = state.ttsSettings.voxcpm2.languages?.[tag];
  if (!stored || typeof stored !== 'object') {
    return { ...VOXCPM2_DEFAULT_LANGUAGE_CONFIG };
  }
  if (stored.mode === 'reference_audio') {
    const cfg = {
      mode: 'reference_audio',
      reference_source: stored.reference_source || 'stable_generated',
      trim_seconds: Number.isFinite(Number(stored.trim_seconds))
        ? Number(stored.trim_seconds)
        : VOXCPM2_DEFAULT_TRIM_SECONDS,
    };
    if (cfg.reference_source === 'stable_generated') {
      cfg.stable_gender = stored.stable_gender || 'female';
    }
    return cfg;
  }
  return {
    mode: 'description',
    gender: stored.gender || 'female',
    style: stored.style || 'neutral',
  };
}

function voxcpm2ModeOptions() {
  return state.ttsOptions.voxcpm2_modes || DEFAULT_TTS_OPTIONS.voxcpm2_modes;
}

export function voxcpm2GenderOptions() {
  return state.ttsOptions.voxcpm2_genders || DEFAULT_TTS_OPTIONS.voxcpm2_genders;
}

function voxcpm2StyleOptions() {
  return state.ttsOptions.voxcpm2_styles || DEFAULT_TTS_OPTIONS.voxcpm2_styles;
}

function voxcpm2ReferenceSourceOptions() {
  return state.ttsOptions.voxcpm2_reference_sources || DEFAULT_TTS_OPTIONS.voxcpm2_reference_sources;
}

function currentVoxcpm2PickerTag() {
  const known = new Set(languages.map((item) => item.bcp47).filter(Boolean));
  if (state.ttsVoxcpm2SelectedTag && known.has(state.ttsVoxcpm2SelectedTag)) {
    return state.ttsVoxcpm2SelectedTag;
  }
  const targetTag = bcp47ForLanguageName(currentTtsTargetLanguage());
  if (targetTag && known.has(targetTag)) return targetTag;
  return languages[0]?.bcp47 || 'en';
}

function normalizeTtsNumber(value, fallback, min, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function ttsPresetLanguages() {
  const seen = new Set();
  const out = [];
  for (const language of [state.sideALanguage, state.sideBLanguage]) {
    const normalized = normalizeLanguageName(language);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function currentTtsTargetLanguage() {
  return normalizeLanguageName(currentLane().targetLanguage || state.sideBLanguage);
}

function ttsSummary() {
  if (!state.ttsSettings.enabled) return 'off';
  if (!ttsBackendOptions().length) return 'none loaded';
  return ttsBackendLabel(state.ttsSettings.backend);
}

function ttsBackendLabel(backend) {
  const options = ttsBackendOptions();
  const match = options.find((option) => option.value === backend);
  return match?.label || String(backend || '');
}

export function ttsBackendOptions() {
  return Array.isArray(state.ttsOptions.backends) ? state.ttsOptions.backends : DEFAULT_TTS_OPTIONS.backends;
}

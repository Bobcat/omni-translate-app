// TTS settings: config load/persist, session-scoped change handlers, render of the
// TTS Options settings subpage. Voice library page stays in app.js for
// the moment but imports a handful of helpers from here.

import { state } from '../state.js';
import { els } from '../els.js';
import {
  languages,
  bcp47ForLanguageName,
  languageNameForBcp47,
  normalizeLanguageName,
} from '../domain/languages.js';
import { DEFAULT_TTS_SETTINGS, DEFAULT_TTS_OPTIONS } from '../shared/constants.js';
import { cloneSettings, mergeSettings } from '../shared/utils.js';
import { loadTtsGlobalConfig, persistTtsGlobalConfig } from '../domain/storage.js';
import { currentLane } from '../domain/lanes.js';

const TTS_BACKEND_GROUP_NAMES = {
  kokoro: 'Kokoro',
  voxcpm2: 'VoxCPM2',
  nanovllm_voxcpm: 'NanoVLLM VoxCPM',
};

export const VOXCPM2_DEFAULT_LANGUAGE_CONFIG = {
  mode: 'reference_audio',
  reference_source: 'stable_generated',
  stable_gender: 'female',
};
export const VOXCPM2_DEFAULT_TRIM_SECONDS = 4;
const VOXCPM2_VOICE_CONFIG_STORAGE_KEY = 'voxcpm2_voice_config';
// Prompt-phrase per identity — kept in sync with backend tts_bridge.py.
// UI dropdown labels stay short ("Adult woman"); this is what ends up in
// the model instruction.
const VOXCPM2_IDENTITY_PHRASES = {
  young_woman: 'young female voice',
  young_man: 'young male voice',
  adult_woman: 'adult female voice',
  adult_man: 'adult male voice',
  middle_aged_woman: 'middle-aged female voice',
  middle_aged_man: 'middle-aged male voice',
  elderly_woman: 'elderly female voice',
  elderly_man: 'elderly male voice',
};
const VOXCPM2_TEXTURE_PHRASES = {
  calm_and_balanced: 'calm and balanced',
  gentle_and_warm: 'gentle and warm',
  soft_and_measured: 'soft and measured',
  clear_and_articulate: 'clear and articulate',
  low_and_resonant: 'low and resonant',
  bright_and_energetic: 'bright and energetic',
  warm_and_intimate: 'warm and intimate',
  breathy_and_quiet: 'breathy and quiet',
  enthusiastic_and_dynamic: 'enthusiastic and dynamic',
  slow_and_reflective: 'slow and reflective',
};
// Full-instruction presets — override identity/texture when set.
const VOXCPM2_PRESET_PHRASES = {
  song_piano_sad: 'Song: Music, Piano, Sad',
  song_pop_happy: 'Song: Pop Music, Beat, Happy, Passion',
  song_acoustic_calm: 'Song: Acoustic Guitar, Calm',
};

// Same setter pattern as voice-library: app.js wires in the shared
// audioQueue so we can preview a stable sample from the TTS settings.
let _audioQueue = null;
export function setTtsAudioQueue(queue) {
  _audioQueue = queue;
}

function tuningScrollElement() {
  return els.settingsSheet?.querySelector('.settings-views') || null;
}

function playStableSampleFromTts(tag, gender) {
  if (!tag || !gender || !_audioQueue) return;
  const info = stableSampleInfo(tag, gender);
  if (!info?.exists) return;
  const cacheBust = encodeURIComponent(info.generated_at || String(Date.now()));
  const url = `/api/voice-library/stable/${encodeURIComponent(tag)}/${encodeURIComponent(gender)}/audio.wav?t=${cacheBust}`;
  _audioQueue.clear();
  _audioQueue.enqueue({ url, duration_ms: 0, replay: true });
}

export function applyTtsConfig(tts) {
  const settings = cloneSettings(tts || {});
  const options = cloneSettings(settings.options || {});
  delete settings.options;
  const previousBackend = state.ttsSettings.backend;
  const nextSettings = mergeSettings(DEFAULT_TTS_SETTINGS, settings);
  const nextOptions = mergeSettings(DEFAULT_TTS_OPTIONS, options);
  const unchanged = JSON.stringify(state.ttsSettings) === JSON.stringify(nextSettings)
    && JSON.stringify(state.ttsOptions) === JSON.stringify(nextOptions);
  state.ttsSettings = nextSettings;
  state.ttsOptions = nextOptions;
  expandSelectedBackendGroup(previousBackend);
  if (!unchanged) renderTtsSettings({ preserveScroll: true });
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
    if (ttsGlobal.backend) state.ttsSettings.backend = ttsGlobal.backend;
    if (ttsGlobal.kokoro_voices) {
      state.ttsSettings.kokoro = state.ttsSettings.kokoro || { voices: {} };
      state.ttsSettings.kokoro.voices = {
        ...(state.ttsSettings.kokoro.voices || {}),
        ...ttsGlobal.kokoro_voices,
      };
    }
    if (ttsGlobal.ultimate_cloning) {
      state.ttsSettings.voxcpm2 = state.ttsSettings.voxcpm2 || {};
      const current = state.ttsSettings.voxcpm2.ultimate_cloning || {};
      const merged = { ...current };
      for (const source of ['stable_generated', 'last_speech']) {
        merged[source] = { ...(current[source] || {}), ...(ttsGlobal.ultimate_cloning[source] || {}) };
      }
      state.ttsSettings.voxcpm2.ultimate_cloning = merged;
    }
  }
  expandSelectedBackendGroup(null);
  renderTtsSettings();
}

export function sessionTtsSettingsPayload() {
  return {
    enabled: Boolean(state.ttsSettings.enabled),
    backend: String(state.ttsSettings.backend || ''),
    kokoro: { voices: { ...(state.ttsSettings.kokoro?.voices || {}) } },
    voxcpm2: {
      languages: state.ttsSettings.voxcpm2?.languages || {},
      ultimate_cloning: state.ttsSettings.voxcpm2?.ultimate_cloning || {},
    },
  };
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
      if (entry.identity !== undefined) out.identity = entry.identity;
      if (entry.texture !== undefined) out.texture = entry.texture;
      if (entry.preset !== undefined) out.preset = entry.preset;
      if (entry.stable_gender !== undefined) out.stable_gender = entry.stable_gender;
      if (entry.trim_seconds !== undefined) out.trim_seconds = entry.trim_seconds;
      // trim_to_source is intentionally NOT persisted: always restored to
      // its default (true) on hard refresh.
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
  if (entry.identity && VOXCPM2_IDENTITY_PHRASES[entry.identity]) out.identity = entry.identity;
  if (entry.texture === '' || VOXCPM2_TEXTURE_PHRASES[entry.texture]) out.texture = entry.texture;
  if (entry.preset === '' || VOXCPM2_PRESET_PHRASES[entry.preset]) out.preset = entry.preset;
  if (allowedGenders.has(entry.stable_gender)) out.stable_gender = entry.stable_gender;
  const trimRaw = Number(entry.trim_seconds);
  if (Number.isFinite(trimRaw)) {
    out.trim_seconds = Math.min(60, Math.max(1, trimRaw));
  }
  // trim_to_source intentionally ignored — never restored from storage.
  return out;
}

export function handleTtsBackendChange() {
  const previousBackend = state.ttsSettings.backend;
  const backend = String(els.ttsBackendSelect.value || '');
  if (!backend) return;
  state.ttsSettings.backend = backend;
  expandSelectedBackendGroup(previousBackend);
  persistTtsGlobalConfig(state.ttsSettings);
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings();
}

export function handleTtsSettingChange(event) {
  const input = event.target;
  if (!input || input.disabled) return;
  const kind = input.dataset.ttsKind || '';
  const language = input.dataset.ttsLanguage || '';
  if (kind === 'kokoro-voice' && language) {
    const value = String(input.value || '');
    state.ttsSettings.kokoro.voices[language] = value;
    persistTtsGlobalConfig(state.ttsSettings);
    renderTtsSettings({ preserveScroll: true });
    submitTtsSettings();
    return;
  }
  if (kind === 'voxcpm2-picker-language') {
    state.ttsVoxcpm2SelectedTag = String(input.value || '').toLowerCase();
    renderTtsSettings({ preserveScroll: true });
    return;
  }
  if (kind === 'voxcpm2-ultimate-enabled') {
    const source = String(input.dataset.ttsSource || '');
    if (source !== 'stable_generated' && source !== 'last_speech') return;
    const enabled = Boolean(input.checked);
    updateUltimateCloningSource(source, { enabled });
    return;
  }
  if (kind === 'voxcpm2-ultimate-mode') {
    const source = String(input.dataset.ttsSource || '');
    if (source !== 'stable_generated' && source !== 'last_speech') return;
    const value = input.value === 'uc2' ? true : false;
    updateUltimateCloningSource(source, { also_use_as_reference: value });
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
          identity: current.identity || 'adult_woman',
          texture: current.texture || '',
          preset: current.preset || '',
        };
      }
      return {
        mode: 'reference_audio',
        reference_source: 'stable_generated',
        stable_gender: current.stable_gender || 'female',
        trim_seconds: Number.isFinite(Number(current.trim_seconds))
          ? Number(current.trim_seconds)
          : VOXCPM2_DEFAULT_TRIM_SECONDS,
        preset: current.preset || '',
      };
    });
    return;
  }
  if (kind === 'voxcpm2-reference-source') {
    // Composite value: "last_speech" | "stable_generated:<gender>".
    // Collapses the old Reference-audio + Voice-gender dropdowns.
    const parts = String(input.value || 'last_speech').split(':');
    const refSource = parts[0] === 'stable_generated' ? 'stable_generated' : 'last_speech';
    updateVoxcpm2LanguageConfig(tag, (current) => {
      const next = {
        mode: 'reference_audio',
        reference_source: refSource,
        trim_seconds: Number.isFinite(Number(current.trim_seconds))
          ? Number(current.trim_seconds)
          : VOXCPM2_DEFAULT_TRIM_SECONDS,
        preset: current.preset || '',
      };
      if (refSource === 'stable_generated') {
        next.stable_gender = parts[1] === 'male' ? 'male' : 'female';
      }
      return next;
    });
    return;
  }
  if (kind === 'voxcpm2-identity') {
    const allowed = new Set(voxcpm2IdentityOptions().map((o) => o.value));
    const value = allowed.has(input.value) ? input.value : 'adult_woman';
    updateVoxcpm2LanguageConfig(tag, (current) => ({
      mode: 'description',
      identity: value,
      texture: current.texture || '',
      preset: current.preset || '',
    }));
    return;
  }
  if (kind === 'voxcpm2-texture') {
    const allowed = new Set(voxcpm2TextureOptions().map((o) => o.value));
    const value = allowed.has(input.value) ? input.value : '';
    updateVoxcpm2LanguageConfig(tag, (current) => ({ ...current, texture: value }));
    return;
  }
  if (kind === 'voxcpm2-style') {
    // Field is still called `preset` internally; UI exposes it as "Style".
    const allowed = new Set(voxcpm2PresetOptions().map((o) => o.value));
    const value = allowed.has(input.value) ? input.value : '';
    updateVoxcpm2LanguageConfig(tag, (current) => ({ ...current, preset: value }));
    return;
  }
  if (kind === 'voxcpm2-trim-to-source') {
    const value = Boolean(input.checked);
    updateVoxcpm2LanguageConfig(tag, (current) => ({ ...current, trim_to_source: value }));
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
    });
    return;
  }
}

function updateVoxcpm2LanguageConfig(tag, updater) {
  const stored = state.ttsSettings.voxcpm2.languages?.[tag];
  const current = { ...VOXCPM2_DEFAULT_LANGUAGE_CONFIG, ...(stored || {}) };
  const next = updater(current);
  state.ttsSettings.voxcpm2.languages = {
    ...(state.ttsSettings.voxcpm2.languages || {}),
    [tag]: next,
  };
  persistVoxcpm2VoiceConfig();
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings();
}

export function handleTtsSettingsClick(event) {
  const button = event.target?.closest?.('[data-tts-action]');
  if (!button || button.disabled) return;
  if (button.dataset.ttsAction === 'toggle-prompt-preview') {
    state.ttsPromptInspectOpen = !state.ttsPromptInspectOpen;
    renderTtsSettings({ preserveScroll: true });
  } else if (button.dataset.ttsAction === 'toggle-ultimate-cloning') {
    state.ttsUltimateCloningOpen = !state.ttsUltimateCloningOpen;
    renderTtsSettings({ preserveScroll: true });
  } else if (button.dataset.ttsAction === 'voxcpm2-reset-language') {
    const tag = String(button.dataset.ttsLanguage || '').toLowerCase();
    if (!tag) return;
    // Brief flash so the tap is clearly registered before the re-render
    // wipes the button's DOM. The re-render itself removes the class.
    button.classList.add('is-flashing');
    setTimeout(() => resetVoxcpm2LanguageConfig(tag), 140);
  } else if (button.dataset.ttsAction === 'play-stable-sample') {
    const tag = String(button.dataset.ttsTag || '').toLowerCase();
    const gender = String(button.dataset.ttsGender || '').toLowerCase();
    playStableSampleFromTts(tag, gender);
  }
}

function resetVoxcpm2LanguageConfig(tag) {
  updateVoxcpm2LanguageConfig(tag, () => ({ ...VOXCPM2_DEFAULT_LANGUAGE_CONFIG }));
}

function updateUltimateCloningSource(source, patch) {
  const voxcpm2 = state.ttsSettings.voxcpm2 = state.ttsSettings.voxcpm2 || {};
  const current = voxcpm2.ultimate_cloning || {};
  const entry = { ...(current[source] || {}), ...patch };
  voxcpm2.ultimate_cloning = { ...current, [source]: entry };
  persistTtsGlobalConfig(state.ttsSettings);
  renderTtsSettings({ preserveScroll: true });
  submitTtsSettings();
}

export function stableSampleInfo(tag, gender) {
  return state.voiceLibraryStable[tag]?.samples?.[gender] || { exists: false, generated_at: null };
}

function submitTtsSettings() {
  state.socket?.updateTtsSettings(sessionTtsSettingsPayload());
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

function expandSelectedBackendGroup(previousBackend) {
  const previousName = TTS_BACKEND_GROUP_NAMES[previousBackend];
  if (previousName && previousBackend !== state.ttsSettings.backend) {
    state.ttsExpandedGroups.delete(previousName);
  }
  const name = TTS_BACKEND_GROUP_NAMES[state.ttsSettings.backend];
  if (name) state.ttsExpandedGroups.add(name);
}

export function renderTtsSettings({ preserveScroll = false } = {}) {
  els.ttsOutputState.textContent = ttsSummary();
  if (!els.ttsBackendSelect) return;
  renderTtsBackendSelect();
  if (!els.ttsSettingsGroups || els.settingsSheet.hidden || state.settingsPage !== 'audio') return;
  const scrollEl = preserveScroll ? tuningScrollElement() : null;
  const scrollTop = scrollEl?.scrollTop || 0;
  const availableBackends = new Set(ttsBackendOptions().map((option) => option.value));
  const groups = [
    { name: 'Kokoro', show: availableBackends.has('kokoro'), rows: kokoroTtsRows },
    { name: 'VoxCPM2', show: availableBackends.has('voxcpm2'), rows: () => voxcpm2TtsRows('voxcpm2') },
    { name: 'NanoVLLM VoxCPM', show: availableBackends.has('nanovllm_voxcpm'), rows: () => voxcpm2TtsRows('nanovllm_voxcpm') },
  ].filter((group) => group.show);
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
      for (const row of group.rows()) body.append(row);
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
      label: 'Identity',
      value: config.identity || 'adult_woman',
      options: voxcpm2IdentityOptions(),
      disabled,
      kind: 'voxcpm2-identity',
      language: tag,
      emptyLabel: 'Adult woman',
    }));
    rows.push(createTtsSelectRow({
      label: 'Texture',
      value: config.texture || '',
      options: voxcpm2TextureOptions(),
      disabled,
      kind: 'voxcpm2-texture',
      language: tag,
      emptyLabel: '(none)',
    }));
    rows.push(createTtsSelectRow({
      label: 'Style',
      value: config.preset || '',
      options: voxcpm2PresetOptions(),
      disabled,
      kind: 'voxcpm2-style',
      language: tag,
      emptyLabel: '(none)',
    }));
    rows.push(createDescriptionModeWarningRow());
  } else {
    rows.push(createTtsSelectRow({
      label: 'Reference audio',
      value: currentReferenceAudioValue(config),
      options: voxcpm2ReferenceAudioOptions(),
      disabled,
      kind: 'voxcpm2-reference-source',
      language: tag,
      emptyLabel: 'Last speech fragment',
    }));
    if ((config.reference_source || 'last_speech') === 'stable_generated') {
      rows.push(createStableSampleStatusRow({
        tag,
        gender: config.stable_gender || 'female',
      }));
    }
    rows.push(createTtsNumberRow({
      label: 'Trim audio (s)',
      value: Number.isFinite(Number(config.trim_seconds)) ? Number(config.trim_seconds) : VOXCPM2_DEFAULT_TRIM_SECONDS,
      min: 1,
      max: 60,
      step: 1,
      disabled,
      kind: 'voxcpm2-trim-seconds',
      language: tag,
    }));
    rows.push(createTtsSwitchRow({
      label: 'Trim to source bubble',
      checked: Boolean(config.trim_to_source),
      disabled,
      kind: 'voxcpm2-trim-to-source',
      language: tag,
    }));
    // With ultimate cloning on, the pool drops (control), so Texture
    // and Style have no effect. Hide them to avoid the confusion of
    // toggles that do nothing.
    if (!referenceModeUltimateCloningActive(config)) {
      rows.push(createTtsSelectRow({
        label: 'Texture',
        value: config.texture || '',
        options: voxcpm2TextureOptions(),
        disabled,
        kind: 'voxcpm2-texture',
        language: tag,
        emptyLabel: '(none)',
      }));
      rows.push(createTtsSelectRow({
        label: 'Style',
        value: config.preset || '',
        options: voxcpm2PresetOptions(),
        disabled,
        kind: 'voxcpm2-style',
        language: tag,
        emptyLabel: '(none)',
      }));
    }
  }
  // Control instruction is moot when UC is on in reference mode (pool
  // drops the wrapper) — hide the whole row to match Texture/Style.
  if (!referenceModeUltimateCloningActive(config)) {
    rows.push(createTtsPromptInspectRows(active, tag, config));
  }
  rows.push(createResetVoxcpm2LanguageRow({ disabled, tag }));
  rows.push(createUltimateInlineToggleRow());
  if (state.ttsUltimateCloningOpen) {
    for (const row of ultimateCloningRows()) rows.push(row);
  }
  return rows;
}

function ultimateCloningRows() {
  const rows = [];
  const cloning = state.ttsSettings.voxcpm2?.ultimate_cloning || {};
  const sources = [
    { key: 'stable_generated', label: 'Stable sample' },
    { key: 'last_speech', label: 'Last speech fragment' },
  ];
  for (const source of sources) {
    const entry = cloning[source.key] || {};
    rows.push(createUltimateToggleRow({
      label: source.label,
      checked: Boolean(entry.enabled),
      source: source.key,
    }));
    rows.push(createUltimateModeRow({
      label: `${source.label} mode`,
      value: entry.also_use_as_reference === false ? 'uc1' : 'uc2',
      source: source.key,
    }));
  }
  return rows;
}

function createUltimateInlineToggleRow() {
  const open = Boolean(state.ttsUltimateCloningOpen);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = open ? 'tts-subgroup-toggle is-expanded' : 'tts-subgroup-toggle';
  button.dataset.ttsAction = 'toggle-ultimate-cloning';
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  const title = document.createElement('span');
  title.className = 'tts-subgroup-title';
  title.textContent = 'Ultimate cloning (global)';
  const icon = document.createElement('span');
  icon.className = 'tts-subgroup-icon';
  icon.setAttribute('aria-hidden', 'true');
  button.append(title, icon);
  return button;
}

function createUltimateToggleRow({ label, checked, source }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const switchEl = document.createElement('span');
  switchEl.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.dataset.ttsKind = 'voxcpm2-ultimate-enabled';
  input.dataset.ttsSource = source;
  input.checked = checked;
  const track = document.createElement('span');
  track.className = 'switch-track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('span');
  thumb.className = 'switch-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  switchEl.append(input, track, thumb);
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(switchEl);
  row.append(labelEl, valueWrap);
  return row;
}

function createUltimateModeRow({ label, value, source }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const select = document.createElement('select');
  select.dataset.ttsKind = 'voxcpm2-ultimate-mode';
  select.dataset.ttsSource = source;
  for (const [v, lbl] of [['uc2', 'Prompt + reference'], ['uc1', 'Prompt only']]) {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = lbl;
    select.append(option);
  }
  select.value = value;
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(select);
  row.append(labelEl, valueWrap);
  return row;
}

function createDescriptionModeWarningRow() {
  return _createTtsWarningRow(
    'Voice description is experimental. Output can differ noticeably from the prompt. Fine for tinkering, not reliable for serious use.',
  );
}

function _createTtsWarningRow(message) {
  const row = document.createElement('div');
  row.className = 'tts-warning-row';
  row.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>'
    + '<path d="M12 9v4"/>'
    + '<path d="M12 17h.01"/>'
    + '</svg>';
  const text = document.createElement('span');
  text.textContent = message;
  row.append(text);
  return row;
}

function referenceModeUltimateCloningActive(config) {
  if (config.mode !== 'reference_audio') return false;
  const source = config.reference_source || 'last_speech';
  const entry = state.ttsSettings.voxcpm2?.ultimate_cloning?.[source];
  return Boolean(entry?.enabled);
}

function createResetVoxcpm2LanguageRow({ disabled, tag }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-row audio-reset-button';
  button.dataset.ttsAction = 'voxcpm2-reset-language';
  button.dataset.ttsLanguage = tag;
  button.textContent = 'Reset to defaults';
  button.disabled = disabled;
  return button;
}

function createStableSampleStatusRow({ tag, gender }) {
  const row = document.createElement('div');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = 'Stable sample';
  const info = stableSampleInfo(tag, gender);
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  const valueEl = document.createElement('span');
  valueEl.className = 'tts-stable-status';
  if (info.exists) {
    valueEl.textContent = formatStableSampleStatus(info);
  } else if (tag === 'en') {
    valueEl.textContent = 'Not generated yet';
  } else {
    valueEl.textContent = 'Using English sample';
  }
  valueWrap.append(valueEl);
  if (info.exists) {
    valueWrap.append(_createStableSamplePlayButton(tag, gender));
  }
  row.append(labelEl, valueWrap);
  return row;
}

function _createStableSamplePlayButton(tag, gender) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tts-play-button';
  button.dataset.ttsAction = 'play-stable-sample';
  button.dataset.ttsTag = tag;
  button.dataset.ttsGender = gender;
  button.setAttribute('aria-label', 'Play stable sample');
  button.title = 'Play stable sample';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>'
    + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
    + '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
    + '</svg>';
  return button;
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
  label.textContent = 'Control instruction';
  const button = document.createElement('button');
  button.className = 'tts-inspect-button';
  button.type = 'button';
  button.dataset.ttsAction = 'toggle-prompt-preview';
  button.disabled = !active;
  button.textContent = state.ttsPromptInspectOpen ? 'Hide' : 'Inspect';
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
  const textValue = document.createElement('code');
  textValue.textContent = voxcpm2InstructionsPreview(languageName, config);
  preview.append(textValue);
  return preview;
}

export function voxcpm2InstructionsPreview(languageName, config) {
  const presetPhrase = VOXCPM2_PRESET_PHRASES[config.preset];
  const texturePhrase = VOXCPM2_TEXTURE_PHRASES[config.texture];
  if (config.mode === 'reference_audio') {
    if (presetPhrase) {
      if (presetPhrase.startsWith('Song:')) return `${presetPhrase}, vocals from reference audio`;
      return presetPhrase;
    }
    if (texturePhrase) return `${texturePhrase} tone`;
    return '(none)';
  }
  const identity = VOXCPM2_IDENTITY_PHRASES[config.identity] || VOXCPM2_IDENTITY_PHRASES.adult_woman;
  if (presetPhrase) {
    // Song-mode: switch "voice" to "vocals" to match VoxCPM's song
    // vocabulary; texture is intentionally dropped (see backend).
    return `${presetPhrase}, ${identity.replace('voice', 'vocals')}`;
  }
  const parts = [identity];
  if (texturePhrase) parts.push(`${texturePhrase} tone`);
  return parts.join(', ');
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

function createTtsSwitchRow({ label, checked, disabled, kind, language }) {
  const row = document.createElement('label');
  row.className = 'tuning-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tuning-label';
  labelEl.textContent = label;
  const switchEl = document.createElement('span');
  switchEl.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.dataset.ttsKind = kind;
  if (language) input.dataset.ttsLanguage = language;
  input.checked = Boolean(checked);
  input.disabled = Boolean(disabled);
  const track = document.createElement('span');
  track.className = 'switch-track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('span');
  thumb.className = 'switch-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  switchEl.append(input, track, thumb);
  const valueWrap = document.createElement('span');
  valueWrap.className = 'tuning-value-wrap';
  valueWrap.append(switchEl);
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
      trim_to_source: Boolean(stored.trim_to_source),
      texture: stored.texture || '',
      preset: stored.preset || '',
    };
    if (cfg.reference_source === 'stable_generated') {
      cfg.stable_gender = stored.stable_gender || 'female';
    }
    return cfg;
  }
  return {
    mode: 'description',
    identity: stored.identity || 'adult_woman',
    texture: stored.texture || '',
    preset: stored.preset || '',
  };
}

function voxcpm2ModeOptions() {
  return state.ttsOptions.voxcpm2_modes || DEFAULT_TTS_OPTIONS.voxcpm2_modes;
}

export function voxcpm2GenderOptions() {
  return state.ttsOptions.voxcpm2_genders || DEFAULT_TTS_OPTIONS.voxcpm2_genders;
}

function voxcpm2IdentityOptions() {
  return state.ttsOptions.voxcpm2_identities || DEFAULT_TTS_OPTIONS.voxcpm2_identities;
}

function voxcpm2TextureOptions() {
  return state.ttsOptions.voxcpm2_textures || DEFAULT_TTS_OPTIONS.voxcpm2_textures;
}

function voxcpm2PresetOptions() {
  return state.ttsOptions.voxcpm2_presets || DEFAULT_TTS_OPTIONS.voxcpm2_presets;
}

function voxcpm2ReferenceAudioOptions() {
  return [
    { value: 'last_speech', label: 'Last speech fragment' },
    { value: 'stable_generated:female', label: 'Stable generated · female' },
    { value: 'stable_generated:male', label: 'Stable generated · male' },
  ];
}

function currentReferenceAudioValue(config) {
  const source = config.reference_source || 'last_speech';
  if (source === 'stable_generated') {
    const gender = config.stable_gender === 'male' ? 'male' : 'female';
    return `stable_generated:${gender}`;
  }
  return 'last_speech';
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

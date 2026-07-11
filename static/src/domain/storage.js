// localStorage helpers for client-side TTS / dev-tools / recent-language state.
// Functions that need state read it via an explicit argument; nothing here
// reaches into the app's mutable singletons.

export const APP_STORAGE_KEYS = Object.freeze({
  TTS_GLOBAL: 'tts_global',
  RECENT_LANGUAGES: 'recent_languages',
  DEV_TOOLS_SETTINGS: 'dev_tools_settings',
  SETUP_LANGUAGES: 'setup_languages',
  VOXCPM2_VOICE_CONFIG: 'voxcpm2_voice_config',
  IMAGE_RENDER_SETTINGS: 'image_render_settings',
});
export const TTS_GLOBAL_STORAGE_KEY = APP_STORAGE_KEYS.TTS_GLOBAL;
export const RECENT_LANGUAGES_KEY = APP_STORAGE_KEYS.RECENT_LANGUAGES;
export const DEV_TOOLS_SETTINGS_KEY = APP_STORAGE_KEYS.DEV_TOOLS_SETTINGS;
export const SETUP_LANGUAGES_KEY = APP_STORAGE_KEYS.SETUP_LANGUAGES;
export const VOXCPM2_VOICE_CONFIG_STORAGE_KEY = APP_STORAGE_KEYS.VOXCPM2_VOICE_CONFIG;
export const IMAGE_RENDER_SETTINGS_KEY = APP_STORAGE_KEYS.IMAGE_RENDER_SETTINGS;
export const RECENT_MAX = 4;

// Image-translation render options. The allowed values mirror the service's flag enums; the
// defaults mirror the service's own defaults. A stored value outside the enum falls back to the
// default for that key, so a stale/garbage entry can never inject an invalid flag.
export const IMAGE_RENDER_ALLOWED = Object.freeze({
  render_size_mode: ['median', 'min'],
  erase_fill_mode: ['inpaint', 'flat'],
  width_fit_mode: ['footprint', 'extend'],
  size_metric_mode: ['extent', 'band'],
  size_cohort_mode: ['off', 'vlm'],
});
export const DEFAULT_IMAGE_RENDER = Object.freeze({
  render_size_mode: 'median',
  erase_fill_mode: 'inpaint',
  width_fit_mode: 'footprint',
  size_metric_mode: 'extent',
  size_cohort_mode: 'vlm',
});

export function clearAppLocalStorage() {
  let removed = 0;
  for (const key of Object.values(APP_STORAGE_KEYS)) {
    if (localStorage.getItem(key) !== null) removed += 1;
    localStorage.removeItem(key);
  }
  return removed;
}

export function loadTtsGlobalConfig() {
  try {
    const raw = localStorage.getItem(TTS_GLOBAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    if (typeof parsed.backend === 'string' && parsed.backend) out.backend = parsed.backend;
    if (parsed.kokoro_voices && typeof parsed.kokoro_voices === 'object') {
      const voices = {};
      for (const [language, voice] of Object.entries(parsed.kokoro_voices)) {
        if (typeof language === 'string' && typeof voice === 'string' && language && voice) {
          voices[language] = voice;
        }
      }
      if (Object.keys(voices).length) out.kokoro_voices = voices;
    }
    if (parsed.ultimate_cloning && typeof parsed.ultimate_cloning === 'object') {
      const cleaned = {};
      for (const source of ['stable_generated', 'last_speech']) {
        const entry = parsed.ultimate_cloning[source];
        if (!entry || typeof entry !== 'object') continue;
        const out2 = {};
        if (typeof entry.enabled === 'boolean') out2.enabled = entry.enabled;
        if (typeof entry.also_use_as_reference === 'boolean') {
          out2.also_use_as_reference = entry.also_use_as_reference;
        }
        if (Object.keys(out2).length) cleaned[source] = out2;
      }
      if (Object.keys(cleaned).length) out.ultimate_cloning = cleaned;
    }
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
}

export function persistTtsGlobalConfig(ttsSettings) {
  try {
    const payload = {
      backend: String(ttsSettings.backend || ''),
      kokoro_voices: { ...(ttsSettings.kokoro?.voices || {}) },
    };
    const ultimate = ttsSettings.voxcpm2?.ultimate_cloning;
    if (ultimate && typeof ultimate === 'object') {
      const cleaned = {};
      for (const source of ['stable_generated', 'last_speech']) {
        const entry = ultimate[source];
        if (!entry || typeof entry !== 'object') continue;
        cleaned[source] = {
          enabled: Boolean(entry.enabled),
          also_use_as_reference: Boolean(entry.also_use_as_reference),
        };
      }
      if (Object.keys(cleaned).length) payload.ultimate_cloning = cleaned;
    }
    localStorage.setItem(TTS_GLOBAL_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {
    // ignore quota / disabled storage
  }
}

export function loadDevToolsSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEV_TOOLS_SETTINGS_KEY) || '{}');
    // Migrate legacy `showPcExport` key → `showControls`.
    const showControls = typeof saved.showControls === 'boolean'
      ? saved.showControls
      : Boolean(saved.showPcExport);
    return { showControls };
  } catch {
    return { showControls: false };
  }
}

export function saveDevToolsSettings(devToolsSettings) {
  localStorage.setItem(DEV_TOOLS_SETTINGS_KEY, JSON.stringify(devToolsSettings));
}

export function loadImageRenderSettings() {
  const out = { ...DEFAULT_IMAGE_RENDER };
  try {
    const saved = JSON.parse(localStorage.getItem(IMAGE_RENDER_SETTINGS_KEY) || '{}');
    for (const [key, allowed] of Object.entries(IMAGE_RENDER_ALLOWED)) {
      if (allowed.includes(saved[key])) out[key] = saved[key];
    }
  } catch {
    // ignore parse / disabled storage — defaults stand
  }
  return out;
}

export function saveImageRenderSettings(imageRender) {
  try {
    const payload = {};
    for (const key of Object.keys(IMAGE_RENDER_ALLOWED)) {
      payload[key] = String(imageRender[key] || '');
    }
    localStorage.setItem(IMAGE_RENDER_SETTINGS_KEY, JSON.stringify(payload));
  } catch (_) {
    // ignore quota / disabled storage
  }
}

export function getRecentLanguages() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_LANGUAGES_KEY) || '[]');
  } catch {
    return [];
  }
}

export function pushRecentLanguage(name) {
  const recent = getRecentLanguages().filter((n) => n !== name);
  recent.unshift(name);
  localStorage.setItem(RECENT_LANGUAGES_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)));
}

export function loadSetupLanguages() {
  try {
    const raw = localStorage.getItem(SETUP_LANGUAGES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const source = typeof parsed.source === 'string' ? parsed.source : '';
    const target = typeof parsed.target === 'string' ? parsed.target : '';
    if (!source || !target) return null;
    return { source, target };
  } catch (_) {
    return null;
  }
}

export function persistSetupLanguages(source, target) {
  try {
    localStorage.setItem(SETUP_LANGUAGES_KEY, JSON.stringify({
      source: String(source || ''),
      target: String(target || ''),
    }));
  } catch (_) {
    // ignore quota / disabled storage
  }
}

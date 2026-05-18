// localStorage helpers for client-side TTS / dev-tools / recent-language state.
// Functions that need state read it via an explicit argument; nothing here
// reaches into the app's mutable singletons.

export const TTS_GLOBAL_STORAGE_KEY = 'tts_global';
export const RECENT_LANGUAGES_KEY = 'recent_languages';
export const DEV_TOOLS_SETTINGS_KEY = 'dev_tools_settings';
export const RECENT_MAX = 4;

export function loadTtsGlobalConfig() {
  try {
    const raw = localStorage.getItem(TTS_GLOBAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    if (typeof parsed.enabled === 'boolean') out.enabled = parsed.enabled;
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
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
}

export function persistTtsGlobalConfig(ttsSettings) {
  try {
    const payload = {
      enabled: Boolean(ttsSettings.enabled),
      backend: String(ttsSettings.backend || ''),
      kokoro_voices: { ...(ttsSettings.kokoro?.voices || {}) },
    };
    localStorage.setItem(TTS_GLOBAL_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {
    // ignore quota / disabled storage
  }
}

export function loadDevToolsSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEV_TOOLS_SETTINGS_KEY) || '{}');
    return { showPcExport: Boolean(saved.showPcExport) };
  } catch {
    return { showPcExport: false };
  }
}

export function saveDevToolsSettings(devToolsSettings) {
  localStorage.setItem(DEV_TOOLS_SETTINGS_KEY, JSON.stringify(devToolsSettings));
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

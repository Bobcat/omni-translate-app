// localStorage helpers for client-side TTS / dev-tools / recent-language state.
// Functions that need state read it via an explicit argument; nothing here
// reaches into the app's mutable singletons.

export const TTS_GLOBAL_STORAGE_KEY = 'tts_global';
export const RECENT_LANGUAGES_KEY = 'recent_languages';
export const DEV_TOOLS_SETTINGS_KEY = 'dev_tools_settings';
export const SETUP_LANGUAGES_KEY = 'setup_languages';
export const RECENT_MAX = 4;

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

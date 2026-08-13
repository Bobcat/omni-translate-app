export const languages = [
  { name: 'English', asr: 'en', bcp47: 'en', kokoro: true },
  { name: 'British English', asr: 'en', bcp47: 'en-gb', kokoro: true },
  { name: 'Dutch', asr: 'nl', bcp47: 'nl' },
  { name: 'German', asr: 'de', bcp47: 'de' },
  { name: 'French', asr: 'fr', bcp47: 'fr', kokoro: true },
  { name: 'Spanish', asr: 'es', bcp47: 'es', kokoro: true },
  { name: 'Hindi', asr: 'hi', bcp47: 'hi', kokoro: true },
  { name: 'Italian', asr: 'it', bcp47: 'it', kokoro: true },
  { name: 'Portuguese', asr: 'pt', bcp47: 'pt-pt', kokoro: true },
  { name: 'Brazilian Portuguese', asr: 'pt', bcp47: 'pt-br', kokoro: true },
  { name: 'Polish', asr: 'pl', bcp47: 'pl' },
  { name: 'Ukrainian', asr: 'uk', bcp47: 'uk' },
  { name: 'Turkish', asr: 'tr', bcp47: 'tr' },
  { name: 'Arabic', asr: 'ar', bcp47: 'ar' },
  { name: 'Chinese', asr: 'zh', bcp47: 'zh-cn', kokoro: true },
  { name: 'Japanese', asr: 'ja', bcp47: 'ja', kokoro: true },
  { name: 'Korean', asr: 'ko', bcp47: 'ko' },
  { name: 'Afrikaans', asr: 'af', bcp47: 'af' },
  { name: 'Danish', asr: 'da', bcp47: 'da' },
  { name: 'Hungarian', asr: 'hu', bcp47: 'hu' },
  { name: 'Norwegian', asr: 'no', bcp47: 'nb' },
  { name: 'Romanian', asr: 'ro', bcp47: 'ro' },
  { name: 'Russian', asr: 'ru', bcp47: 'ru' },
  { name: 'Swedish', asr: 'sv', bcp47: 'sv' },
  { name: 'Vietnamese', asr: 'vi', bcp47: 'vi' },
  { name: 'Indonesian', asr: 'id', bcp47: 'id' },
  { name: 'Bengali', asr: 'bn', bcp47: 'bn' },
  { name: 'Urdu', asr: 'ur', bcp47: 'ur' },
  { name: 'Persian', asr: 'fa', bcp47: 'fa' },
  { name: 'Thai', asr: 'th', bcp47: 'th' },
  { name: 'Greek', asr: 'el', bcp47: 'el' },
  { name: 'Czech', asr: 'cs', bcp47: 'cs' },
  { name: 'Finnish', asr: 'fi', bcp47: 'fi' },
  { name: 'Hebrew', asr: 'he', bcp47: 'he' },
  { name: 'Tamil', asr: 'ta', bcp47: 'ta' },
  { name: 'Tagalog', asr: 'tl', bcp47: 'tl' },
  { name: 'Malay', asr: 'ms', bcp47: 'ms' },
  { name: 'Swahili', asr: 'sw', bcp47: 'sw' },
  { name: 'Bulgarian', asr: 'bg', bcp47: 'bg' },
  { name: 'Croatian', asr: 'hr', bcp47: 'hr' },
  { name: 'Slovak', asr: 'sk', bcp47: 'sk' },
];

export function bcp47ForLanguageName(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  const match = languages.find((item) => item.name === text);
  return match?.bcp47 || '';
}

export function languageNameForBcp47(tag) {
  const text = String(tag || '').trim().toLowerCase();
  if (!text) return '';
  const match = languages.find((item) => item.bcp47 === text);
  return match?.name || '';
}

export function codeForLanguage(name) {
  const match = languages.find((item) => item.name === name);
  return (match?.asr || String(name || '').slice(0, 2)).toUpperCase();
}

export function normalizeLanguageName(value) {
  const fallback = languages[0]?.name || 'English';
  const text = String(value || '').trim();
  return languages.some((item) => item.name === text) ? text : fallback;
}

export function guessSetupLanguages() {
  // Best-effort source/target pair from navigator.languages (browser
  // preference list). Falls back to English source / Dutch target when
  // the browser only knows English variants.
  const prefs = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : (navigator.language ? [navigator.language] : []);
  const matchName = (tag) => {
    const lower = String(tag || '').toLowerCase().trim();
    if (!lower) return null;
    const exact = languages.find((item) => item.bcp47 === lower);
    if (exact) return exact.name;
    const primary = lower.split('-')[0];
    const byPrimary = languages.find((item) => item.bcp47 === primary);
    if (byPrimary) return byPrimary.name;
    const byPrefix = languages.find((item) => item.bcp47.split('-')[0] === primary);
    return byPrefix ? byPrefix.name : null;
  };
  let source = null;
  for (const pref of prefs) {
    const name = matchName(pref);
    if (name) { source = name; break; }
  }
  if (!source) source = 'English';
  // Target is fixed to a TTS-safe pair: English by default, Chinese when
  // the source is already an English variant. Browser preferences are
  // intentionally not consulted here — the goal is guaranteed TTS quality.
  const sourceIsEnglishFamily = source === 'English' || source === 'British English';
  const target = sourceIsEnglishFamily ? 'Chinese' : 'English';
  return { source, target };
}

export const languages = [
  { name: 'English', asr: 'en', bcp47: 'en', kokoro: true },
  { name: 'British English', asr: 'en', bcp47: 'en-gb', kokoro: true, flag: '🇬🇧' },
  { name: 'Dutch', asr: 'nl', bcp47: 'nl' },
  { name: 'German', asr: 'de', bcp47: 'de' },
  { name: 'French', asr: 'fr', bcp47: 'fr', kokoro: true },
  { name: 'Spanish', asr: 'es', bcp47: 'es', kokoro: true },
  { name: 'Hindi', asr: 'hi', bcp47: 'hi', kokoro: true },
  { name: 'Italian', asr: 'it', bcp47: 'it', kokoro: true },
  { name: 'Portuguese', asr: 'pt', bcp47: 'pt-pt', kokoro: true },
  { name: 'Brazilian Portuguese', asr: 'pt', bcp47: 'pt-br', kokoro: true, flag: '🇧🇷' },
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
];

export const LANGUAGE_FLAGS = {
  af: '🇿🇦',
  ar: '🇸🇦',
  da: '🇩🇰',
  de: '🇩🇪',
  en: '🇬🇧',
  es: '🇪🇸',
  fr: '🇫🇷',
  hi: '🇮🇳',
  hu: '🇭🇺',
  it: '🇮🇹',
  ja: '🇯🇵',
  ko: '🇰🇷',
  nl: '🇳🇱',
  no: '🇳🇴',
  pl: '🇵🇱',
  pt: '🇵🇹',
  ro: '🇷🇴',
  ru: '🇷🇺',
  sv: '🇸🇪',
  tr: '🇹🇷',
  uk: '🇺🇦',
  vi: '🇻🇳',
  zh: '🇨🇳',
};

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

export function flagForLanguage(name) {
  const match = languages.find((item) => item.name === name);
  return match?.flag || LANGUAGE_FLAGS[match?.asr] || '';
}

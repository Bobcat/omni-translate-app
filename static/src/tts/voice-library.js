// Voice library settings subpage: select language + gender + engine,
// generate stable samples, preview them. Uses the shared TTS settings
// module for engine/gender option lookups and the prompt-preview text.

import { api } from '../api-client.js';
import { state } from '../state.js';
import { els } from '../els.js';
import {
  languages,
  bcp47ForLanguageName,
  languageNameForBcp47,
} from '../shared/languages.js';
import {
  voxcpm2GenderOptions,
  voxcpm2InstructionsPreview,
  currentTtsTargetLanguage,
  stableSampleInfo,
  ttsBackendOptions,
  renderTtsSettings,
} from './settings.js';

// audioQueue is owned by app.js (wired to lifecycle callbacks). Voice library
// needs it for the stable-sample preview. Setter pattern avoids cyclic import.
let _audioQueue = null;
export function setAudioQueue(queue) {
  _audioQueue = queue;
}

export function renderVoiceLibraryPage() {
  if (!els.voiceLibraryControls) return;
  if (els.settingsSheet.hidden || state.settingsPage !== 'voice-library') return;
  const engines = voiceLibraryEngineOptions();
  const languageTags = voiceLibraryLanguageTags();
  const genderOptions = voxcpm2GenderOptions();
  if (!engines.some((option) => option.value === state.voiceLibraryEngine)) {
    state.voiceLibraryEngine = engines[0]?.value || '';
  }
  if (!languageTags.includes(state.voiceLibraryLanguageTag)) {
    const targetTag = bcp47ForLanguageName(currentTtsTargetLanguage());
    state.voiceLibraryLanguageTag = languageTags.includes(targetTag) ? targetTag : (languageTags[0] || '');
  }
  if (!['female', 'male'].includes(state.voiceLibraryGender)) {
    state.voiceLibraryGender = 'female';
  }
  const tag = state.voiceLibraryLanguageTag;
  const gender = state.voiceLibraryGender;
  const engine = state.voiceLibraryEngine;
  const langStatus = state.voiceLibraryStable[tag] || {
    has_reference_text: false,
    reference_text: '',
    samples: {},
  };
  const info = stableSampleInfo(tag, gender);
  const busy = state.voiceLibraryBusyTag === `${tag}:${gender}`;
  const languageOptions = languageTags.map((value) => ({
    value,
    label: languageNameForBcp47(value) || value,
  }));
  const referenceText = String(langStatus.reference_text || '');
  const languageName = languageNameForBcp47(tag) || tag || '';
  const promptText = languageName
    ? voxcpm2InstructionsPreview(languageName, { mode: 'description', gender, style: 'neutral' })
    : '';

  const fragment = document.createDocumentFragment();
  fragment.append(
    _voiceLibrarySelectRow({
      label: 'Engine',
      value: engine,
      options: engines,
      kind: 'engine',
      disabled: engines.length < 2,
      emptyText: engines.length ? '' : 'No VoxCPM engine loaded',
    }),
    _voiceLibrarySelectRow({
      label: 'Language',
      value: tag,
      options: languageOptions,
      kind: 'language',
      disabled: false,
    }),
    _voiceLibrarySelectRow({
      label: 'Gender',
      value: gender,
      options: genderOptions,
      kind: 'gender',
      disabled: false,
    }),
    _voiceLibraryStatusLine(info),
    _voiceLibraryActions({ busy, info, hasReferenceText: langStatus.has_reference_text, hasEngine: Boolean(engine) }),
    _voiceLibraryBlock('Reference text', referenceText || '(no reference text for this language)'),
    _voiceLibraryBlock('Prompt', promptText),
  );
  els.voiceLibraryControls.replaceChildren(fragment);
}

function voiceLibraryEngineOptions() {
  const all = ttsBackendOptions();
  return all.filter((option) => option.value === 'voxcpm2' || option.value === 'nanovllm_voxcpm');
}

function voiceLibraryLanguageTags() {
  const tags = [];
  const seen = new Set();
  for (const item of languages) {
    const tag = item.bcp47;
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  tags.sort((a, b) => (languageNameForBcp47(a) || a).localeCompare(languageNameForBcp47(b) || b));
  return tags;
}

function _voiceLibrarySelectRow({ label, value, options, kind, disabled, emptyText }) {
  const row = document.createElement('label');
  row.className = 'select-row voice-library-row';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const select = document.createElement('select');
  select.dataset.voiceLibraryKind = kind;
  select.disabled = disabled || !options.length;
  if (!options.length && emptyText) {
    const opt = document.createElement('option');
    opt.textContent = emptyText;
    opt.value = '';
    select.append(opt);
  } else {
    for (const option of options) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.append(opt);
    }
    select.value = value;
  }
  row.append(labelEl, select);
  return row;
}

function _voiceLibraryBlock(label, body) {
  const wrap = document.createElement('div');
  wrap.className = 'tts-prompt-preview voice-library-block';
  const labelEl = document.createElement('span');
  labelEl.className = 'tts-prompt-preview-label';
  labelEl.textContent = label;
  const code = document.createElement('code');
  code.textContent = body;
  wrap.append(labelEl, code);
  return wrap;
}

function _voiceLibraryStatusLine(info) {
  const line = document.createElement('div');
  line.className = 'voice-library-status';
  if (info?.exists && info?.generated_at) {
    try {
      const stamp = new Date(info.generated_at);
      if (!Number.isNaN(stamp.getTime())) {
        line.textContent = `Last generated: ${stamp.toLocaleString([], {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })}`;
        return line;
      }
    } catch (_) {}
    line.textContent = 'Last generated: unknown time';
  } else {
    line.textContent = 'Last generated: never';
  }
  return line;
}

function _voiceLibraryActions({ busy, info, hasReferenceText, hasEngine }) {
  const wrap = document.createElement('div');
  wrap.className = 'voice-library-actions';
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.className = 'tts-inspect-button';
  generate.dataset.voiceLibraryAction = 'generate';
  if (busy) {
    generate.textContent = 'Generating…';
  } else if (info.exists) {
    generate.textContent = 'Regenerate';
  } else {
    generate.textContent = 'Generate';
  }
  generate.disabled = busy || !hasReferenceText || !hasEngine;
  if (!hasReferenceText) generate.title = 'No reference text for this language';
  else if (!hasEngine) generate.title = 'Load a VoxCPM engine to generate samples';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'tts-play-button';
  play.dataset.voiceLibraryAction = 'play';
  play.setAttribute('aria-label', 'Play sample');
  play.title = 'Play sample';
  play.disabled = busy || !info.exists;
  play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>'
    + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
    + '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
    + '</svg>';
  wrap.append(generate, play);
  return wrap;
}

export function handleVoiceLibraryChange(event) {
  const select = event.target;
  if (!select || select.tagName !== 'SELECT') return;
  const kind = select.dataset.voiceLibraryKind || '';
  const value = String(select.value || '');
  if (kind === 'engine') {
    state.voiceLibraryEngine = value;
  } else if (kind === 'language') {
    state.voiceLibraryLanguageTag = value.toLowerCase();
  } else if (kind === 'gender') {
    state.voiceLibraryGender = value;
  } else {
    return;
  }
  renderVoiceLibraryPage();
}

export function handleVoiceLibraryClick(event) {
  const button = event.target?.closest?.('[data-voice-library-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.voiceLibraryAction;
  const tag = state.voiceLibraryLanguageTag;
  const gender = state.voiceLibraryGender;
  if (action === 'generate') {
    handleGenerateStableSample(tag, gender, state.voiceLibraryEngine);
    return;
  }
  if (action === 'play') {
    const info = stableSampleInfo(tag, gender);
    if (info.exists) playStableSamplePreview(tag, gender, info);
  }
}

function playStableSamplePreview(tag, gender, info) {
  if (!tag || !gender || !info?.exists || !_audioQueue) return;
  const cacheBust = encodeURIComponent(info.generated_at || String(Date.now()));
  const url = `/api/voice-library/stable/${encodeURIComponent(tag)}/${encodeURIComponent(gender)}/audio.wav?t=${cacheBust}`;
  _audioQueue.clear();
  _audioQueue.enqueue({ url, duration_ms: 0, replay: true });
}

export function applyVoiceLibraryStatus(stable) {
  const next = {};
  if (stable && typeof stable === 'object') {
    for (const [tag, entry] of Object.entries(stable)) {
      next[String(tag).toLowerCase()] = entry && typeof entry === 'object'
        ? {
          has_reference_text: Boolean(entry.has_reference_text),
          reference_text: String(entry.reference_text || ''),
          samples: entry.samples && typeof entry.samples === 'object' ? entry.samples : {},
        }
        : { has_reference_text: false, reference_text: '', samples: {} };
    }
  }
  state.voiceLibraryStable = next;
}

async function handleGenerateStableSample(tag, gender, engine) {
  if (!tag || !gender || !engine || state.voiceLibraryBusyTag) return;
  state.voiceLibraryBusyTag = `${tag}:${gender}`;
  renderVoiceLibraryPage();
  renderTtsSettings({ preserveScroll: true });
  try {
    const result = await api.generateStableVoiceSample({ language: tag, gender, engine });
    const resolvedGender = String(result?.gender || gender);
    if (result?.info && typeof result.info === 'object') {
      const existing = state.voiceLibraryStable[tag] || { has_reference_text: false, samples: {} };
      state.voiceLibraryStable = {
        ...state.voiceLibraryStable,
        [tag]: {
          ...existing,
          samples: { ...(existing.samples || {}), [resolvedGender]: result.info },
        },
      };
      playStableSamplePreview(tag, resolvedGender, result.info);
    }
  } catch (error) {
    state.status = 'error';
  } finally {
    state.voiceLibraryBusyTag = '';
    renderVoiceLibraryPage();
    renderTtsSettings({ preserveScroll: true });
  }
}

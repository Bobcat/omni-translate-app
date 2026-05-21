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
} from '../domain/languages.js';
import {
  voxcpm2GenderOptions,
  currentTtsTargetLanguage,
  stableSampleInfo,
  ttsBackendOptions,
  renderTtsSettings,
} from './tts.js';

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
  const promptText = String(state.voiceLibraryPrompts[gender] || '');

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
  );
  const awaiting = state.voiceLibraryAwaitingFirstPlayback;
  const awaitingHere = !!awaiting && awaiting.tag === tag && awaiting.gender === gender;
  const decisionReady = info.has_pending && !awaitingHere && !busy;
  fragment.append(_voiceLibraryActions({
    busy,
    info,
    hasReferenceText: langStatus.has_reference_text,
    hasEngine: Boolean(engine),
    decisionReady,
  }));
  if (decisionReady) {
    fragment.append(_voiceLibraryDecisionRibbon());
  }
  fragment.append(
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
  const label = document.createElement('span');
  label.className = 'voice-library-status-label';
  label.textContent = 'Current sample';
  const value = document.createElement('div');
  value.className = 'voice-library-status-value';
  const text = document.createElement('span');
  text.className = 'voice-library-status-text';
  text.textContent = _voiceLibraryStatusValueText(info);
  value.append(text);
  if (info?.exists) {
    value.append(_voiceLibraryPlayButton({
      action: 'play',
      title: 'Play current sample',
      ariaLabel: 'Play current sample',
    }));
  }
  line.append(label, value);
  return line;
}

function _voiceLibraryStatusValueText(info) {
  if (!info?.exists) return 'never';
  if (!info?.generated_at) return 'unknown time';
  try {
    const stamp = new Date(info.generated_at);
    if (!Number.isNaN(stamp.getTime())) {
      return stamp.toLocaleString([], {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    }
  } catch (_) {}
  return 'unknown time';
}

function _voiceLibraryPlayButton({ action, title, ariaLabel }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tts-play-button';
  button.dataset.voiceLibraryAction = action;
  button.setAttribute('aria-label', ariaLabel);
  button.title = title;
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>'
    + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
    + '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
    + '</svg>';
  return button;
}

function _voiceLibraryActions({ busy, info, hasReferenceText, hasEngine, decisionReady }) {
  const wrap = document.createElement('div');
  wrap.className = 'voice-library-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tts-inspect-button';
  // Two modes for the same button:
  // - decisionReady: pending exists AND the user has heard it once →
  //   morph to "Replay just generated"; the Keep/Don't keep ribbon is
  //   the only way forward from here.
  // - otherwise: regular Generate / Regenerate. During the initial
  //   auto-playback the button stays as Regenerate (clickable) so the
  //   user can interrupt and try again without sitting out the audio.
  if (decisionReady) {
    button.dataset.voiceLibraryAction = 'play-just-generated';
    button.classList.add('voice-library-action-replay');
    button.append(document.createTextNode('Replay just generated'));
    button.append(_voiceLibrarySpeakerIcon());
    button.disabled = busy;
  } else {
    button.dataset.voiceLibraryAction = 'generate';
    if (busy) {
      button.textContent = 'Generating…';
    } else if (info.exists || info.has_pending) {
      button.textContent = 'Regenerate';
    } else {
      button.textContent = 'Generate';
    }
    button.disabled = busy || !hasReferenceText || !hasEngine;
    if (!hasReferenceText) button.title = 'No reference text for this language';
    else if (!hasEngine) button.title = 'Load a VoxCPM engine to generate samples';
  }
  wrap.append(button);
  return wrap;
}

function _voiceLibrarySpeakerIcon() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('voice-library-action-icon');
  svg.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>'
    + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
    + '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
  return svg;
}

function _voiceLibraryDecisionRibbon() {
  const ribbon = document.createElement('div');
  ribbon.className = 'voice-library-decision';
  const label = document.createElement('span');
  label.className = 'voice-library-decision-label';
  label.textContent = 'Just generated.';
  const dontKeep = document.createElement('button');
  dontKeep.type = 'button';
  dontKeep.className = 'tts-inspect-button voice-library-decision-discard';
  dontKeep.dataset.voiceLibraryAction = 'dont-keep';
  dontKeep.textContent = "Don't keep";
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'tts-inspect-button voice-library-decision-keep';
  keep.dataset.voiceLibraryAction = 'keep';
  keep.textContent = 'Keep';
  ribbon.append(label, dontKeep, keep);
  return ribbon;
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
    state.voiceLibraryAwaitingFirstPlayback = null;
  } else if (kind === 'gender') {
    state.voiceLibraryGender = value;
    state.voiceLibraryAwaitingFirstPlayback = null;
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
    if (info.exists) playStableSampleCurrent(tag, gender, info);
    return;
  }
  if (action === 'play-just-generated') {
    const info = stableSampleInfo(tag, gender);
    if (info.has_pending) playStableSamplePending(tag, gender, info);
    return;
  }
  if (action === 'keep') {
    handleKeepPendingStableSample(tag, gender);
    return;
  }
  if (action === 'dont-keep') {
    handleDiscardPendingStableSample(tag, gender);
  }
}

async function handleKeepPendingStableSample(tag, gender) {
  if (!tag || !gender || state.voiceLibraryBusyTag) return;
  _audioQueue?.stop();
  state.voiceLibraryAwaitingFirstPlayback = null;
  state.voiceLibraryBusyTag = `${tag}:${gender}`;
  renderVoiceLibraryPage();
  renderTtsSettings({ preserveScroll: true });
  try {
    const result = await api.keepPendingStableVoiceSample({ language: tag, gender });
    applyVoiceLibrarySampleResult(tag, gender, result);
  } catch (error) {
    state.status = 'error';
  } finally {
    state.voiceLibraryBusyTag = '';
    renderVoiceLibraryPage();
    renderTtsSettings({ preserveScroll: true });
  }
}

async function handleDiscardPendingStableSample(tag, gender) {
  if (!tag || !gender || state.voiceLibraryBusyTag) return;
  _audioQueue?.stop();
  state.voiceLibraryAwaitingFirstPlayback = null;
  state.voiceLibraryBusyTag = `${tag}:${gender}`;
  renderVoiceLibraryPage();
  renderTtsSettings({ preserveScroll: true });
  try {
    const result = await api.discardPendingStableVoiceSample({ language: tag, gender });
    applyVoiceLibrarySampleResult(tag, gender, result);
  } catch (error) {
    state.status = 'error';
  } finally {
    state.voiceLibraryBusyTag = '';
    renderVoiceLibraryPage();
    renderTtsSettings({ preserveScroll: true });
  }
}

function applyVoiceLibrarySampleResult(tag, gender, result) {
  const resolvedGender = String(result?.gender || gender);
  if (!result?.info || typeof result.info !== 'object') return;
  const existing = state.voiceLibraryStable[tag] || { has_reference_text: false, samples: {} };
  state.voiceLibraryStable = {
    ...state.voiceLibraryStable,
    [tag]: {
      ...existing,
      samples: { ...(existing.samples || {}), [resolvedGender]: result.info },
    },
  };
}

function playStableSampleCurrent(tag, gender, info, options = {}) {
  if (!tag || !gender || !info?.exists || !_audioQueue) return;
  const cacheBust = encodeURIComponent(info.generated_at || String(Date.now()));
  const url = `/api/voice-library/stable/${encodeURIComponent(tag)}/${encodeURIComponent(gender)}/audio.wav?t=${cacheBust}`;
  _audioQueue.clear();
  _audioQueue.enqueue({
    url,
    duration_ms: 0,
    replay: true,
    onComplete: typeof options.onComplete === 'function' ? options.onComplete : null,
  });
}

function playStableSamplePending(tag, gender, info, options = {}) {
  if (!tag || !gender || !info?.has_pending || !_audioQueue) return;
  const cacheBust = encodeURIComponent(info.pending_generated_at || String(Date.now()));
  const url = `/api/voice-library/stable/${encodeURIComponent(tag)}/${encodeURIComponent(gender)}/audio.pending.wav?t=${cacheBust}`;
  _audioQueue.clear();
  _audioQueue.enqueue({
    url,
    duration_ms: 0,
    replay: true,
    onComplete: typeof options.onComplete === 'function' ? options.onComplete : null,
  });
}

export function applyVoiceLibraryStatus(stable) {
  const envelope = stable && typeof stable === 'object' ? stable : {};
  const languages = envelope.languages && typeof envelope.languages === 'object' ? envelope.languages : {};
  const prompts = envelope.prompts && typeof envelope.prompts === 'object' ? envelope.prompts : {};
  const next = {};
  for (const [tag, entry] of Object.entries(languages)) {
    next[String(tag).toLowerCase()] = entry && typeof entry === 'object'
      ? {
        has_reference_text: Boolean(entry.has_reference_text),
        reference_text: String(entry.reference_text || ''),
        samples: entry.samples && typeof entry.samples === 'object' ? entry.samples : {},
      }
      : { has_reference_text: false, reference_text: '', samples: {} };
  }
  state.voiceLibraryStable = next;
  state.voiceLibraryPrompts = {
    female: String(prompts.female || ''),
    male: String(prompts.male || ''),
  };
}

async function handleGenerateStableSample(tag, gender, engine) {
  if (!tag || !gender || !engine || state.voiceLibraryBusyTag) return;
  // If the previous auto-playback is still running, stop it so the user
  // doesn't have to sit through audio they've already decided to reject.
  _audioQueue?.stop();
  state.voiceLibraryAwaitingFirstPlayback = null;
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
      // The new sample sits in the pending slot until the user picks
      // Keep or Don't keep. Auto-play it so they hear what they're
      // judging; the action button + Keep/Don't keep ribbon only appear
      // once that initial playback completes (handled in the onComplete
      // callback below).
      state.voiceLibraryAwaitingFirstPlayback = { tag, gender: resolvedGender };
      playStableSamplePending(tag, resolvedGender, result.info, {
        onComplete: () => signalVoiceLibraryFirstPlaybackDone(tag, resolvedGender),
      });
    }
  } catch (error) {
    state.status = 'error';
  } finally {
    state.voiceLibraryBusyTag = '';
    renderVoiceLibraryPage();
    renderTtsSettings({ preserveScroll: true });
  }
}

export function voiceLibraryOnExit() {
  // Called when the user leaves the voice library sheet, either by
  // navigating to another settings page or closing the sheet entirely.
  // Two cleanups: stop any audio that was playing (current or
  // just-generated preview), and discard any undecided pending sample
  // (treat it as Don't keep so it can't outlive the user's session
  // on this page).
  if (_audioQueue) {
    _audioQueue.stop();
  }
  state.voiceLibraryAwaitingFirstPlayback = null;
  const tag = state.voiceLibraryLanguageTag;
  const gender = state.voiceLibraryGender;
  if (!tag || !gender) return;
  const info = stableSampleInfo(tag, gender);
  if (!info?.has_pending) return;
  // Fire-and-forget: discard server-side. Drop the pending fields from
  // the local snapshot immediately so the next render is consistent.
  api.discardPendingStableVoiceSample({ language: tag, gender }).catch(() => {
    // Best-effort cleanup — if the call fails the pending file lingers
    // on disk; the next generate overwrites it anyway.
  });
  const langState = state.voiceLibraryStable[tag];
  const sample = langState?.samples?.[gender];
  if (sample) {
    const cleared = { ...sample, has_pending: false, pending_generated_at: null };
    state.voiceLibraryStable = {
      ...state.voiceLibraryStable,
      [tag]: {
        ...langState,
        samples: { ...langState.samples, [gender]: cleared },
      },
    };
  }
}

function signalVoiceLibraryFirstPlaybackDone(tag, gender) {
  // Auto-playback of the just-generated pending sample has finished.
  // Drop the "awaiting" flag so the Replay-just-generated morph button
  // and the Keep/Don't keep ribbon appear. Only re-render if the user
  // is still on the same cell — otherwise we just clear the flag.
  if (
    state.voiceLibraryAwaitingFirstPlayback?.tag === tag
    && state.voiceLibraryAwaitingFirstPlayback?.gender === gender
  ) {
    state.voiceLibraryAwaitingFirstPlayback = null;
  }
  if (state.voiceLibraryLanguageTag !== tag || state.voiceLibraryGender !== gender) return;
  renderVoiceLibraryPage();
}

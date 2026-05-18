// Transcript rendering: source/target panes, bubble layout, speak-button
// affordances, autofollow scrolling, payload normalisation.
//
// audioQueue is owned by app.js (wired to its lifecycle callbacks). The
// stop-button on a playing bubble needs to call .stop() on it; setter
// pattern avoids a cyclic import.

import { state } from '../state.js';
import { els } from '../els.js';
import {
  codeForLanguage,
  normalizeLanguageName,
} from '../shared/languages.js';
import {
  LANE_IDS,
  TURN_STATES,
  SESSION_STATES,
} from '../shared/constants.js';
import {
  currentLane,
  currentLaneId,
  ensureLane,
  createLocalTurn,
} from '../shared/lanes.js';

let _audioQueue = null;
export function setAudioQueue(queue) {
  _audioQueue = queue;
}

export function handleTargetTextClick(event) {
  const button = event.target?.closest?.('.bubble-speak-button');
  if (button && els.targetText.contains(button)) {
    handleBubbleAudioAction(button, button.closest('.turn-part'));
    return;
  }
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    const row = event.target?.closest?.('.turn-part.is-replayable');
    if (row && els.targetText.contains(row)) {
      const innerButton = row.querySelector('.bubble-speak-button');
      if (innerButton) handleBubbleAudioAction(innerButton, row);
    }
  }
}

function handleBubbleAudioAction(button, bubble) {
  const action = button.dataset.audioAction || 'replay';
  if (action === 'stop') {
    flashReplayBubble(bubble);
    _audioQueue?.stop();
    return;
  }
  flashReplayBubble(bubble);
  triggerReplayFromButton(button);
}

function flashReplayBubble(bubble) {
  if (!bubble) return;
  bubble.classList.add('is-replay-flash');
  setTimeout(() => bubble.classList.remove('is-replay-flash'), 200);
}

function triggerReplayFromButton(button) {
  const text = String(button.dataset.replayText || '').trim();
  const laneId = String(button.dataset.replayLane || '').trim();
  if (!text || !laneId) return;
  if (state.sessionState !== SESSION_STATES.RUNNING) return;
  if (!state.ttsSettings.enabled) return;
  state.socket?.replayTts({ laneId, text });
}

export function renderTranscript() {
  renderTurnStream(els.sourceText, state.currentTurn.parts, 'source', state.currentTurn.sourceText);
  renderTurnStream(els.targetText, state.currentTurn.parts, 'target', state.currentTurn.targetText);
  renderDirectionLabels(currentLane());
  pinToBottomIfFollowing(els.sourceText);
  pinToBottomIfFollowing(els.targetText);
}

function renderDirectionLabels(lane) {
  els.turnSourceLanguage.textContent = codeForLanguage(lane.sourceLanguage);
  els.turnTargetLanguage.textContent = codeForLanguage(lane.targetLanguage);
  els.turnSourceLanguage.title = lane.sourceLanguage;
  els.turnTargetLanguage.title = lane.targetLanguage;
}

function renderTurnStream(el, parts, role, fallbackText) {
  const fragment = document.createDocumentFragment();
  for (const part of parts || []) {
    const committedText = role === 'source' ? part.sourceCommittedText : part.targetCommittedText;
    const previewText = role === 'source' ? part.sourcePreviewText : part.targetPreviewText;
    if (!visibleText(committedText, previewText)) continue;
    const row = document.createElement('div');
    row.className = 'turn-part';
    if (part.speechState === 'spoken') row.classList.add('is-spoken');
    if (part.speechState === 'speaking') row.classList.add('is-speaking');
    if (role === 'target' && part.lowQualityReference) row.classList.add('is-low-quality-ref');
    renderTextStream(row, committedText, previewText);
    if (role === 'target' && state.ttsSettings.enabled) {
      const replayText = String(committedText || '').trim();
      const playing = state.audioPlayback;
      const isStopForThis = Boolean(
        playing && (
          (!playing.replay && part.speechState === 'speaking')
          || (playing.replay && part.speechState === 'spoken' && replayText && replayText === String(playing.replayText || ''))
        ),
      );
      if (isStopForThis) {
        row.classList.add('is-replayable');
        row.classList.add('is-playing-audio');
        row.append(createBubbleSpeakButton(replayText, state.currentTurn.laneId, 'stop'));
      } else if (part.speechState === 'spoken' && replayText) {
        row.classList.add('is-replayable');
        row.append(createBubbleSpeakButton(replayText, state.currentTurn.laneId, 'replay'));
      }
    }
    fragment.append(row);
  }
  if (!fragment.childNodes.length && fallbackText) {
    const row = document.createElement('div');
    row.className = 'turn-part';
    row.textContent = String(fallbackText || '');
    fragment.append(row);
  }
  if (!fragment.childNodes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = String(el.dataset.empty || '');
    fragment.append(empty);
  }
  el.replaceChildren(fragment);
}

function createBubbleSpeakButton(text, laneId, mode = 'replay') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bubble-speak-button';
  button.dataset.replayText = text;
  button.dataset.replayLane = laneId;
  if (mode === 'stop') {
    button.classList.add('is-stop');
    button.dataset.audioAction = 'stop';
    button.setAttribute('aria-label', 'Stop playback');
    button.title = 'Stop';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="10"/>'
      + '<rect x="9" y="9" width="6" height="6" rx="1"/>'
      + '</svg>';
  } else {
    button.dataset.audioAction = 'replay';
    button.setAttribute('aria-label', 'Speak');
    button.title = 'Speak';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>'
      + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
      + '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
      + '</svg>';
  }
  return button;
}

function renderTextStream(el, committed, preview) {
  const committedText = String(committed || '');
  const previewText = previewSuffixText(committedText, preview);
  if (!committedText && !previewText) {
    el.replaceChildren();
    return;
  }
  const committedSpan = document.createElement('span');
  committedSpan.className = 'text-committed';
  committedSpan.textContent = committedText;
  const previewSpan = document.createElement('span');
  previewSpan.className = 'text-preview';
  previewSpan.textContent = previewText;
  el.replaceChildren(committedSpan, previewSpan);
}

export function normalizeTurnPayload(payload) {
  const fallback = createLocalTurn(currentLaneId(), state.lanes);
  const laneId = LANE_IDS.includes(payload?.lane_id) ? payload.lane_id : fallback.laneId;
  const lane = ensureLane(laneId);
  const parts = Array.isArray(payload?.parts) ? payload.parts.map(normalizeTurnPart) : [];
  const sourceText = String(payload?.source_text || joinPartText(parts, 'source') || '');
  const targetText = String(payload?.target_text || joinPartText(parts, 'target') || '');
  const speakableTargetText = String(payload?.speakable_target_text || joinSpeakableTargetText(parts) || '');
  return {
    turnId: String(payload?.turn_id || fallback.turnId),
    laneId,
    direction: String(payload?.direction || `${lane.sourceLanguage}->${lane.targetLanguage}`),
    state: String(payload?.state || TURN_STATES.OPEN_EMPTY),
    sourceLanguage: normalizeLanguageName(payload?.source_language || lane.sourceLanguage),
    targetLanguage: normalizeLanguageName(payload?.target_language || lane.targetLanguage),
    sourceText,
    targetText,
    speakableTargetText,
    canTranslateNow: Boolean(payload?.can_translate_now ?? joinTranslatableSourcePreviewText(parts)),
    canSpeakNow: Boolean(payload?.can_speak_now ?? speakableTargetText),
    parts,
  };
}

function normalizeTurnPart(part) {
  const sourceCommittedText = String(part?.source_committed_text || '');
  const sourcePreviewText = String(part?.source_preview_text || '');
  const targetCommittedText = String(part?.target_committed_text || '');
  const targetPreviewText = String(part?.target_preview_text || '');
  return {
    partId: String(part?.part_id || ''),
    speechState: String(part?.speech_state || 'pending'),
    sourceCommittedText,
    sourcePreviewText,
    sourceText: String(part?.source_text || visibleText(sourceCommittedText, sourcePreviewText)),
    targetCommittedText,
    targetPreviewText,
    targetText: String(part?.target_text || visibleText(targetCommittedText, targetPreviewText)),
    lowQualityReference: Boolean(part?.low_quality_reference),
  };
}

function joinPartText(parts, role) {
  return (parts || [])
    .map((part) => role === 'source' ? part.sourceText : part.targetText)
    .filter(Boolean)
    .join('\n\n');
}

function joinSpeakableTargetText(parts) {
  return (parts || [])
    .filter((part) => part.speechState !== 'spoken')
    .map((part) => part.targetText)
    .filter(Boolean)
    .join('\n\n');
}

function joinTranslatableSourcePreviewText(parts) {
  return (parts || [])
    .filter((part) => part.speechState !== 'spoken')
    .map((part) => part.sourcePreviewText)
    .filter(Boolean)
    .join('\n\n');
}

function visibleText(committed, preview) {
  const left = String(committed || '').trim();
  const right = String(preview || '').trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

function previewSuffixText(committed, preview) {
  const left = String(committed || '');
  const right = String(preview || '').trim();
  if (!right) return '';
  return /\s$/.test(left) || !left ? right : ` ${right}`;
}

export function setupAutoFollow(el) {
  if (!el) return;
  enableAutoFollow(el);
  updateClipTop(el);
  el.addEventListener('scroll', () => {
    el.dataset.autofollow = isNearBottom(el) ? 'on' : 'off';
    updateClipTop(el);
  });
}

function updateClipTop(el) {
  el.dataset.clipTop = el.scrollTop > 0 ? 'on' : 'off';
}

export function enableTranscriptAutoFollow() {
  enableAutoFollow(els.sourceText);
  enableAutoFollow(els.targetText);
}

function enableAutoFollow(el) {
  if (el) el.dataset.autofollow = 'on';
}

function pinToBottomIfFollowing(el) {
  if (!el || el.dataset.autofollow === 'off') return;
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    if (el.dataset.autofollow !== 'off') el.scrollTop = el.scrollHeight;
  });
}

function isNearBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
}

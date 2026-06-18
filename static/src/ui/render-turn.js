// Transcript rendering: source/target panes, bubble layout, speak-button
// affordances on replayable bubbles, target-text click dispatch.
//
// Data normalization (server-shape → turn shape) lives in domain/turns.js;
// auto-follow scroll behavior lives in ui/auto-follow.js.

import { state } from '../state.js';
import { els } from '../els.js';
import { codeForLanguage } from '../domain/languages.js';
import {
  TURN_STATES,
  APP_MODES,
} from '../shared/constants.js';
import { currentLane } from '../domain/lanes.js';
import { visibleText } from '../domain/turns.js';
import { audioQueue } from '../session/audio-queue.js';
import { pinToBottomIfFollowing } from './auto-follow.js';

export function handleTargetTextClick(event) {
  const button = event.target?.closest?.('.bubble-speak-button');
  if (button && els.targetText.contains(button)) {
    handleBubbleAudioAction(button, button.closest('.turn-part'));
    return;
  }
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    const row = event.target?.closest?.('.turn-part.is-replayable, .turn-part.is-speakable');
    if (row && els.targetText.contains(row)) {
      const innerButton = row.querySelector('.bubble-speak-button');
      if (innerButton) handleBubbleAudioAction(innerButton, row);
    }
  }
}

function handleBubbleAudioAction(button, bubble) {
  // Tapping an earlier bubble means the user wants to interact with it,
  // not be yanked back to the latest line by the next re-render. Pause
  // auto-follow until they manually scroll back to the bottom — the
  // existing scroll listener flips it back on when they do.
  if (els.targetText) els.targetText.dataset.autofollow = 'off';
  const action = button.dataset.audioAction || 'replay';
  if (action === 'stop') {
    flashReplayBubble(bubble);
    audioQueue.stop();
    return;
  }
  flashReplayBubble(bubble);
  if (action === 'speak') {
    triggerSpeakPartFromButton(button);
  } else {
    triggerReplayFromButton(button);
  }
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
  if (state.appMode !== APP_MODES.LIVE_RECORDING) return;
  if (!state.ttsSettings.enabled) return;
  state.socket?.replayTts({ laneId, text });
}

function triggerSpeakPartFromButton(button) {
  const partId = String(button.dataset.partId || '').trim();
  if (!partId) return;
  if (state.appMode !== APP_MODES.LIVE_RECORDING) return;
  if (!state.ttsSettings.enabled) return;
  state.socket?.speakPart(partId);
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
        row.append(createBubbleSpeakButton({ text: replayText, laneId: state.currentTurn.laneId, partId: part.partId, mode: 'stop' }));
      } else if (part.speechState === 'spoken' && replayText) {
        row.classList.add('is-replayable');
        row.append(createBubbleSpeakButton({ text: replayText, laneId: state.currentTurn.laneId, partId: part.partId, mode: 'replay' }));
      } else if (part.isClosed && part.speechState !== 'spoken' && replayText) {
        row.classList.add('is-speakable');
        row.append(createBubbleSpeakButton({ text: replayText, laneId: state.currentTurn.laneId, partId: part.partId, mode: 'speak' }));
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

function createBubbleSpeakButton({ text, laneId, partId, mode = 'replay' }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bubble-speak-button';
  button.dataset.replayText = text;
  button.dataset.replayLane = laneId;
  if (partId) button.dataset.partId = partId;
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
    button.dataset.audioAction = mode === 'speak' ? 'speak' : 'replay';
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

function previewSuffixText(committed, preview) {
  const left = String(committed || '');
  const right = String(preview || '').trim();
  if (!right) return '';
  return /\s$/.test(left) || !left ? right : ` ${right}`;
}

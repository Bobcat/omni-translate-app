import { iconMarkup } from '../../shared/icons.js';
import { populateLanguageSelect, recordLanguageMru } from '../../shared/languages.js';
import { micHaloVisual } from '../../../../src/shared/mic-level-visual.js';
import { createVoiceSession, visibleText } from './session.js?v=20260829-voice-modes-6';
import { visibleVoiceDirection } from './direction.js?v=20260829-voice-modes-6';
import { visibleVoiceCloningStatus } from './cloning-status.js?v=20260829-voice-modes-6';

// Voice translation view, wired to the same backend session flow as the
// mobile app (see ./session.js for the protocol state machine). Layout:
// language bar on top, source/target panes side by side, action bar below,
// status line at the bottom. The shell keeps this view alive across
// navigation, so a running session survives view switches; the sidebar
// entry is marked busy while the session is live.

export function createVoiceWorkflow() {
  const container = document.createElement('div');
  container.className = 'view voice-view';
  container.innerHTML = `
    <h1 class="visually-hidden">Voice translation</h1>
    <div class="view-toolbar voice-languagebar">
      <div class="language-pair">
        <button type="button" id="voiceSourceLanguage" aria-label="Choose source language"></button>
        <button type="button" class="language-swap" id="voiceSwapLanguages" aria-label="Swap direction" title="Swap direction">
          ${iconMarkup('swap')}
        </button>
        <button type="button" id="voiceTargetLanguage" aria-label="Choose target language"></button>
      </div>
      <div class="toolbar-actions">
        <span class="vad-badge" id="voiceVadBadge" hidden>Speech detected</span>
        <button type="button" class="icon-square-btn" id="voiceEndSession" aria-label="End session" title="End session" hidden>
          ${iconMarkup('x')}
        </button>
      </div>
    </div>
    <div class="voice-panes">
      <article class="pane source-pane">
        <div class="text-stream" id="voiceSourceText" data-empty="No speech recognized yet"></div>
      </article>
      <article class="pane target-pane">
        <div class="text-stream" id="voiceTargetText" data-empty="No translation yet"></div>
      </article>
    </div>
    <div class="voice-controls">
      <div class="voice-actionbar">
        <button type="button" class="action-round primary voice-mic-toggle" id="voiceMicToggle" aria-label="Start recording" title="Start recording">
          ${iconMarkup('mic', 'voice-mic-icon voice-mic-start-icon')}
          ${iconMarkup('stop-square', 'voice-mic-icon voice-mic-stop-icon')}
        </button>
      </div>
      <div class="voice-preferences">
        <fieldset class="voice-mode-field" id="voiceModeField">
          <legend class="visually-hidden">Translation voice</legend>
          <div class="voice-mode-options">
            <label class="voice-mode-option">
              <input type="radio" name="voiceMode" value="female">
              <span>Female</span>
            </label>
            <label class="voice-mode-option">
              <input type="radio" name="voiceMode" value="male">
              <span>Male</span>
            </label>
            <label class="voice-mode-option">
              <input type="radio" name="voiceMode" value="speaker_clone">
              <span>Clone speaker</span>
            </label>
          </div>
        </fieldset>
        <label class="field switch-field voice-auto-speak" for="voiceAutoSpeak">
          <span>Automatically speak translations</span>
          <span class="switch">
            <input id="voiceAutoSpeak" type="checkbox" role="switch">
            <span class="switch-slider" aria-hidden="true"></span>
          </span>
        </label>
        <p class="voice-cloning-status" id="voiceCloningStatus" role="status" hidden></p>
      </div>
      <div class="voice-runtime-status">
        <p class="status-line" id="voiceStatus" role="status"></p>
        <button type="button" class="resume-audio-btn" id="voiceResumeAudio" hidden>Resume audio</button>
      </div>
    </div>
  `;

  const sourcePill = container.querySelector('#voiceSourceLanguage');
  const targetPill = container.querySelector('#voiceTargetLanguage');
  const swapBtn = container.querySelector('#voiceSwapLanguages');
  const vadBadge = container.querySelector('#voiceVadBadge');
  const endSessionBtn = container.querySelector('#voiceEndSession');
  const sourceText = container.querySelector('#voiceSourceText');
  const targetText = container.querySelector('#voiceTargetText');
  const micToggleBtn = container.querySelector('#voiceMicToggle');
  const statusEl = container.querySelector('#voiceStatus');
  const autoSpeakInput = container.querySelector('#voiceAutoSpeak');
  const voiceModeField = container.querySelector('#voiceModeField');
  const voiceModeInputs = [...container.querySelectorAll('input[name="voiceMode"]')];
  const voiceCloningStatus = container.querySelector('#voiceCloningStatus');
  const resumeBtn = container.querySelector('#voiceResumeAudio');

  const session = createVoiceSession({
    onChange: render,
    onMicLevel: renderMicLevel,
    resumeButton: resumeBtn,
  });

  setupAutoFollow(sourceText);
  setupAutoFollow(targetText);

  populateLanguageSelect(sourcePill, session.state.sideALanguage);
  populateLanguageSelect(targetPill, session.state.sideBLanguage);

  sourcePill.addEventListener('change', () => {
    recordLanguageMru(sourcePill.value);
    session.setLanguage('source', sourcePill.value);
  });
  targetPill.addEventListener('change', () => {
    recordLanguageMru(targetPill.value);
    session.setLanguage('target', targetPill.value);
  });
  swapBtn.addEventListener('click', () => session.swap());
  endSessionBtn.addEventListener('click', () => session.endSession());
  micToggleBtn.addEventListener('click', () => session.toggleMic());
  autoSpeakInput.addEventListener('change', () => session.setAutoSpeak(autoSpeakInput.checked));
  for (const input of voiceModeInputs) {
    input.addEventListener('change', () => {
      if (input.checked) session.setVoiceMode(input.value);
    });
  }

  // Bubble actions (replay / speak / stop) on the target lane, one
  // delegated listener — same affordances as the mobile transcript.
  targetText.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.bubble-speak-button');
    if (!button || !targetText.contains(button)) return;
    // Interacting with an earlier bubble: don't yank the stream back to
    // the bottom on the next render.
    targetText.dataset.autofollow = 'off';
    const action = button.dataset.audioAction || 'replay';
    if (action === 'stop') {
      session.stopAudio({ preparing: button.classList.contains('is-preparing') });
      return;
    }
    if (action === 'speak') {
      session.speakPart(button.dataset.partId);
      return;
    }
    session.replayPart({ laneId: button.dataset.replayLane, partId: button.dataset.partId });
  });

  session.loadConfig();
  render();

  function render() {
    renderLanguageBar();
    renderPanes();
    renderButtons();
    renderAutoSpeak();
    renderVoiceMode();
    renderStatus();
  }

  function renderLanguageBar() {
    const { state } = session;
    const direction = visibleVoiceDirection(state);
    populateLanguageSelect(sourcePill, direction.sourceLanguage);
    populateLanguageSelect(targetPill, direction.targetLanguage);
    // Language choice is a setup-time decision; during a live session the
    // controls label the pair but stay locked.
    const locked = state.live || state.starting;
    sourcePill.disabled = locked;
    targetPill.disabled = locked;
    sourcePill.setAttribute('aria-label', `Source language: ${direction.sourceLanguage}`);
    targetPill.setAttribute('aria-label', `Target language: ${direction.targetLanguage}`);
    swapBtn.disabled = state.starting;
    vadBadge.hidden = !state.vadVisible;
    endSessionBtn.hidden = !state.live;
  }

  function renderPanes() {
    const turn = session.state.currentTurn;
    renderTurnStream(sourceText, turn.parts, 'source', turn.sourceText);
    renderTurnStream(targetText, turn.parts, 'target', turn.targetText);
    pinToBottomIfFollowing(sourceText);
    pinToBottomIfFollowing(targetText);
  }

  function renderTurnStream(el, parts, role, fallbackText) {
    const { state } = session;
    const fragment = document.createDocumentFragment();
    for (const part of parts || []) {
      const committedText = role === 'source' ? part.sourceCommittedText : part.targetCommittedText;
      const previewText = role === 'source' ? part.sourcePreviewText : part.targetPreviewText;
      if (!visibleText(committedText, previewText)) continue;
      const row = document.createElement('div');
      row.className = 'turn-part';
      if (part.speechState === 'spoken') row.classList.add('is-spoken');
      if (part.speechState === 'speaking') row.classList.add('is-speaking');
      renderTextStream(row, committedText, previewText);
      if (role === 'target' && state.ttsEnabled) {
        appendBubbleButton(row, part, committedText, previewText);
      }
      fragment.append(row);
    }
    if (!fragment.childNodes.length && fallbackText) {
      const row = document.createElement('div');
      row.className = 'turn-part';
      row.textContent = String(fallbackText || '');
      fragment.append(row);
    }
    el.replaceChildren(fragment);
  }

  // Stop / replay / speak affordance per bubble, ported from the mobile
  // render-turn logic: stop while this bubble's audio plays, replay once
  // spoken, speak-now for closed (or mic-off) unspoken bubbles.
  function appendBubbleButton(row, part, committedText, previewText) {
    const { state } = session;
    const replayText = String(committedText || '').trim();
    const speakText = visibleText(committedText, previewText);
    const canSpeakVisibleText = Boolean(speakText && (part.isClosed || state.micState === 'off'));
    const playing = state.audioPlayback;
    const isStopForThis = Boolean(
      playing && (
        (!playing.replay && part.speechState === 'speaking')
        || (playing.replay && part.speechState === 'spoken' && replayText && replayText === String(playing.replayText || ''))
      ),
    );
    if (isStopForThis) {
      row.classList.add('is-playing-audio');
      row.append(createBubbleButton({ mode: 'stop', text: replayText, partId: part.partId }));
    } else if (part.speechState === 'speaking') {
      row.classList.add('is-preparing-audio');
      row.append(createBubbleButton({ mode: 'preparing', text: speakText, partId: part.partId }));
    } else if (part.speechState === 'spoken' && replayText) {
      row.append(createBubbleButton({ mode: 'replay', text: replayText, partId: part.partId }));
    } else if (part.speechState !== 'spoken' && canSpeakVisibleText) {
      row.append(createBubbleButton({ mode: 'speak', text: speakText, partId: part.partId }));
    }
  }

  function createBubbleButton({ text, partId, mode }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bubble-speak-button';
    button.dataset.replayText = text;
    button.dataset.replayLane = session.state.currentTurn.laneId;
    if (partId) button.dataset.partId = partId;
    if (mode === 'stop') {
      button.classList.add('is-stop');
      button.dataset.audioAction = 'stop';
      button.setAttribute('aria-label', 'Stop playback');
      button.title = 'Stop';
      button.innerHTML = iconMarkup('stop');
    } else if (mode === 'preparing') {
      button.classList.add('is-preparing');
      button.dataset.audioAction = 'stop';
      button.setAttribute('aria-label', 'Stop preparing audio');
      button.title = 'Stop preparing audio';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="8"/>'
        + '<path d="M12 4a8 8 0 0 1 8 8"/>'
        + '</svg>';
    } else {
      button.dataset.audioAction = mode === 'speak' ? 'speak' : 'replay';
      button.setAttribute('aria-label', mode === 'speak' ? 'Speak' : 'Replay');
      button.title = mode === 'speak' ? 'Speak' : 'Replay';
      button.innerHTML = iconMarkup('volume-2');
    }
    return button;
  }

  function renderTextStream(row, committed, preview) {
    const committedText = String(committed || '');
    const previewText = previewSuffixText(committedText, preview);
    if (!committedText && !previewText) return;
    const committedSpan = document.createElement('span');
    committedSpan.className = 'text-committed';
    committedSpan.textContent = committedText;
    const previewSpan = document.createElement('span');
    previewSpan.className = 'text-preview';
    previewSpan.textContent = previewText;
    row.append(committedSpan, previewSpan);
  }

  function renderButtons() {
    const { state } = session;
    micToggleBtn.disabled = state.starting || (state.live && !state.socket?.isOpen());
    micToggleBtn.classList.toggle('is-listening', state.micState === 'listening');
    let micLabel = 'Start recording';
    if (state.starting && !state.live) micLabel = 'Connecting';
    else if (state.live) micLabel = state.micState === 'listening' ? 'Stop recording' : 'Start recording';
    micToggleBtn.setAttribute('aria-label', micLabel);
    micToggleBtn.title = micLabel;
  }

  function renderAutoSpeak() {
    autoSpeakInput.checked = Boolean(session.state.ttsAutoSpeak);
    autoSpeakInput.disabled = !session.state.ttsEnabled;
  }

  function renderVoiceMode() {
    const { state } = session;
    voiceModeField.hidden = !state.voiceModeAvailable;
    for (const input of voiceModeInputs) {
      input.checked = input.value === state.voiceMode;
      input.disabled = state.starting || !state.ttsEnabled || !state.voiceModeAvailable;
    }
    const visibleStatus = visibleVoiceCloningStatus(state, session.currentLaneId());
    voiceCloningStatus.classList.toggle('is-preparing', visibleStatus?.state === 'preparing');
    voiceCloningStatus.classList.toggle('is-ready', visibleStatus?.state === 'ready');
    voiceCloningStatus.textContent = visibleStatus?.text || '';
    voiceCloningStatus.hidden = !visibleStatus;
  }

  function renderMicLevel(value, listening) {
    const halo = micHaloVisual(value, { listening });
    micToggleBtn.style.setProperty('--mic-toggle-halo-scale', halo.scale);
    micToggleBtn.style.setProperty('--mic-toggle-halo-color', halo.color);
  }

  function renderStatus() {
    const { state } = session;
    let text = '';
    let isError = false;
    if (state.status === 'error') {
      text = state.statusMessage || 'Something went wrong.';
      isError = true;
    } else if (state.status === 'notice') {
      text = state.statusMessage;
    } else if (state.status === 'connecting') {
      text = 'Connecting…';
    } else if (state.audioStatus) {
      text = state.audioStatus;
    }
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  }

  return {
    view: container,
    toggleRecording: () => session.toggleMic(),
  };
}

function previewSuffixText(committed, preview) {
  const left = String(committed || '');
  const right = String(preview || '').trim();
  if (!right) return '';
  return /\s$/.test(left) || !left ? right : ` ${right}`;
}

// Scroll pinning per stream: follow new content unless the user scrolled
// up; scrolling back near the bottom re-arms following.
function setupAutoFollow(el) {
  el.dataset.autofollow = 'on';
  el.addEventListener('scroll', () => {
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.dataset.autofollow = nearBottom ? 'on' : 'off';
  });
}

function pinToBottomIfFollowing(el) {
  if (el.dataset.autofollow === 'off') return;
  el.scrollTop = el.scrollHeight;
}

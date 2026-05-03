import { api, SessionSocket } from './api-client.js';
import { AudioCapture } from './shared/audio-capture.js';
import { AudioQueue } from './shared/audio-playback.js';
import { languages } from './shared/languages.js';

const els = {
  listenButton: document.querySelector('#listenButton'),
  miniStatus: document.querySelector('#miniStatus'),
  sourceLanguageChip: document.querySelector('#sourceLanguageChip'),
  targetLanguageChip: document.querySelector('#targetLanguageChip'),
  sourceLanguageCode: document.querySelector('#sourceLanguageCode'),
  targetLanguageCode: document.querySelector('#targetLanguageCode'),
  sourcePaneMeta: document.querySelector('#sourcePaneMeta'),
  targetPaneMeta: document.querySelector('#targetPaneMeta'),
  settingsButton: document.querySelector('#settingsButton'),
  sourceText: document.querySelector('#sourceText'),
  sourcePreview: document.querySelector('#sourcePreview'),
  targetText: document.querySelector('#targetText'),
  targetPreview: document.querySelector('#targetPreview'),
  meaningCheck: document.querySelector('#meaningCheck'),
  meaningText: document.querySelector('#meaningText'),
  speakNowButton: document.querySelector('#speakNowButton'),
  swapButton: document.querySelector('#swapButton'),
  audioResumeButton: document.querySelector('#audioResumeButton'),
  ttsAudio: document.querySelector('#ttsAudio'),
  languageSheet: document.querySelector('#languageSheet'),
  languageSheetScrim: document.querySelector('#languageSheetScrim'),
  languageSheetClose: document.querySelector('#languageSheetClose'),
  languageSheetTitle: document.querySelector('#languageSheetTitle'),
  languageOptions: document.querySelector('#languageOptions'),
  settingsSheet: document.querySelector('#settingsSheet'),
  settingsSheetScrim: document.querySelector('#settingsSheetScrim'),
  settingsSheetClose: document.querySelector('#settingsSheetClose'),
  micPreGain: document.querySelector('#micPreGain'),
  micPreGainValue: document.querySelector('#micPreGainValue'),
  micAutoGainControl: document.querySelector('#micAutoGainControl'),
  micLevel: document.querySelector('.mic-level'),
  micLevelFill: document.querySelector('#micLevelFill'),
  audioSettingsReset: document.querySelector('#audioSettingsReset'),
};

const state = {
  socket: null,
  capture: null,
  config: null,
  listening: false,
  finalizing: false,
  sourceLanguage: 'Dutch',
  targetLanguage: 'English',
  languageSheetRole: null,
  sourceCommitted: '',
  sourcePreview: '',
  targetCommitted: '',
  targetPreview: '',
  audioStatus: '',
  status: 'idle',
  audioSettings: {
    preGain: 1,
    autoGainControl: false,
    inputLevel: 0,
  },
};

let audioQueue;

audioQueue = new AudioQueue({
  audio: els.ttsAudio,
  resumeButton: els.audioResumeButton,
  onStatus: (text) => {
    state.audioStatus = text;
    if (text) {
      els.miniStatus.textContent = text;
      if (text.startsWith('Speelt')) renderStatus('speaking');
    } else if (state.listening) {
      renderStatus('listening');
    } else if (!state.finalizing && state.status === 'speaking') {
      renderStatus('idle');
    }
    updateSpeakNowButton();
  },
});

init().catch((error) => {
  setStatus('error', error.message || String(error));
});

async function init() {
  state.config = await api.getConfig();
  setLanguage('source', state.config.translation?.source_language || 'Dutch', { updateMeta: true });
  setLanguage('target', state.config.translation?.target_language || 'English', { updateMeta: true });

  els.listenButton.addEventListener('click', () => {
    if (state.listening || state.finalizing) {
      pauseListening();
    } else {
      startListening();
    }
  });
  els.sourceLanguageChip.addEventListener('click', () => openLanguageSheet('source'));
  els.targetLanguageChip.addEventListener('click', () => openLanguageSheet('target'));
  els.swapButton.addEventListener('click', () => {
    swapDirection();
  });
  els.speakNowButton.addEventListener('click', speakNow);
  els.settingsButton.addEventListener('click', openSettingsSheet);
  els.micPreGain.addEventListener('input', handlePreGainInput);
  els.micAutoGainControl.addEventListener('change', handleAutoGainControlChange);
  els.audioSettingsReset.addEventListener('click', resetAudioSettings);
  els.languageSheetScrim.addEventListener('click', closeLanguageSheet);
  els.languageSheetClose.addEventListener('click', closeLanguageSheet);
  els.settingsSheetScrim.addEventListener('click', closeSettingsSheet);
  els.settingsSheetClose.addEventListener('click', closeSettingsSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeLanguageSheet();
    closeSettingsSheet();
  });

  renderLanguageChips();
  renderAudioSettings();
  updateSpeakNowButton();
  setStatus('idle', '');
}

async function startListening({ statusDetail = 'Verbinding openen' } = {}) {
  clearTranscript();
  setListenBusy(true);
  setStatus('connecting', statusDetail);
  try {
    const session = await api.createSession({
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
    });
    const socket = new SessionSocket(
      session.ws_url,
      handleMessage,
      () => {
        if (state.socket !== socket) return;
        if (state.finalizing) return;
        state.listening = false;
        renderAudioSettings();
        updateListenButton();
        setStatus('idle', '');
      },
    );
    await socket.connect();
    state.socket = socket;
    state.socket.startListening();
    state.listening = true;
    state.finalizing = false;
    state.capture = new AudioCapture({
      targetSampleRate: session.audio_input?.sample_rate_hz || 16000,
      chunkMs: 40,
      preGain: state.audioSettings.preGain,
      autoGainControl: state.audioSettings.autoGainControl,
      onChunk: (buffer) => state.socket?.sendAudio(buffer),
      onLevel: (level) => renderMicLevel(level),
    });
    await state.capture.start();
    renderAudioSettings();
    setStatus('listening', '');
  } catch (error) {
    state.listening = false;
    state.finalizing = false;
    cleanupClientSession();
    setStatus('error', error.message || String(error));
  } finally {
    setListenBusy(false);
    updateListenButton();
  }
}

function pauseListening() {
  if (!state.socket?.isOpen()) {
    cleanupClientSession();
    return;
  }
  state.finalizing = true;
  state.listening = false;
  state.capture?.stop();
  state.capture = null;
  renderMicLevel(0);
  renderAudioSettings();
  state.socket.pauseListening();
  setStatus('finalizing', 'Afronden');
  updateListenButton();
}

function speakNow() {
  if (audioQueue.hasAudio()) {
    audioQueue.playOrResume();
    return;
  }
  if (state.sourcePreview && state.socket?.speakNow()) {
    els.miniStatus.textContent = 'Vertalen';
    return;
  }
}

function swapDirection() {
  applyLanguageChange(() => {
    const previousSource = state.sourceLanguage;
    setLanguage('source', state.targetLanguage);
    setLanguage('target', previousSource);
  }, 'Richting wisselen');
  els.miniStatus.textContent = `${codeForLanguage(state.sourceLanguage)} -> ${codeForLanguage(state.targetLanguage)}`;
}

function handleMessage(msg) {
  if (msg.type === 'ready') {
    if (msg.source_language) setLanguage('source', msg.source_language, { updateMeta: true });
    if (msg.target_language) setLanguage('target', msg.target_language, { updateMeta: true });
    els.miniStatus.textContent = `${codeForLanguage(state.sourceLanguage)} -> ${codeForLanguage(state.targetLanguage)}`;
    return;
  }
  if (msg.type === 'direction_changed') {
    if (msg.source_language) setLanguage('source', msg.source_language, { updateMeta: true });
    if (msg.target_language) setLanguage('target', msg.target_language, { updateMeta: true });
    els.miniStatus.textContent = `${codeForLanguage(state.sourceLanguage)} -> ${codeForLanguage(state.targetLanguage)}`;
    return;
  }
  if (msg.type === 'state') {
    setStatus(msg.state || 'idle', statusLabel(msg.state));
    return;
  }
  if (msg.type === 'source_update') {
    state.sourceCommitted = applyCommittedDelta(state.sourceCommitted, msg);
    state.sourcePreview = msg.preview || '';
    els.sourceText.textContent = state.sourceCommitted;
    els.sourcePreview.textContent = state.sourcePreview;
    els.sourcePaneMeta.textContent = codeForLanguage(state.sourceLanguage);
    if (msg.committed_append) {
      els.miniStatus.textContent = 'Vertalen';
    }
    scrollToBottom(els.sourceText);
    updateSpeakNowButton();
    return;
  }
  if (msg.type === 'target_update') {
    state.targetCommitted = applyCommittedDelta(state.targetCommitted, msg);
    state.targetPreview = msg.preview || '';
    els.targetText.textContent = state.targetCommitted;
    els.targetPreview.textContent = state.targetPreview;
    els.targetPaneMeta.textContent = codeForLanguage(state.targetLanguage);
    if (msg.tts) {
      audioQueue.enqueue(msg.tts);
    } else if (msg.committed_append) {
      els.miniStatus.textContent = 'Vertaling klaar';
    }
    if (msg.tts_error) {
      els.miniStatus.textContent = msg.tts_error;
    }
    scrollToBottom(els.targetText);
    updateSpeakNowButton();
    return;
  }
  if (msg.type === 'asr_status') {
    if (msg.state === 'manual_commit') {
      els.miniStatus.textContent = 'Vertalen';
      return;
    }
    if (msg.state === 'manual_commit_skipped') {
      els.miniStatus.textContent = 'Nog geen tekst';
      return;
    }
    if (!els.miniStatus.textContent) {
      els.miniStatus.textContent = 'Spraak verwerken';
    }
    return;
  }
  if (msg.type === 'error') {
    setStatus('error', msg.message || msg.code || 'Fout');
    return;
  }
  if (msg.type === 'ended') {
    state.finalizing = false;
    state.listening = false;
    cleanupClientSession({ keepSocket: false });
    setStatus('idle', audioQueue.statusText());
    updateListenButton();
    updateSpeakNowButton();
  }
}

function applyCommittedDelta(current, msg) {
  const append = String(msg.committed_append || '');
  if (msg.reset) return append;
  if (!append) return current;
  if (!current) return append;
  if (current.endsWith(' ') || append.startsWith(' ') || append.startsWith('\n')) return current + append;
  return `${current} ${append}`;
}

function cleanupClientSession({ keepSocket = false } = {}) {
  state.capture?.stop();
  state.capture = null;
  renderMicLevel(0);
  renderAudioSettings();
  if (!keepSocket) {
    state.socket?.close();
    state.socket = null;
  }
}

function clearTranscript() {
  state.sourceCommitted = '';
  state.sourcePreview = '';
  state.targetCommitted = '';
  state.targetPreview = '';
  els.sourceText.textContent = '';
  els.sourcePreview.textContent = '';
  els.targetText.textContent = '';
  els.targetPreview.textContent = '';
  els.meaningText.textContent = '';
  els.meaningCheck.hidden = true;
  els.miniStatus.textContent = '';
  audioQueue.clear();
  updatePanelMetaForEmptyPanes();
  updateSpeakNowButton();
}

function setListenBusy(busy) {
  els.listenButton.disabled = Boolean(busy);
}

function updateListenButton() {
  renderStatus(state.finalizing ? 'finalizing' : state.listening ? 'listening' : state.status);
}

function updateSpeakNowButton() {
  const canCommitPreview = Boolean(state.sourcePreview && state.socket?.isOpen());
  const canPlayAudio = Boolean(audioQueue?.hasAudio());
  els.speakNowButton.disabled = !(canCommitPreview || canPlayAudio) || state.finalizing;
  els.speakNowButton.classList.toggle('is-busy', state.finalizing);
  if (state.finalizing) {
    els.speakNowButton.textContent = 'Afronden...';
  } else if (state.audioStatus.startsWith('Speelt')) {
    els.speakNowButton.textContent = 'Speelt...';
  } else if (canPlayAudio) {
    els.speakNowButton.textContent = 'Speel audio';
  } else if (canCommitPreview) {
    els.speakNowButton.textContent = 'Vertaal nu';
  } else if (state.listening) {
    els.speakNowButton.textContent = 'Wacht op tekst';
  } else {
    els.speakNowButton.textContent = 'Vertaal nu';
  }
}

function setStatus(status, detail) {
  state.status = String(status || 'idle').toLowerCase();
  renderStatus(state.status);
  els.miniStatus.textContent = detail || '';
  updateSpeakNowButton();
}

function renderStatus(status) {
  const normalized = String(status || 'idle').toLowerCase();
  els.listenButton.className = 'status-pill';
  if (normalized === 'listening') els.listenButton.classList.add('is-listening');
  if (normalized === 'finalizing') els.listenButton.classList.add('is-finalizing');
  if (normalized === 'speaking') els.listenButton.classList.add('is-speaking');
  if (normalized === 'error') els.listenButton.classList.add('is-error');
  els.listenButton.textContent = statusLabel(normalized);
}

function statusLabel(status) {
  const normalized = String(status || 'idle').toLowerCase();
  if (normalized === 'listening') return 'stop';
  if (normalized === 'finalizing') return 'wacht';
  if (normalized === 'connecting') return 'verbindt';
  if (normalized === 'speaking') return 'speelt';
  if (normalized === 'error') return 'fout';
  return 'start';
}

function openLanguageSheet(role) {
  state.languageSheetRole = role;
  els.languageSheetTitle.textContent = role === 'source' ? 'Kies brontaal' : 'Kies doeltaal';
  renderLanguageOptions(role);
  els.languageSheet.hidden = false;
}

function closeLanguageSheet() {
  els.languageSheet.hidden = true;
  state.languageSheetRole = null;
}

function renderLanguageOptions(role) {
  const current = role === 'source' ? state.sourceLanguage : state.targetLanguage;
  const recent = uniqueLanguages([current, 'English', 'Dutch', 'German']);
  const recentGroup = createLanguageGroup('Recent', recent, current, role);
  const allGroup = createLanguageGroup('Alle talen', languages.map((item) => item.name), current, role);
  els.languageOptions.replaceChildren(recentGroup, allGroup);
}

function createLanguageGroup(title, names, current, role) {
  const group = document.createElement('section');
  group.className = 'option-group';

  const heading = document.createElement('h3');
  heading.textContent = title;
  group.append(heading);

  for (const name of names) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'language-option';
    if (name === current) button.classList.add('is-selected');
    button.addEventListener('click', () => {
      closeLanguageSheet();
      if (name === current) return;
      applyLanguageChange(() => {
        setLanguage(role, name);
      }, 'Taal wisselen');
    });

    const label = document.createElement('span');
    label.textContent = name;
    const code = document.createElement('span');
    code.className = 'language-code';
    code.textContent = codeForLanguage(name);
    button.append(label, code);
    group.append(button);
  }

  return group;
}

function openSettingsSheet() {
  renderAudioSettings();
  els.settingsSheet.hidden = false;
}

function closeSettingsSheet() {
  els.settingsSheet.hidden = true;
}

function applyLanguageChange(applyChange, liveStatusText) {
  if (state.finalizing) {
    els.miniStatus.textContent = 'Wacht tot afronden klaar is';
    return;
  }
  applyChange();
  clearTranscript();
  if (state.socket?.setDirection({
    sourceLanguage: state.sourceLanguage,
    targetLanguage: state.targetLanguage,
  })) {
    els.miniStatus.textContent = liveStatusText;
    return;
  }
  updatePanelMetaForEmptyPanes();
}

function handlePreGainInput() {
  state.audioSettings.preGain = normalizePreGain(els.micPreGain.value);
  state.capture?.setPreGain(state.audioSettings.preGain);
  renderAudioSettings();
}

function handleAutoGainControlChange() {
  if (state.listening || state.finalizing) {
    renderAudioSettings();
    return;
  }
  state.audioSettings.autoGainControl = Boolean(els.micAutoGainControl.checked);
  renderAudioSettings();
}

function resetAudioSettings() {
  if ((state.listening || state.finalizing) && state.audioSettings.autoGainControl) return;
  state.audioSettings.preGain = 1;
  if (!state.listening && !state.finalizing) {
    state.audioSettings.autoGainControl = false;
  }
  state.capture?.setPreGain(state.audioSettings.preGain);
  renderAudioSettings();
}

function renderAudioSettings() {
  els.micPreGain.value = String(state.audioSettings.preGain);
  els.micPreGainValue.textContent = `${state.audioSettings.preGain.toFixed(1)}x`;
  els.micAutoGainControl.checked = state.audioSettings.autoGainControl;
  els.micAutoGainControl.disabled = state.listening || state.finalizing;
  els.audioSettingsReset.disabled = Boolean((state.listening || state.finalizing) && state.audioSettings.autoGainControl);
  renderMicLevel(state.audioSettings.inputLevel);
}

function renderMicLevel(value) {
  const level = normalizeLevel(value);
  state.audioSettings.inputLevel = level;
  const percent = Math.round(level * 100);
  els.micLevelFill.style.transform = `scaleX(${level.toFixed(3)})`;
  els.micLevel.setAttribute('aria-valuenow', String(percent));
  els.micLevel.classList.toggle('is-hot', level >= 0.9);
}

function normalizePreGain(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0.5, Math.min(3.0, numeric)) : 1;
}

function normalizeLevel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

function setLanguage(role, value, { updateMeta = false } = {}) {
  const fallback = languages[0]?.name || 'English';
  const next = languages.some((item) => item.name === value) ? value : fallback;
  if (role === 'source') {
    state.sourceLanguage = next;
  } else {
    state.targetLanguage = next;
  }
  renderLanguageChips();
  if (updateMeta) updatePanelMetaForEmptyPanes();
}

function renderLanguageChips() {
  els.sourceLanguageCode.textContent = codeForLanguage(state.sourceLanguage);
  els.targetLanguageCode.textContent = codeForLanguage(state.targetLanguage);
  els.sourceLanguageChip.setAttribute('aria-label', `Brontaal: ${state.sourceLanguage}`);
  els.targetLanguageChip.setAttribute('aria-label', `Doeltaal: ${state.targetLanguage}`);
}

function updatePanelMetaForEmptyPanes() {
  if (!state.sourceCommitted && !state.sourcePreview) {
    els.sourcePaneMeta.textContent = codeForLanguage(state.sourceLanguage);
  }
  if (!state.targetCommitted && !state.targetPreview) {
    els.targetPaneMeta.textContent = codeForLanguage(state.targetLanguage);
  }
}

function codeForLanguage(name) {
  const match = languages.find((item) => item.name === name);
  return (match?.asr || String(name || '').slice(0, 2)).toUpperCase();
}

function uniqueLanguages(names) {
  return names.filter((name, index) => names.indexOf(name) === index && languages.some((item) => item.name === name));
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

// Entrypoint: bootstraps initial state from /api/config, wires up DOM
// event listeners, kicks off the first render. All concerns live in
// dedicated modules under session/, settings/, ui/, domain/, shared/.

import { api } from './api-client.js';
import { mergeSettings } from './shared/utils.js';
import { DEFAULT_TUNING_SETTINGS } from './shared/constants.js';
import { els } from './els.js';
import { state } from './state.js';
import { audioQueue } from './session/audio-queue.js';
import {
  applyTtsConfig,
  mergeStoredTtsConfigIntoState,
  handleTtsBackendChange,
  handleTtsSettingChange,
  handleTtsSettingsClick,
  renderTtsSettings,
  setTtsAudioQueue,
} from './settings/tts.js';
import {
  setAudioQueue,
  handleVoiceLibraryChange,
  handleVoiceLibraryClick,
  applyVoiceLibraryStatus,
} from './settings/voice-library.js';
import {
  renderTuningSettings,
  handleTuningSettingChange,
} from './settings/tuning.js';
import {
  openSettingsSheet,
  closeSettingsSheet,
  navigateSettingsPage,
  handleSettingsBack,
} from './settings/sheet.js';
import {
  renderAudioSettings,
  handlePreGainInput,
  handleAutoGainControlChange,
  handleAutoOffSilenceChange,
  handleAutoOffAfterBubbleChange,
  handleAutoOffCueChange,
  resetAudioSettings,
} from './settings/audio.js';
import {
  handleClearAppStorage,
  handleDevToolsShowControlsChange,
  handleInstallApp,
  updateInstallRow,
  renderHistorySettings,
} from './settings/dev-tools.js';
import { bindImageRenderControls, renderImageRenderControls } from './settings/image-render.js';
import {
  setStatus,
  renderLifecycle,
  renderLanguageControls,
} from './ui/render-status.js';
import { updateActionButtons } from './ui/action-buttons.js';
import {
  setLanguagePickHandler,
  openLanguageSheet,
  closeLanguageSheet,
  onLanguageSheetViewportResize,
  initLanguageSheetSearch,
} from './ui/language-sheet.js';
import { setupSheetSwipeClose } from './ui/sheets.js';
import {
  renderTranscript,
  handleTargetTextClick,
} from './ui/render-turn.js';
import { setupAutoFollow } from './ui/auto-follow.js';
import {
  handleStartButton,
  handleMicToggle,
  finishSession,
  exportPcTranscript,
  setViewMode,
  startFromSettings,
  handlePopstateBack,
} from './session/lifecycle.js';
import {
  handleImageFileChange,
  setImageDisplayMode,
  finishImageTranslation,
  renderImageTranslation,
} from './image/lifecycle.js';
import {
  speakNow,
  translateNow,
  swapDirection,
  setVisibleLanguage,
  swapSetupLanguages,
} from './session/actions.js';
import { handleSetupFixtureClick } from './session/fixture-player.js';

setAudioQueue(audioQueue);
setTtsAudioQueue(audioQueue);

init().catch(() => {
  setStatus('error');
});

async function init() {
  // Paint the language pills before the network request so they show
  // the right values from the start (state.js already initialised them
  // from localStorage / educated guess). Without this, the pills sit
  // empty until /api/config returns.
  renderLanguageControls();
  const config = await api.getConfig();
  state.audioInputSampleRate = config.audio_input?.sample_rate_hz || 16000;
  state.tuningSettings = mergeSettings(DEFAULT_TUNING_SETTINGS, config.live_settings || {});
  applyTtsConfig(config.tts || {});
  mergeStoredTtsConfigIntoState();
  applyVoiceLibraryStatus(config.voice_library?.stable || {});

  els.startButton.addEventListener('click', handleStartButton);
  els.imageFileInput.addEventListener('change', handleImageFileChange);
  els.cameraFileInput.addEventListener('change', handleImageFileChange);
  els.imageOriginalButton.addEventListener('click', () => setImageDisplayMode('original'));
  els.imageTranslatedButton.addEventListener('click', () => setImageDisplayMode('translated'));
  els.micToggleButton.addEventListener('click', handleMicToggle);
  els.pcExportButton.addEventListener('click', exportPcTranscript);
  els.turnModeButton?.addEventListener('click', () => setViewMode('turn'));
  els.sourceLanguagePill.addEventListener('click', () => openLanguageSheet('source'));
  els.targetLanguagePill.addEventListener('click', () => openLanguageSheet('target'));
  els.languageSheetScrim.addEventListener('click', closeLanguageSheet);
  els.closeLanguageSheetButton.addEventListener('click', closeLanguageSheet);
  initLanguageSheetSearch();
  window.visualViewport?.addEventListener('resize', onLanguageSheetViewportResize);
  setLanguagePickHandler(setVisibleLanguage);
  els.languageDirectionButton.addEventListener('click', swapSetupLanguages);
  els.translateNowButton.addEventListener('click', translateNow);
  els.speakNowButton.addEventListener('click', speakNow);
  els.swapButton.addEventListener('click', swapDirection);
  els.settingsButton.addEventListener('click', openSettingsSheet);
  els.titlebarBackButton.addEventListener('click', () => {
    if (finishImageTranslation()) return;
    finishSession();
  });
  els.settingsBackButton.addEventListener('click', handleSettingsBack);
  els.settingsMicrophoneNav.addEventListener('click', () => navigateSettingsPage('microphone'));
  els.settingsAudioNav.addEventListener('click', () => navigateSettingsPage('audio'));
  els.settingsHistoryNav.addEventListener('click', () => navigateSettingsPage('history'));
  els.settingsDevToolsNav.addEventListener('click', () => navigateSettingsPage('dev-tools'));
  els.settingsTuningNav.addEventListener('click', () => navigateSettingsPage('tuning'));
  els.settingsVoiceLibraryNav.addEventListener('click', () => navigateSettingsPage('voice-library'));
  els.settingsImageRenderNav.addEventListener('click', () => navigateSettingsPage('image-render'));
  bindImageRenderControls();
  els.voiceLibraryControls.addEventListener('change', handleVoiceLibraryChange);
  els.voiceLibraryControls.addEventListener('click', handleVoiceLibraryClick);
  els.devToolsShowControls.addEventListener('change', handleDevToolsShowControlsChange);
  els.devToolsStorageReset.addEventListener('click', handleClearAppStorage);
  els.setupFixtureButton.addEventListener('click', handleSetupFixtureClick);
  els.installAppRow.addEventListener('click', () => handleInstallApp({ closeSettings: closeSettingsSheet }));
  els.settingsStartButton.addEventListener('click', startFromSettings);
  els.micPreGain.addEventListener('input', handlePreGainInput);
  els.micAutoGainControl.addEventListener('change', handleAutoGainControlChange);
  els.micAutoOffSilence?.addEventListener('change', handleAutoOffSilenceChange);
  els.micAutoOffAfterBubble?.addEventListener('change', handleAutoOffAfterBubbleChange);
  els.micAutoOffCue?.addEventListener('change', handleAutoOffCueChange);
  els.audioSettingsReset.addEventListener('click', resetAudioSettings);
  els.tuningSettingsGroups.addEventListener('change', handleTuningSettingChange);
  els.ttsBackendSelect.addEventListener('change', handleTtsBackendChange);
  els.ttsSettingsGroups.addEventListener('change', handleTtsSettingChange);
  els.ttsSettingsGroups.addEventListener('click', handleTtsSettingsClick);
  els.targetText.addEventListener('click', handleTargetTextClick);
  els.settingsSheetScrim.addEventListener('click', closeSettingsSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeSettingsSheet();
  });
  window.addEventListener('popstate', handlePopstateBack);
  setupSheetSwipeClose({
    layer: els.languageSheet,
    sheet: els.languageSheet.querySelector('.bottom-sheet'),
    scrollContainer: els.languageSheetList,
    onClose: closeLanguageSheet,
  });
  setupSheetSwipeClose({
    layer: els.settingsSheet,
    sheet: els.settingsSheet.querySelector('.bottom-sheet'),
    scrollContainer: els.settingsSheet.querySelector('.settings-views'),
    onClose: closeSettingsSheet,
    isAllowed: () => state.settingsPage === 'home',
  });
  if (history.state?.view === 'live_recording' || history.state?.view === 'image_translation') {
    history.replaceState({}, '');
  }

  renderLanguageControls();
  setupAutoFollow(els.sourceText);
  setupAutoFollow(els.targetText);
  renderTranscript();
  renderAudioSettings();
  renderTuningSettings();
  renderTtsSettings();
  renderHistorySettings();
  renderImageRenderControls();
  renderImageTranslation();
  updateActionButtons();
  renderLifecycle();
  setStatus('idle');
  updateInstallRow();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// The app's single mutable state object. Consumers import this singleton
// and read/write directly on it. No reactivity, no observers — render
// functions are invoked explicitly after writes.

import {
  SESSION_STATES,
  MIC_STATES,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_TUNING_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_TTS_OPTIONS,
} from './shared/constants.js';
import { cloneSettings } from './shared/utils.js';
import { buildLocalLanes, createLocalTurn } from './domain/lanes.js';
import { loadDevToolsSettings } from './domain/storage.js';

const initialLanes = buildLocalLanes('Dutch', 'English');

export const state = {
  socket: null,
  sessionId: null,
  capture: null,
  sideALanguage: 'Dutch',
  sideBLanguage: 'English',
  requestedStartLaneId: 'a_to_b',
  lanes: initialLanes,
  currentTurn: createLocalTurn('a_to_b', initialLanes),
  audioStatus: '',
  status: 'idle',
  sessionState: SESSION_STATES.SETUP,
  micState: MIC_STATES.OFF,
  pcExportBusy: false,
  audioInputSampleRate: 16000,
  viewMode: 'turn',
  captureMutedForPlayback: false,
  settingsPage: 'home',
  vadHintTimer: null,
  audioSettings: {
    preGain: DEFAULT_AUDIO_SETTINGS.preGain,
    autoGainControl: DEFAULT_AUDIO_SETTINGS.autoGainControl,
    autoGainControlBusy: false,
    inputLevel: 0,
    autoOffSilenceSeconds: DEFAULT_AUDIO_SETTINGS.autoOffSilenceSeconds,
    autoOffAfterBubble: DEFAULT_AUDIO_SETTINGS.autoOffAfterBubble,
    autoOffCueEnabled: DEFAULT_AUDIO_SETTINGS.autoOffCueEnabled,
  },
  // Runtime-only handles for the silence-based auto-off timer. Never
  // persisted; reset whenever the mic starts/stops.
  autoOffSilenceTimer: null,
  autoOffSilenceTimerDeadlineMono: 0,
  tuningSettings: cloneSettings(DEFAULT_TUNING_SETTINGS),
  tuningExpandedGroups: new Set(),
  ttsSettings: cloneSettings(DEFAULT_TTS_SETTINGS),
  devToolsSettings: loadDevToolsSettings(),
  ttsOptions: cloneSettings(DEFAULT_TTS_OPTIONS),
  ttsExpandedGroups: new Set(),
  ttsVoxcpm2SelectedTag: '',
  ttsPromptInspectOpen: false,
  ttsUpdateBusy: false,
  voiceLibraryStable: {},
  voiceLibraryPrompts: {},
  voiceLibraryBusyTag: '',
  voiceLibraryEngine: '',
  voiceLibraryLanguageTag: '',
  voiceLibraryGender: 'female',
  speakNowPending: false,
  speakNowPendingTimer: null,
  audioPlayback: null,
};

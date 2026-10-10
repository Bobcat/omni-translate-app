// Mobile settings and voice options, driven through the real app entry: the
// settings sheet's history behaviour (the dev-mode switch pops the entry a
// developer subpage pushed, so browser Back cannot return to a hidden page) and
// the voice options sheet (icon, voices, automatic speaking, cloning status).
//
// One file owns the app boot on purpose: the stubs are global, so two files
// booting the app would overwrite each other's DOM and history.
import test from 'node:test';
import assert from 'node:assert/strict';

// The sheet renders every settings page on open, so the stub has to tolerate
// any DOM call a renderer makes. Known state properties keep real values; every
// other property resolves to a no-op function. Registered listeners are kept so
// a test can fire the same event the browser would.
function makeElement(overrides = {}) {
  const listeners = new Map();
  const children = [];
  const target = {
    hidden: false,
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    scrollTop: 0,
    tabIndex: 0,
    dataset: {},
    children: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const registered = listeners.get(type) || [];
      const at = registered.indexOf(listener);
      if (at >= 0) registered.splice(at, 1);
    },
    fire(type, event = {}) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    parentElement: null,
    appendChild(node) { node.parentElement = this; children.push(node); return node; },
    append(...nodes) { for (const node of nodes) this.appendChild(node); },
    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.children;
      const at = siblings.indexOf(this);
      if (at >= 0) siblings.splice(at, 1);
      this.parentElement = null;
    },
    replaceChildren(...nodes) {
      children.length = 0;
      children.push(...nodes);
    },
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    closest: () => makeElement(),
    focus() {},
    replaceWith() {},
    ...overrides,
  };
  return new Proxy(target, {
    get(node, prop) {
      if (prop in node) return node[prop];
      if (typeof prop !== 'string') return undefined;
      return () => undefined;
    },
    set(node, prop, value) {
      node[prop] = value;
      return true;
    },
  });
}

function installBrowserStubs() {
  const elements = new Map();
  const elementFor = (selector) => {
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  };

  const stack = [{ state: null, url: 'https://example.test/' }];
  let index = 0;
  const listeners = new Map();
  const history = {
    get state() { return stack[index].state; },
    get index() { return index; },
    /** Settings entries pushed after the baseline page entry. */
    get entries() { return stack.slice(1).map((entry) => entry.state); },
    /** The entries the browser can still reach: everything up to now. */
    get reachable() { return stack.slice(1, index + 1).map((entry) => entry.state); },
    /** The entry the browser is currently on. */
    get current() { return stack[index].state; },
    reset() {
      stack.length = 1;
      index = 0;
      globalThis.window.location.href = stack[0].url;
    },
    pushState(state, _title, url) {
      stack.splice(index + 1);
      stack.push({ state, url: url || stack[index].url });
      index += 1;
    },
    replaceState(state, _title, url) {
      stack[index] = { state, url: url || stack[index].url };
      globalThis.window.location.href = stack[index].url;
    },
    back() {
      if (index === 0) return;
      index -= 1;
      queue(stack[index].state);
    },
    forward() {
      if (index >= stack.length - 1) return;
      index += 1;
      queue(stack[index].state);
    },
    go(delta) {
      const next = index + delta;
      if (next < 0 || next >= stack.length) return;
      index = next;
      queue(stack[index].state);
    },
  };

  // Browsers deliver popstate as a task, not inside history.back(); the sheet's
  // depth bookkeeping depends on that timing.
  function queue(state) {
    const payload = { state };
    queueMicrotask(() => dispatch(payload));
  }

  function dispatch(event) {
    for (const listener of listeners.get('popstate') || []) listener(event);
  }

  const serviceWorkerCalls = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      language: 'en-US',
      languages: ['en-US'],
      userAgent: 'node',
      standalone: false,
      serviceWorker: {
        register(url) {
          serviceWorkerCalls.push(url);
          return Promise.resolve();
        },
      },
    },
    configurable: true,
    writable: true,
  });
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.document = {
    querySelector: elementFor,
    querySelectorAll: () => [],
    // Created nodes live in the same registry as the queried ones, so a test
    // can inspect what the app built into a container.
    createElement: () => makeElement(),
    createDocumentFragment: () => makeElement(),
    addEventListener() {},
    documentElement: makeElement(),
    body: makeElement(),
  };
  globalThis.window = {
    location: { href: 'https://example.test/', search: '', pathname: '/', hash: '' },
    history,
    // Same map the history stub dispatches into: app.js registers its popstate
    // router here, and history.back() has to reach it.
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    visualViewport: null,
  };
  globalThis.history = history;
  return { history, elements, elementFor, store, serviceWorkerCalls };
}

const stubs = installBrowserStubs();
// The app's sheets start closed; handlePopstateBack checks the language sheet
// first and would swallow every event if it were left open.
stubs.elementFor('#languageSheet').hidden = true;
stubs.elementFor('#voiceOptionsSheet').hidden = true;
// Boot the real app entry so the Dev tools switch is wired exactly as shipped:
// app.js registers the settings router and the handler that reacts to the
// switch. Only the network call is stubbed.
globalThis.fetch = async (url) => {
  const body = String(url).includes('/api/config')
    ? {
      auth: { configured: false },
      tts: {
        backend: 'nanovllm_voxcpm',
        capabilities: { voice_selection: true },
        options: {
          backends: [
            { value: 'kokoro', label: 'Kokoro' },
            { value: 'nanovllm_voxcpm', label: 'NanoVLLM VoxCPM' },
          ],
        },
      },
    }
    : {};
  return {
    ok: true,
    status: 200,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
};
await import('../../static/src/app.js');
const sheet = await import('../../static/src/settings/sheet.js');
const { setDevMode } = await import('../../static/src/settings/dev-mode.js');
const { state } = await import('../../static/src/state.js');
const voiceOptions = await import('../../static/src/session/voice-options.js');
const { renderLifecycle } = await import('../../static/src/ui/render-status.js');
const { APP_MODES } = await import('../../static/src/shared/constants.js');
let sentTts = null;
const {
  openVoiceOptionsSheet,
  closeVoiceOptionsSheet,
  resetVoiceOptionsSheetHistory,
} = await import('../../static/src/ui/voice-options-sheet.js');
const { renderVoiceOptionsSheet } = await import('../../static/src/ui/voice-options-sheet.js');

test('closing the panel from its button keeps the session running', async () => {
  const { state: st } = { state };
  st.appMode = APP_MODES.LIVE_RECORDING;
  st.sessionId = null; // no socket: a stray finish must stay observable
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();
  assert.equal(stubs.history.current.view, 'voiceOptionsSheet');

  stubs.elementFor('#closeVoiceOptionsButton').fire('click');
  await settle();

  // The programmatic pop must not reach the router, which would end the session.
  assert.equal(voiceSheet().hidden, true);
  assert.equal(st.appMode, APP_MODES.LIVE_RECORDING, 'the session is still live');
  assert.equal(stubs.history.current.view, 'live_recording', 'no stale overlay entry');
});

test('closing the panel from the scrim keeps the session running', async () => {
  state.appMode = APP_MODES.LIVE_RECORDING;
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();

  stubs.elementFor('#voiceOptionsScrim').fire('click');
  await settle();

  assert.equal(voiceSheet().hidden, true);
  assert.equal(state.appMode, APP_MODES.LIVE_RECORDING);
  assert.equal(stubs.history.current.view, 'live_recording');
});

test('browser Back closes the panel without duplicating the session entry', async () => {
  state.appMode = APP_MODES.LIVE_RECORDING;
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  const before = stubs.history.reachable.map((entry) => entry?.view);
  openVoiceOptionsSheet();

  stubs.history.back();
  await settle();

  assert.equal(voiceSheet().hidden, true);
  assert.equal(state.appMode, APP_MODES.LIVE_RECORDING);
  assert.equal(stubs.history.current.view, 'live_recording');
  // Exactly the stack it started with: no second live entry was pushed.
  assert.deepEqual(stubs.history.reachable.map((entry) => entry?.view), before);

  // A further Back now reaches the session's own exit path.
  stubs.history.back();
  await settle();
  assert.equal(state.appMode, APP_MODES.SETUP);
});

test('a session teardown removes the overlay and the session entry', async () => {
  const { applySessionTeardown } = await import('../../static/src/session/lifecycle.js');
  state.appMode = APP_MODES.LIVE_RECORDING;
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();
  assert.equal(stubs.history.current.view, 'voiceOptionsSheet');

  applySessionTeardown();
  await settle();

  assert.equal(voiceSheet().hidden, true);
  assert.equal(state.appMode, APP_MODES.SETUP);
  assert.equal(stubs.history.current, null, 'back on the baseline entry');
});

test('the local finish action tears the session down on both socket states', async () => {
  const { finishSession } = await import('../../static/src/session/lifecycle.js');

  for (const socketOpen of [true, false]) {
    voiceOptions.resetVoiceOptions();
    state.appMode = APP_MODES.LIVE_RECORDING;
    state.sessionId = 'session-x';
    state.socket = socketOpen
      ? { isOpen: () => true, finishListening() {}, close() {} }
      : { isOpen: () => false, close() {} };
    openVoiceOptionsSheet();
    voiceOptions.applyVoiceSessionReady({
      voice_mode: 'speaker_clone',
      voice_cloning_status: { a_to_b: { state: 'preparing', fallback_voice_mode: 'male' } },
    });

    finishSession();
    await settle();

    const label = socketOpen ? 'open socket' : 'closed socket';
    assert.equal(voiceSheet().hidden, true, `${label}: panel closes`);
    assert.deepEqual(voiceOptions.voiceCloningStatus(), {}, `${label}: status clears`);
    assert.equal(state.appMode, APP_MODES.SETUP, `${label}: back to setup`);
  }
  state.socket = null;
});

test('a backend the server no longer offers disables the modes', () => {
  state.ttsCapabilities = { voice_selection: true };
  state.ttsSettings.backend = 'nanovllm_voxcpm';
  state.ttsOptions = { ...state.ttsOptions, backends: [{ value: 'kokoro' }] };

  assert.equal(voiceOptions.voiceModeAvailable(), false);
  assert.equal(voiceOptions.sessionVoiceMode(), null);

  // Offered again, the modes come back.
  state.ttsOptions = { ...state.ttsOptions, backends: [{ value: 'kokoro' }, { value: 'nanovllm_voxcpm' }] };
  assert.equal(voiceOptions.voiceModeAvailable(), true);
  assert.equal(voiceOptions.sessionVoiceMode(), 'female');
});

test('a server TTS echo refreshes the open panel', () => {
  state.ttsSettings.backend = 'nanovllm_voxcpm';
  state.ttsSettings.auto_speak = true;
  openVoiceOptionsSheet();
  assert.equal(stubs.elementFor('#voiceAutoSpeak').checked, true);

  // The server snapshot is authoritative: the switch has to follow it.
  state.ttsSettings = { ...state.ttsSettings, auto_speak: false };
  voiceOptions.notifyVoiceOptionsChanged();

  assert.equal(stubs.elementFor('#voiceAutoSpeak').checked, false);
});

test('Forward reopens the panel instead of ending the session', async () => {
  state.appMode = APP_MODES.LIVE_RECORDING;
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();
  stubs.elementFor('#closeVoiceOptionsButton').fire('click');
  await settle();
  assert.equal(state.appMode, APP_MODES.LIVE_RECORDING);
  assert.equal(voiceSheet().hidden, true);

  stubs.history.forward();
  await settle();

  assert.equal(state.appMode, APP_MODES.LIVE_RECORDING, 'the session survives Forward');
  assert.equal(voiceSheet().hidden, false, 'the panel reopens');
  assert.equal(stubs.history.current.view, 'voiceOptionsSheet');
});

test('Forward after browser Back also reopens the panel', async () => {
  state.appMode = APP_MODES.LIVE_RECORDING;
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();
  stubs.history.back();
  await settle();
  assert.equal(voiceSheet().hidden, true);

  stubs.history.forward();
  await settle();

  assert.equal(state.appMode, APP_MODES.LIVE_RECORDING);
  assert.equal(voiceSheet().hidden, false);
});

test('a stale Forward entry cannot reopen the panel after teardown', async () => {
  const { applySessionTeardown } = await import('../../static/src/session/lifecycle.js');
  state.appMode = APP_MODES.LIVE_RECORDING;
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();
  stubs.elementFor('#closeVoiceOptionsButton').fire('click');
  await settle();

  applySessionTeardown();
  await settle();
  assert.equal(state.appMode, APP_MODES.SETUP);

  stubs.history.forward();
  await settle();

  assert.equal(state.appMode, APP_MODES.SETUP, 'the session stays ended');
  assert.equal(voiceSheet().hidden, true, 'no session UI after teardown');
});

test('an empty offered-backend list disables the modes', () => {
  state.ttsCapabilities = { voice_selection: true };
  state.ttsSettings.backend = 'nanovllm_voxcpm';
  state.ttsOptions = { ...state.ttsOptions, backends: [] };

  assert.equal(voiceOptions.voiceModeAvailable(), false);
  assert.equal(voiceOptions.sessionVoiceMode(), null);
});

test('an older TTS echo does not reverse the latest automatic-speaking tap', async () => {
  const { handleMessage } = await import('../../static/src/session/messages.js');
  state.sessionId = 'session-echo';
  stubs.store.clear();

  // The user taps off, then on, before the first change comes back.
  voiceOptions.setAutoSpeak(false);
  voiceOptions.setAutoSpeak(true);

  // The echo for the first tap arrives: it must not flip the control.
  handleMessage({ type: 'tts_settings', session_id: 'session-echo', tts_settings: { auto_speak: false } });
  assert.equal(voiceOptions.autoSpeak(), true, 'the latest tap stands');

  // The echo for the second tap confirms it and clears the pending value.
  handleMessage({ type: 'tts_settings', session_id: 'session-echo', tts_settings: { auto_speak: true } });
  assert.equal(voiceOptions.autoSpeak(), true);

  // With nothing pending, the server is authoritative again.
  handleMessage({ type: 'tts_settings', session_id: 'session-echo', tts_settings: { auto_speak: false } });
  assert.equal(voiceOptions.autoSpeak(), false);

  state.sessionId = null;
});

test.after(() => {
  delete globalThis.requestAnimationFrame;
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.history;
  delete globalThis.navigator;
});

/** Let the queued popstate tasks run, draining anything a previous test left. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Wait until the app entry has run init() to its end, so no start-up render
 * can land in the middle of a test. Registering the service worker is its last
 * statement. */
async function appReady() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (stubs.serviceWorkerCalls.length) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('app.js never finished init()');
}

test.beforeEach(async () => {
  await settle();
  await appReady();
  // Each test starts from closed sheets, a clean history stack and no stored
  // dev-mode preference.
  stubs.store.clear();
  // Voice state is app state: a previous test must not decide what this one
  // starts from.
  state.socket = null;
  state.ttsSettings.enabled = true;
  state.ttsSettings.auto_speak = true;
  state.ttsSettings.backend = 'nanovllm_voxcpm';
  state.ttsCapabilities = { voice_selection: true };
  // The server's offered list, as /api/config reports it.
  state.ttsOptions = {
    ...state.ttsOptions,
    backends: [
      { value: 'kokoro', label: 'Kokoro' },
      { value: 'nanovllm_voxcpm', label: 'NanoVLLM VoxCPM' },
    ],
  };
  voiceOptions.resetVoiceOptions();
  stubs.history.reset();
  stubs.elements.get('#settingsSheet').hidden = true;
  stubs.elements.get('#languageSheet').hidden = true;
  stubs.elements.get('#voiceOptionsSheet').hidden = true;
  resetVoiceOptionsSheetHistory();
});

test('the Dev tools switch returns to the sheet root without pushing an entry', async () => {
  const pages = () => stubs.history.entries.map((entry) => entry.page);
  const devSwitch = stubs.elementFor('#devToolsDevMode');
  // The switch is only reachable with dev mode on; the URL flag is how it gets
  // turned on in the first place.
  setDevMode(true);

  sheet.openSettingsSheet('home');
  sheet.navigateSettingsPage('dev-tools');
  assert.deepEqual(pages(), ['home', 'dev-tools']);

  // Exactly what the browser does when the user clicks the switch off.
  devSwitch.checked = false;
  devSwitch.fire('change');
  await settle();

  // The hidden subpage's entry was popped, not replaced by a push, so Back
  // afterwards cannot land on it.
  assert.deepEqual(pages(), ['home', 'dev-tools']);
  assert.equal(stubs.history.current.page, 'home');
  assert.equal(state.settingsPage, 'home');
});

test('returning from Voice library to Dev tools runs the page-exit hook', async () => {
  setDevMode(true);

  const pages = () => stubs.history.entries.map((entry) => entry.page);
  sheet.openSettingsSheet('home');
  sheet.navigateSettingsPage('dev-tools');
  assert.deepEqual(pages(), ['home', 'dev-tools']);

  sheet.navigateSettingsPage('voice-library');
  // The exit hook clears this runtime marker; it is the observable effect of
  // the call, since an ES module export cannot be spied on directly.
  state.voiceLibraryAwaitingFirstPlayback = 'pending-sample';
  sheet.handleSettingsBack();
  await settle();

  // The hook runs before the switch can be turned off, and Back lands on the
  // Dev tools entry rather than leaving Voice library current.
  assert.deepEqual(pages(), ['home', 'dev-tools', 'voice-library']);
  assert.equal(stubs.history.current.page, 'dev-tools');
  assert.equal(state.voiceLibraryAwaitingFirstPlayback, null);
  await settle(); // leave no popstate behind for the next test
});

test('turning dev mode off pops the subpage entry instead of pushing one', async () => {
  stubs.history.reset();
  // Closing a sheet the previous test left open is not what this asserts.
  stubs.elements.get('#settingsSheet').hidden = true;
  setDevMode(true);

  const pages = () => stubs.history.entries.map((entry) => entry.page);
  sheet.openSettingsSheet('home');
  assert.deepEqual(pages(), ['home']);

  sheet.navigateSettingsPage('dev-tools');
  assert.deepEqual(pages(), ['home', 'dev-tools']);

  // What the Dev tools switch does when it is turned off.
  setDevMode(false);
  sheet.handleSettingsBack();
  await settle();

  // No extra entry was pushed, and the popped-to entry is the sheet root.
  assert.deepEqual(pages(), ['home', 'dev-tools']);
  assert.equal(stubs.history.current.page, 'home');
  assert.equal(state.settingsPage, 'home');

  // A further Back closes the sheet.
  sheet.handleSettingsBack();
  await settle();
  assert.equal(state.settingsPage, 'home');
  assert.equal(stubs.elements.get('#settingsSheet').hidden, true);
});

test('a dev-only popstate falls back to the sheet root while dev mode is off', () => {
  setDevMode(true);
  sheet.openSettingsSheet('home');
  sheet.navigateSettingsPage('dev-tools');

  setDevMode(false);
  // Browser Forward/Back can still deliver the stored dev-only entry.
  sheet.handleSettingsSheetPopstate({ state: { view: 'settingsSheet', page: 'dev-tools' } });

  assert.equal(state.settingsPage, 'home');
});

test('a dev-only popstate is honored while dev mode is on', () => {
  setDevMode(true);
  sheet.openSettingsSheet('home');
  sheet.navigateSettingsPage('dev-tools');
  sheet.handleSettingsSheetPopstate({ state: { view: 'settingsSheet', page: 'tuning' } });

  assert.equal(state.settingsPage, 'tuning');
});

const voiceSheet = () => stubs.elementFor('#voiceOptionsSheet');

// The rendered radios are the sheet's own detail; what matters is that a tap on
// a control lands in the session state. The list itself is covered by
// voice-options.test.mjs and the shared rules by voice-selection.test.mjs.
test('the voice icon opens the sheet', () => {
  openVoiceOptionsSheet();

  assert.equal(voiceSheet().hidden, false);
});

test('the voice sheet closes through its own close button', () => {
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();
  stubs.elementFor('#closeVoiceOptionsButton').fire('click');

  assert.equal(voiceSheet().hidden, true);
  assert.equal(stubs.history.current.view, 'live_recording');
});

test('the voice sheet owns exactly one history entry while open', () => {
  const before = stubs.history.entries.length;
  openVoiceOptionsSheet();
  assert.equal(stubs.history.entries.length, before + 1);
  assert.equal(stubs.history.current.view, 'voiceOptionsSheet');

  // Closing pops only that entry, so the page stack is as it was.
  closeVoiceOptionsSheet();
  assert.equal(stubs.history.entries.length, before + 1);
});

test('going back closes the sheet and leaves the session entry current', async () => {
  // A live session sits on its own entry; the sheet adds one on top.
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();
  assert.equal(voiceSheet().hidden, false);

  stubs.history.back();
  await settle();

  // Back closed the sheet and the session entry is current again, so a second
  // Back reaches the finish path instead of leaving the document.
  assert.equal(voiceSheet().hidden, true);
  assert.equal(stubs.history.current.view, 'live_recording');
});

test('the sheet closes through its button and the session entry stays', () => {
  stubs.history.pushState({ view: 'live_recording' }, '', '/');
  openVoiceOptionsSheet();
  closeVoiceOptionsSheet();

  assert.equal(voiceSheet().hidden, true);
  assert.equal(stubs.history.current.view, 'live_recording');
});

test('choosing a voice updates the state and the stored preference', () => {
  openVoiceOptionsSheet();
  stubs.elementFor('#voiceModeGroup').fire('change', { target: { name: 'voiceMode', value: 'male' } });

  assert.equal(voiceOptions.voiceMode(), 'male');
  assert.deepEqual(JSON.parse(stubs.store.get('voice_mode')), { mode: 'male' });
});

test('an unrelated control in the group does not change the voice', () => {
  openVoiceOptionsSheet();
  stubs.elementFor('#voiceModeGroup').fire('change', { target: { name: 'somethingElse', value: 'male' } });

  assert.equal(voiceOptions.voiceMode(), 'female');
  assert.equal(stubs.store.has('voice_mode'), false);
});

test('the automatic-speaking switch persists the choice', () => {
  openVoiceOptionsSheet();
  const autoSpeak = stubs.elementFor('#voiceAutoSpeak');
  assert.equal(autoSpeak.checked, true);

  autoSpeak.checked = false;
  autoSpeak.fire('change');

  assert.equal(voiceOptions.autoSpeak(), false);
  assert.deepEqual(JSON.parse(stubs.store.get('tts_global')), { auto_speak: false });
});

test('the cloning guidance appears only for the clone voice', () => {
  openVoiceOptionsSheet();
  assert.equal(stubs.elementFor('#voiceCloningGuidance').hidden, true);

  stubs.elementFor('#voiceModeGroup').fire('change', {
    target: { name: 'voiceMode', value: 'speaker_clone' },
  });

  assert.equal(voiceOptions.voiceMode(), 'speaker_clone');
  assert.equal(stubs.elementFor('#voiceCloningGuidance').hidden, false);
  assert.match(stubs.elementFor('#voiceCloningGuidance').textContent, /speak clearly/);
});

test('a backend without voice modes disables the voices but keeps speaking', () => {
  // Kokoro speaks translations but cannot select one of the product modes.
  state.ttsSettings.backend = 'kokoro';
  openVoiceOptionsSheet();

  assert.equal(voiceOptions.voiceModeAvailable(), false);
  assert.equal(
    stubs.elementFor('#voiceAutoSpeak').disabled,
    false,
    'automatic speaking is a separate capability from voice selection',
  );
  // A disabled control cannot change the voice either.
  stubs.elementFor('#voiceModeGroup').fire('change', { target: { name: 'voiceMode', value: 'male' } });
  assert.equal(voiceOptions.voiceMode(), 'female');
});

test('automatic speaking is disabled when speech output is off', () => {
  state.ttsSettings.enabled = false;
  openVoiceOptionsSheet();

  assert.equal(stubs.elementFor('#voiceAutoSpeak').disabled, true);
  state.ttsSettings.enabled = true;
});

test('the automatic-speaking switch sends the full TTS snapshot', () => {
  const socket = {
    isOpen: () => true,
    updateTtsSettings: (settings) => { sentTts = settings; },
  };
  state.socket = socket;
  state.ttsSettings.backend = 'nanovllm_voxcpm';
  openVoiceOptionsSheet();

  const autoSpeak = stubs.elementFor('#voiceAutoSpeak');
  autoSpeak.checked = false;
  autoSpeak.fire('change');

  // The server replaces the session snapshot, so a delta would drop the rest.
  assert.equal(sentTts.auto_speak, false);
  assert.equal(sentTts.backend, 'nanovllm_voxcpm');
  assert.ok(sentTts.kokoro, 'the nested voice settings travel with it');
  state.socket = null;
});

test('every way out of a session clears the panel and the session voice state', async () => {
  const { applySessionTeardown } = await import('../../static/src/session/lifecycle.js');

  for (const path of ['server ended', 'socket closed', 'local finish']) {
    with_(path);
    stubs.history.reset();
    stubs.store.clear();
    voiceOptions.resetVoiceOptions();
    state.appMode = APP_MODES.LIVE_RECORDING;
    voiceOptions.applyVoiceSessionReady({
      voice_mode: 'speaker_clone',
      voice_cloning_status: { a_to_b: { state: 'preparing', fallback_voice_mode: 'male' } },
    });
    openVoiceOptionsSheet();
    assert.equal(voiceSheet().hidden, false, path);

    applySessionTeardown();

    assert.equal(voiceSheet().hidden, true, `${path}: panel closes`);
    assert.deepEqual(voiceOptions.voiceCloningStatus(), {}, `${path}: clone status clears`);
    assert.equal(state.appMode, APP_MODES.SETUP, `${path}: back to setup`);
  }

  // The stored choice survives, so the next session starts where the user left.
  assert.equal(voiceOptions.voiceMode(), 'female');

  function with_() { /* each path shares one teardown; the label documents it */ }
});

test('the voice icon is only in the document while a session runs', () => {
  const icon = () => stubs.elementFor('#voiceOptionsButton');

  state.appMode = APP_MODES.SETUP;
  renderLifecycle();
  // Detached rather than hidden: a stale stylesheet cannot display an element
  // that is not in the titlebar.
  assert.equal(icon().parentElement, null, 'setup must not carry the voice icon');

  state.appMode = APP_MODES.LIVE_RECORDING;
  renderLifecycle();
  assert.notEqual(icon().parentElement, null, 'a running session offers the icon');
  assert.equal(icon().hidden, false);

  state.appMode = APP_MODES.IMAGE_TRANSLATION;
  renderLifecycle();
  assert.equal(icon().parentElement, null, 'the image view has no speech output');

  // Leave the app in setup, the normal starting state for the other tests.
  state.appMode = APP_MODES.SETUP;
  renderLifecycle();
  assert.equal(icon().parentElement, null);
});

test.after(() => {
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.history;
  delete globalThis.navigator;
  delete globalThis.requestAnimationFrame;
});

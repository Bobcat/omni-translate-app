// Dev mode: the URL parameter is a switch, not a secret. These tests cover the
// pure predicate plus the storage-driven toggle, with a minimal localStorage,
// history and navigator stub because the module pulls in application state.
import test from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

function installBrowserStubs({ search = '', stored = null, setItemThrows = false } = {}) {
  const store = new Map();
  if (stored !== null) store.set('dev_tools_settings', JSON.stringify(stored));
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      if (setItemThrows) throw new Error('storage blocked');
      store.set(key, String(value));
    },
    removeItem: (key) => store.delete(key),
  };
  // state.js guesses the setup languages from navigator at import time; Node 18
  // has no global navigator and Node 24 exposes it as a getter-only property,
  // so define it instead of assigning.
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US', languages: ['en-US', 'nl-NL'] },
    configurable: true,
    writable: true,
  });
  globalThis.window = {
    location: { href: `https://example.test/?${search}`, search: search ? `?${search}` : '' },
    history: {
      state: null,
      replaceState(_state, _title, url) {
        this.lastUrl = url;
        globalThis.window.location.href = `https://example.test${url}`;
        globalThis.window.location.search = url.includes('?') ? `?${url.split('?')[1]}` : '';
      },
      lastUrl: null,
    },
  };
  return { store, history: globalThis.window.history };
}

async function loadModule() {
  importCounter += 1;
  return import(`../../static/src/settings/dev-mode.js?test=${importCounter}`);
}

test.after(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.navigator;
});
test('the dev switch is off without the parameter', async () => {
  installBrowserStubs();
  const { isDevModeEnabled } = await loadModule();
  assert.equal(isDevModeEnabled(''), false);
  assert.equal(isDevModeEnabled('?mobile'), false);
});

test('the dev switch is on for bare and explicit values', async () => {
  installBrowserStubs();
  const { isDevModeEnabled } = await loadModule();
  for (const search of ['?dev', '?dev=1', '?dev=true', '?mobile&dev']) {
    assert.equal(isDevModeEnabled(search), true, search);
  }
  for (const search of ['?dev=0', '?dev=false']) {
    assert.equal(isDevModeEnabled(search), false, search);
  }
});

test('opening the app with ?dev enables the mode and strips the parameter', async () => {
  const { store, history } = installBrowserStubs({ search: 'dev' });
  const { initDevMode, isDevMode } = await loadModule();
  initDevMode();
  assert.equal(isDevMode(), true);
  assert.equal(history.lastUrl, '/');
  assert.equal(JSON.parse(store.get('dev_tools_settings')).devMode, true);
});

test('the mode survives a reload without the parameter', async () => {
  installBrowserStubs({ stored: { showControls: false, devMode: true } });
  const { initDevMode, isDevMode } = await loadModule();
  initDevMode();
  assert.equal(isDevMode(), true);
});

test('?dev=0 turns a remembered mode off and strips the parameter', async () => {
  const { store, history } = installBrowserStubs({
    search: 'dev=0',
    stored: { showControls: false, devMode: true },
  });
  const { initDevMode, isDevMode } = await loadModule();
  initDevMode();
  assert.equal(isDevMode(), false);
  assert.equal(JSON.parse(store.get('dev_tools_settings')).devMode, false);
  assert.equal(history.lastUrl, '/');
});

test('stripping the parameter keeps the unrelated query and hash', async () => {
  const { history } = installBrowserStubs({ search: 'dev&mobile=1' });
  const { initDevMode } = await loadModule();
  initDevMode();
  assert.equal(history.lastUrl, '/?mobile=1');
});

test('a malformed persisted value keeps dev mode off', async () => {
  for (const stored of [{ devMode: 'false' }, { devMode: 1 }, { devMode: [] }, { devMode: {} }, { devMode: null }]) {
    installBrowserStubs({ stored });
    const { initDevMode, isDevMode } = await loadModule();
    initDevMode();
    assert.equal(isDevMode(), false, JSON.stringify(stored));
  }
});

test('a pre-change entry without the key is off and stays untouched', async () => {
  const { store } = installBrowserStubs({ stored: { showControls: true } });
  const { initDevMode, isDevMode } = await loadModule();
  initDevMode();
  assert.equal(isDevMode(), false);
  assert.deepEqual(JSON.parse(store.get('dev_tools_settings')), { showControls: true });
});

test('a rejected storage write still applies the mode for this visit', async () => {
  const { history } = installBrowserStubs({ search: 'dev', setItemThrows: true });
  const { initDevMode, isDevMode } = await loadModule();
  assert.doesNotThrow(() => initDevMode());
  assert.equal(isDevMode(), true);
  assert.equal(history.lastUrl, '/');
});

test('turning the mode off keeps the other dev-tools setting', async () => {
  const { store } = installBrowserStubs({ stored: { showControls: true, devMode: true } });
  const { initDevMode, setDevMode } = await loadModule();
  initDevMode();
  setDevMode(false);
  assert.deepEqual(JSON.parse(store.get('dev_tools_settings')), { showControls: true, devMode: false });
});

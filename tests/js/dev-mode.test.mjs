// Dev mode: the URL parameter is a switch, not a secret. These tests cover the
// pure predicate plus the storage-driven toggle, with a minimal localStorage and
// history stub because the module touches both at import time.
import test from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

function installBrowserStubs({ search = '', stored = null } = {}) {
  const store = new Map();
  if (stored !== null) store.set('dev_tools_settings', JSON.stringify(stored));
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
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

test('?dev=0 turns a remembered mode off', async () => {
  const { store } = installBrowserStubs({ search: 'dev=0', stored: { showControls: false, devMode: true } });
  const { initDevMode, isDevMode } = await loadModule();
  initDevMode();
  assert.equal(isDevMode(), false);
  assert.equal(JSON.parse(store.get('dev_tools_settings')).devMode, false);
});

test('turning the mode off keeps the other dev-tools setting', async () => {
  const { store } = installBrowserStubs({ stored: { showControls: true, devMode: true } });
  const { initDevMode, setDevMode } = await loadModule();
  initDevMode();
  setDevMode(false);
  assert.deepEqual(JSON.parse(store.get('dev_tools_settings')), { showControls: true, devMode: false });
});

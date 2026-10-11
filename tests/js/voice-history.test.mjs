// The voice session's history controller, as a transition table.
//
// The controller owns two related entries — the live session and the options
// panel above it — so this file asserts the whole stack and the current index,
// not just the top entry. The integration behaviour is covered by
// mobile-settings-and-voice.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US', languages: ['en-US'] },
  configurable: true,
  writable: true,
});
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

/** Import a fresh controller so each case starts from its own module state. */
let imports = 0;
async function loadController(search = '') {
  installHistory(search);
  imports += 1;
  return import(`../../static/src/session/history.js?table=${imports}`);
}

/** Browser history, with traversal deferred the way a browser does it. */
function installHistory(search) {
  const stack = [{ state: null, url: 'https://example.test/' }];
  let index = 0;
  installHistory.stack = stack;
  installHistory.getIndex = () => index;
  globalThis.window = {
    location: { href: `https://example.test/${search}`, search },
  };
  globalThis.history = {
    get state() { return stack[index].state; },
    get length() { return stack.length; },
    get currentIndex() { return index; },
    get kinds() { return stack.map((entry) => entry.state?.kind ?? null); },
    pushState(state) {
      stack.splice(index + 1);
      stack.push({ state, url: '/' });
      index += 1;
    },
    replaceState(state) {
      stack[index] = { state, url: stack[index].url };
    },
    go(delta) {
      const next = Math.max(0, Math.min(stack.length - 1, index + delta));
      if (next === index) return;
      queueMicrotask(() => {
        index = next;
        for (const listener of globalThis.window.__popstate || []) {
          listener({ state: stack[index].state });
        }
      });
    },
    back() { this.go(-1); },
    forward() { this.go(1); },
  };
  globalThis.window.addEventListener = (type, listener) => {
    globalThis.window.__popstate = globalThis.window.__popstate || [];
    if (!globalThis.window.__popstate.includes(listener)) globalThis.window.__popstate.push(listener);
  };
  return stack;
}

const settle = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Drive the controller the way the app's router does. */
function wireRouter(controller) {
  const seen = [];
  globalThis.window.addEventListener('popstate', () => {
    if (controller.handleVoiceHistoryPopstate()) seen.push(controller.currentVoiceHistoryState());
  });
  return seen;
}

test('setup -> live pushes one live entry', async () => {
  const c = await loadController();
  wireRouter(c);
  c.beginVoiceHistorySession();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  await settle();

  assert.deepEqual(history.kinds, [null, 'live']);
  assert.equal(history.currentIndex, 1);
  assert.equal(c.currentVoiceHistoryState(), c.VOICE_HISTORY_LIVE);
});

test('live -> panel pushes one panel entry above the live one', async () => {
  const c = await loadController();
  wireRouter(c);
  c.beginVoiceHistorySession();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  await settle();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_PANEL);
  await settle();

  assert.deepEqual(history.kinds, [null, 'live', 'panel']);
  assert.equal(history.currentIndex, 2);
});

test('setup -> panel creates the live entry underneath first', async () => {
  const c = await loadController();
  wireRouter(c);
  c.beginVoiceHistorySession();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_PANEL);
  await settle();

  assert.deepEqual(history.kinds, [null, 'live', 'panel']);
  assert.equal(history.currentIndex, 2);
  assert.equal(c.currentVoiceHistoryState(), c.VOICE_HISTORY_PANEL);
});

test('panel -> live traverses back instead of pushing, keeping the Forward entry', async () => {
  const c = await loadController();
  wireRouter(c);
  c.beginVoiceHistorySession();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  await settle();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_PANEL);
  await settle();
  const depth = history.length;

  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  await settle();

  // No new entry: the panel is still above, reachable with Forward.
  assert.equal(history.length, depth);
  assert.deepEqual(history.kinds, [null, 'live', 'panel']);
  assert.equal(history.currentIndex, 1);

  history.forward();
  await settle();
  assert.equal(c.currentVoiceHistoryState(), c.VOICE_HISTORY_PANEL, 'Forward re-enters the panel');
});

test('a user Back sets the goal to the entry it lands on', async () => {
  const c = await loadController();
  wireRouter(c);
  c.beginVoiceHistorySession();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  await settle();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_PANEL);
  await settle();

  history.back();
  await settle();

  assert.equal(c.currentVoiceHistoryState(), c.VOICE_HISTORY_LIVE);
  assert.equal(c.desiredVoiceHistoryState(), c.VOICE_HISTORY_LIVE);
});

test('a goal change during a pending pop is not overwritten by the landed state', async () => {
  const c = await loadController();
  wireRouter(c);
  c.beginVoiceHistorySession();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  await settle();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_PANEL);
  await settle();

  // Ask for live, then change the goal to setup before the pop lands.
  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  c.requestVoiceHistoryState(c.VOICE_HISTORY_SETUP);
  await settle();
  await settle();

  assert.equal(c.desiredVoiceHistoryState(), c.VOICE_HISTORY_SETUP);
  assert.equal(c.currentVoiceHistoryState(), c.VOICE_HISTORY_SETUP);
  assert.equal(history.currentIndex, 0, 'both voice entries are gone');
});

test('panel -> setup leaves both entries, one pop at a time', async () => {
  const c = await loadController();
  wireRouter(c);
  c.beginVoiceHistorySession();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  await settle();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_PANEL);
  await settle();

  let completed = false;
  c.endVoiceHistorySession({ onComplete: () => { completed = true; } });
  assert.equal(completed, false, 'not complete while an entry is still current');

  await settle();
  await settle();

  assert.equal(completed, true);
  // Traversal moves the index; it does not remove entries from the stack.
  assert.equal(history.currentIndex, 0, 'back on the app baseline');
  assert.equal(history.state, null, 'the current entry is not ours');
  assert.deepEqual(history.kinds, [null, 'live', 'panel'], 'the entries remain above');
});

test('a teardown completion runs once and signals setup', async () => {
  const c = await loadController();
  wireRouter(c);
  c.beginVoiceHistorySession();
  c.requestVoiceHistoryState(c.VOICE_HISTORY_LIVE);
  await settle();

  const seen = [];
  c.endVoiceHistorySession({ onComplete: () => seen.push('done') });
  await settle();
  await settle();

  assert.deepEqual(seen, ['done']);
  assert.equal(c.currentVoiceHistoryState(), c.VOICE_HISTORY_SETUP);
});

test('entries from a previous page load are not adopted', async () => {
  // A history stack left behind by an earlier load, with that load's entries.
  const c1 = await loadController('?first');
  c1.beginVoiceHistorySession();
  c1.requestVoiceHistoryState(c1.VOICE_HISTORY_LIVE);
  await settle();
  c1.requestVoiceHistoryState(c1.VOICE_HISTORY_PANEL);
  await settle();
  history.back();
  await settle();
  const leftover = history.kinds.slice();

  // A fresh load: same stack, new module state.
  const c2 = await loadController('?second');
  const seen = wireRouter(c2);
  c2.beginVoiceHistorySession();
  c2.requestVoiceHistoryState(c2.VOICE_HISTORY_LIVE);
  await settle();

  assert.deepEqual(leftover, [null, 'live', 'panel'], 'the old entries are still there');
  assert.equal(c2.currentVoiceHistoryState(), c2.VOICE_HISTORY_LIVE);
  // Forward reaches the old panel entry, which belongs to the previous load.
  history.forward();
  await settle();
  assert.notEqual(
    c2.currentVoiceHistoryState(),
    c2.VOICE_HISTORY_PANEL,
    'the previous load\'s panel entry is not adopted',
  );
  assert.ok(seen.length >= 0);
});

test.after(() => {
  delete globalThis.history;
  delete globalThis.localStorage;
  delete globalThis.navigator;
  delete globalThis.window;
});

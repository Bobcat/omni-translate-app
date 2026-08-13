import test from 'node:test';
import assert from 'node:assert/strict';

const stored = new Map();
const mediaListeners = [];
const darkMedia = {
  matches: false,
  addEventListener(_name, listener) {
    mediaListeners.push(listener);
  },
};

globalThis.localStorage = {
  getItem(key) {
    return stored.get(key) ?? null;
  },
  setItem(key, value) {
    stored.set(key, String(value));
  },
};
globalThis.window = { matchMedia: () => darkMedia };

const root = { dataset: {} };
const meta = { content: '' };
globalThis.document = {
  documentElement: root,
  querySelector: (selector) => (selector === 'meta[name="theme-color"]' ? meta : null),
};

const appearance = await import('../../static/desktop/src/shared/appearance.js');

function stylesheet() {
  const attributes = new Map([['href', 'modern.css']]);
  return {
    dataset: { modernHref: 'modern.css', darkHref: 'dark.css' },
    getAttribute: (name) => attributes.get(name) ?? null,
    set href(value) {
      attributes.set('href', String(value));
    },
    get href() {
      return attributes.get('href');
    },
  };
}

test('desktop Appearance shares and applies theme plus palette', () => {
  const preset = stylesheet();
  appearance.initDesktopAppearance(preset);
  assert.deepEqual(root.dataset, { theme: 'light', palette: 'warm' });
  assert.equal(meta.content, '#fcfaf5');

  appearance.setDesktopAppearance({ theme: 'dark', palette: 'cool' });
  assert.deepEqual(root.dataset, { theme: 'dark', palette: 'cool' });
  assert.equal(preset.href, 'dark.css');
  assert.equal(meta.content, '#0e1117');
  assert.deepEqual(JSON.parse(stored.get('appearance_settings')), {
    theme: 'dark',
    palette: 'cool',
  });
});

test('System follows an OS theme change', () => {
  const preset = stylesheet();
  appearance.setDesktopAppearance({ theme: 'system', palette: 'warm' });
  appearance.initDesktopAppearance(preset);
  darkMedia.matches = true;
  mediaListeners.at(-1)();
  assert.deepEqual(root.dataset, { theme: 'dark', palette: 'warm' });
  assert.equal(preset.href, 'dark.css');
  assert.equal(meta.content, '#161513');
});

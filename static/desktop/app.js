// Desktop shell bootstrap: sidebar navigation + hash router on the vendored
// spa-foundation package, following the same pattern as the LLM Workbench
// app. Views are kept alive across navigation (created once, re-attached on
// return) so a running translation keeps its stage; a view with work in
// flight marks its sidebar entry via the view-busy event.

import {
  RouterCore,
  ShellState,
  createShellPersistence,
  bindMobileSidebarDismiss,
} from '../foundation/spa-foundation/index.js';
import { iconMarkup } from './src/shared/icons.js';
import { VIEW_BUSY_EVENT } from './src/shared/view-activity.js';
import { createVoiceView } from './src/views/voice/index.js';
import { createTextView } from './src/views/text/index.js';
import { createImageView } from './src/views/image/index.js';
import { createPdfView } from './src/views/pdf/index.js';
import { createSettingsView } from './src/views/settings/index.js';

const STORAGE_KEY = 'omni-translate.desktop.shell';

const NAV_ITEMS = [
  { id: 'text', route: 'text', name: 'Text translation', icon: 'languages' },
  { id: 'image', route: 'image', name: 'Image translation', icon: 'image' },
  { id: 'pdf', route: 'pdf', name: 'PDF translation', icon: 'file-text' },
  { id: 'voice', route: 'voice', name: 'Voice translation', icon: 'mic' },
];

const AUX_ITEMS = [
  { id: 'settings', route: 'settings', name: 'Settings', icon: 'settings' },
];

const VIEW_FACTORIES = {
  voice: createVoiceView,
  text: createTextView,
  image: createImageView,
  pdf: createPdfView,
  settings: createSettingsView,
};

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...AUX_ITEMS];

const byId = (id) => document.getElementById(id);

const appRoot = byId('appRoot');
const sidebar = byId('sidebar');
const sidebarToggle = byId('sidebarToggle');
const sidebarToggleIcon = byId('sidebarToggleIcon');
const navList = byId('navList');
const presetStylesheet = byId('presetStylesheet');
const themeToggle = byId('themeToggle');
const themeToggleIcon = byId('themeToggleIcon');
const themeToggleLabel = byId('themeToggleLabel');

const initialShell = window.__OMNI_DESKTOP_INITIAL_SHELL__ || {};
let activePreset = initialShell.preset === 'dark' ? 'dark' : 'modern';

const shellState = new ShellState({
  sidebarOpen: typeof initialShell.sidebarOpen === 'boolean' ? initialShell.sidebarOpen : true,
});
const shellPersistence = createShellPersistence({
  storageKey: STORAGE_KEY,
  shellState,
  getPreset: () => activePreset,
  getRoundedSidebar: () => false,
});

function applyPreset(preset) {
  activePreset = preset === 'dark' ? 'dark' : 'modern';
  const dark = activePreset === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Single preset stylesheet (same pattern as the LLM Workbench shell):
  // swapping the href fetches the other preset once and applies it.
  presetStylesheet.href = dark
    ? presetStylesheet.dataset.darkHref
    : presetStylesheet.dataset.modernHref;
  const themeAction = dark ? 'Light theme' : 'Dark theme';
  themeToggleIcon.innerHTML = iconMarkup(dark ? 'sun' : 'moon');
  themeToggleLabel.textContent = themeAction;
  themeToggle.setAttribute('aria-label', themeAction);
  themeToggle.title = themeAction;
}

function renderNav() {
  const itemMarkup = (item, extraClass = '') => `
      <li data-route="${item.route}" data-tooltip="${item.name}"${extraClass ? ` class="${extraClass}"` : ''} role="button" tabindex="0">
        ${iconMarkup(item.icon, 'sidebar-icon')}
        <span class="link-text">${item.name}</span>
      </li>
    `;

  const mainMarkup = NAV_ITEMS.map((item) => itemMarkup(item)).join('');
  const auxiliaryMarkup = AUX_ITEMS.map((item) => itemMarkup(item, 'sidebar-route-bottom')).join('');

  navList.innerHTML = `${mainMarkup}${auxiliaryMarkup}`;
}

const router = new RouterCore(appRoot, {
  onRouteDidMount: ({ to }) => {
    sidebar.querySelectorAll('[data-route]').forEach((item) => {
      item.classList.toggle('active', item.dataset.route === to.view);
    });
  },
});

ALL_NAV_ITEMS.forEach((item) => {
  // Keep-alive, same pattern as the LLM Workbench shell: the view element is
  // created once and cached per route. Navigating away only detaches it (the
  // router clears the host), so DOM state, closures and in-flight polling
  // survive; returning re-attaches the same element. __onActivate /
  // __onDeactivate let a view hook into that cycle when it needs to.
  let cachedView = null;
  router.register(item.route, {
    mount: (host) => {
      host.innerHTML = '';
      if (!cachedView) cachedView = VIEW_FACTORIES[item.id]();
      host.appendChild(cachedView);
      if (typeof cachedView.__onActivate === 'function') cachedView.__onActivate();
    },
    unmount: () => {
      if (cachedView && typeof cachedView.__onDeactivate === 'function') cachedView.__onDeactivate();
    },
  });
});

// Sidebar entries whose view reported work in flight. Held here rather than
// in the views: the indicator has to stay correct while you are looking at
// another view (the whole point of keep-alive is that the view keeps running
// while detached).
const busyViews = new Set();

function updateViewRunningState() {
  navList.querySelectorAll('[data-route]').forEach((item) => {
    item.classList.toggle('is-running', busyViews.has(String(item.dataset.route || '')));
  });
}

window.addEventListener(VIEW_BUSY_EVENT, (event) => {
  const view = String(event?.detail?.view || '');
  if (!view) return;
  if (event.detail.busy) busyViews.add(view);
  else busyViews.delete(view);
  updateViewRunningState();
});

function updateSidebarUI(isOpen) {
  sidebar.classList.toggle('expanded', isOpen);
  sidebarToggleIcon.innerHTML = iconMarkup('panel-left');
}

shellState.subscribe(({ next }) => {
  updateSidebarUI(next.sidebarOpen);
  shellPersistence.save();
});

sidebarToggle.addEventListener('click', () => {
  shellState.toggleSidebar('app.sidebarToggle');
});

themeToggle.addEventListener('click', () => {
  applyPreset(activePreset === 'dark' ? 'modern' : 'dark');
  shellPersistence.save();
});

function navigateFromNavList(event) {
  const item = event.target.closest('[data-route]');
  if (!item) return;
  if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
  if (event.type === 'keydown') event.preventDefault();
  const route = String(item.dataset.route || '');
  if (router.has(route)) {
    router.navigate(route, null, { url: `#${route}` });
  }
}

navList.addEventListener('click', navigateFromNavList);
navList.addEventListener('keydown', navigateFromNavList);

function init() {
  updateSidebarUI(shellState.getSnapshot().sidebarOpen);
  applyPreset(activePreset);
  bindMobileSidebarDismiss(shellState, sidebar, 600);
  renderNav();

  router.bindPopState({
    parseHash: ({ hash }) => (router.has(hash) ? { view: hash, data: null } : null),
  });

  // Voice is the app's main flow: land there when the hash is empty or unknown.
  const hash = window.location.hash.replace(/^#/, '');
  const initialRoute = router.has(hash) ? hash : 'voice';
  router.start(initialRoute, null, { url: `#${initialRoute}` });
}

init();

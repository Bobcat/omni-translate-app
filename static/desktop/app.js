// Desktop shell bootstrap: sidebar navigation + hash router on the vendored
// spa-foundation package, following the same pattern as the Workbench
// app. Views are kept alive across navigation (created once, re-attached on
// return) so a running translation keeps its stage; a view with work in
// flight marks its sidebar entry via the view-busy event.

import {
  RouterCore,
  ShellState,
  bindMobileSidebarDismiss,
} from '../foundation/spa-foundation/index.js';
import { iconMarkup } from './src/shared/icons.js';
import { VIEW_BUSY_EVENT } from './src/shared/view-activity.js';
import { accountInitials } from '../shared/account-display.js';
import { cancelImage, getConfig, getImageRequest } from './src/shared/api.js';
import { initAuth, onAuthChange, onBeforeSignOut } from './src/auth.js';
import { registerImageSignOutCancellation } from '../shared/image-operation-recovery.js';
import { createVoiceWorkflow } from './src/views/voice/index.js';
import { createTextView } from './src/views/text/index.js';
import { createImageView } from './src/views/image/index.js';
import { createPdfView } from './src/views/pdf/index.js';
import { createSettingsView } from './src/views/settings/index.js';
import { createAccountView } from './src/views/account/index.js';
import { initDesktopAppearance } from './src/shared/appearance.js';

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

const ACCOUNT_ITEM = { id: 'account', route: 'account', name: 'Account', icon: 'user' };

let voiceWorkflow = null;

function getVoiceWorkflow() {
  if (!voiceWorkflow) voiceWorkflow = createVoiceWorkflow();
  return voiceWorkflow;
}

const VIEW_FACTORIES = {
  voice: () => getVoiceWorkflow().view,
  text: createTextView,
  image: createImageView,
  pdf: createPdfView,
  settings: () => createSettingsView({
    onToggleRecording: () => getVoiceWorkflow().toggleRecording(),
  }),
  account: createAccountView,
};

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...AUX_ITEMS, ACCOUNT_ITEM];

const byId = (id) => document.getElementById(id);

const appRoot = byId('appRoot');
const sidebar = byId('sidebar');
const sidebarToggle = byId('sidebarToggle');
const sidebarToggleIcon = byId('sidebarToggleIcon');
const navList = byId('navList');
const accountNavList = byId('accountNavList');
const presetStylesheet = byId('presetStylesheet');

let operationStorage = null;
try { operationStorage = window.localStorage; } catch {}
registerImageSignOutCancellation({
  storage: operationStorage,
  getRequest: getImageRequest,
  cancelRequest: cancelImage,
  onBeforeSignOut,
});

const initialShell = window.__OMNI_DESKTOP_INITIAL_SHELL__ || {};

const shellState = new ShellState({
  sidebarOpen: typeof initialShell.sidebarOpen === 'boolean' ? initialShell.sidebarOpen : true,
});

function saveSidebarState() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sidebarOpen: Boolean(shellState.getSnapshot().sidebarOpen),
    }));
  } catch {}
}

function renderNav() {
  const itemMarkup = (item, extraClass = '') => `
      <li data-route="${item.route}" data-tooltip="${item.name}"${extraClass ? ` class="${extraClass}"` : ''}>
        <a data-nav-route="${item.route}" href="${routeUrl(item.route)}">
          ${iconMarkup(item.icon, 'sidebar-icon')}
          <span class="link-text">${item.name}</span>
        </a>
      </li>
    `;

  const mainMarkup = NAV_ITEMS.map((item) => itemMarkup(item)).join('');
  const auxiliaryMarkup = AUX_ITEMS
    .map((item, index) => itemMarkup(item, index === 0 ? 'sidebar-route-bottom' : ''))
    .join('');

  navList.innerHTML = `${mainMarkup}${auxiliaryMarkup}`;
  accountNavList.innerHTML = `
    <li data-route="account" data-tooltip="Account" hidden>
      <a data-nav-route="account" href="${routeUrl('account')}">
        <span class="sidebar-account-avatar" data-sidebar-account-avatar>${iconMarkup('user')}</span>
        <span class="link-text">Account</span>
      </a>
    </li>
  `;
}

function updateSidebarAccount(authState) {
  const item = accountNavList.querySelector('[data-route="account"]');
  const avatar = item?.querySelector('[data-sidebar-account-avatar]');
  if (!item || !avatar) return;
  item.hidden = false;
  if (authState?.signedIn) {
    const initials = document.createElement('span');
    initials.className = 'sidebar-account-initials';
    initials.textContent = accountInitials(authState.email);
    avatar.replaceChildren(initials);
    avatar.classList.add('has-initials');
  } else {
    avatar.innerHTML = iconMarkup('user');
    avatar.classList.remove('has-initials');
  }
}

const router = new RouterCore(appRoot, {
  onRouteDidMount: ({ to }) => {
    sidebar.querySelectorAll('[data-route]').forEach((item) => {
      const active = item.dataset.route === to.view;
      item.classList.toggle('active', active);
      const link = item.querySelector('[data-nav-route]');
      if (active) link?.setAttribute('aria-current', 'page');
      else link?.removeAttribute('aria-current');
    });
  },
});

ALL_NAV_ITEMS.forEach((item) => {
  // Keep-alive, same pattern as the Workbench shell: the view element is
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
  saveSidebarState();
});

sidebarToggle.addEventListener('click', () => {
  shellState.toggleSidebar('app.sidebarToggle');
});

// History URLs are built from the current path and query — never bare
// '#route' fragments. The landing page injects <base href="/desktop/"> for
// the assets, and a bare fragment resolves against that base: the address
// bar would jump from / (or /?desktop) to /desktop/#route, dropping the
// force-variant query. Path-absolute URLs are immune to <base>.
function routeUrl(route) {
  return `${window.location.pathname}${window.location.search}#${route}`;
}

function navigateFromNavList(event) {
  const item = event.target.closest('[data-nav-route]');
  if (!item) return;
  event.preventDefault();
  const route = String(item.dataset.navRoute || '');
  if (router.has(route)) {
    router.navigate(route, null, { url: routeUrl(route) });
  }
}

navList.addEventListener('click', navigateFromNavList);
accountNavList.addEventListener('click', navigateFromNavList);
onAuthChange(updateSidebarAccount);

function init() {
  initDesktopAppearance(presetStylesheet);
  updateSidebarUI(shellState.getSnapshot().sidebarOpen);
  bindMobileSidebarDismiss(shellState, sidebar, 600);
  renderNav();

  router.bindPopState({
    parseHash: ({ hash }) => (router.has(hash) ? { view: hash, data: null } : null),
  });

  // Kick auth off before the first view mounts so account controls and bearer
  // headers settle as early as possible. First paint does not wait on the
  // CDN-loaded SDK.
  getConfig()
    .then((config) => initAuth(config?.auth || {}))
    .catch(() => {});

  // Voice is the app's main flow: land there when the hash is empty or unknown.
  const hash = window.location.hash.replace(/^#/, '');
  const initialRoute = router.has(hash) ? hash : 'voice';
  router.start(initialRoute, null, { url: routeUrl(initialRoute) });
}

init();

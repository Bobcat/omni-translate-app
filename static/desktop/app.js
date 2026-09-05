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
import {
  VIEW_BUSY_EVENT,
  VIEW_RECORDING_EVENT,
} from './src/shared/view-activity.js?v=20260829-voice-modes-11';
import { accountInitials } from '../shared/account-display.js';
import { cancelImage, getConfig, getImageRequest } from './src/shared/api.js?v=20260902-credits-23';
import { creditPlanLabel, formatCreditCount } from './src/shared/credit-display.js';
import {
  configureDesktopCredits,
  refreshDesktopCredits,
  setDesktopCreditOwner,
  subscribeDesktopCreditState,
} from './src/shared/credit-state.js?v=20260902-credits-25';
import { initAuth, onAuthChange, onBeforeSignOut } from './src/auth.js';
import { registerImageSignOutCancellation } from '../shared/image-operation-recovery.js';
import { createVoiceWorkflow } from './src/views/voice/index.js?v=20260903-help-info-1';
import { createTextView } from './src/views/text/index.js?v=20260903-help-info-1';
import { createImageView } from './src/views/image/index.js?v=20260903-help-info-1';
import { createPdfView } from './src/views/pdf/index.js?v=20260904-credits-recovery-1';
import { createInfoView } from './src/views/info/index.js?v=20260903-help-info-2';
import { createSettingsView } from './src/views/settings/index.js?v=20260829-voice-modes-11';
import { createAccountView } from './src/views/account/index.js?v=20260902-credits-30';
import { createUsageView } from './src/views/usage/index.js?v=20260902-credits-2';
import { initDesktopAppearance } from './src/shared/appearance.js?v=20260829-voice-modes-11';
import {
  getInfoCategory,
  getInfoSection,
} from '../shared/info/index.js?v=20260903-help-info-2';

const STORAGE_KEY = 'omni-translate.desktop.shell';

const NAV_ITEMS = [
  { id: 'text', route: 'text', name: 'Text translation', icon: 'languages' },
  { id: 'image', route: 'image', name: 'Image translation', icon: 'image' },
  { id: 'pdf', route: 'pdf', name: 'PDF translation', icon: 'file-text' },
  { id: 'voice', route: 'voice', name: 'Voice translation', icon: 'mic' },
];

const AUX_ITEMS = [
  { id: 'info', route: 'info', name: 'Info & help', icon: 'circle-help' },
  { id: 'settings', route: 'settings', name: 'Settings', icon: 'settings' },
];

const ACCOUNT_ITEM = { id: 'account', route: 'account', name: 'Account', icon: 'user' };
const USAGE_ITEM = { id: 'usage', route: 'usage', name: 'Usage', icon: 'chart-no-axes-column' };

let voiceWorkflow = null;

function getVoiceWorkflow() {
  if (!voiceWorkflow) voiceWorkflow = createVoiceWorkflow();
  return voiceWorkflow;
}

const VIEW_FACTORIES = {
  voice: () => getVoiceWorkflow().view,
  text: createTextView,
  image: createImageView,
  pdf: () => createPdfView({ onViewPlans: navigateToAccount }),
  info: () => createInfoView({
    onNavigate: navigateInfoCategory,
    topicHref: (categoryId, sectionId) => routeUrl(infoRoute(categoryId, sectionId)),
    overviewHref: routeUrl('info'),
  }),
  settings: () => createSettingsView({
    onToggleRecording: () => getVoiceWorkflow().toggleRecording(),
  }),
  account: () => createAccountView({ onViewUsage: navigateToUsage }),
  usage: createUsageView,
};

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...AUX_ITEMS, ACCOUNT_ITEM, USAGE_ITEM];

const byId = (id) => document.getElementById(id);

const appRoot = byId('appRoot');
const sidebar = byId('sidebar');
const sidebarToggle = byId('sidebarToggle');
const sidebarToggleIcon = byId('sidebarToggleIcon');
const navList = byId('navList');
const sidebarCredits = byId('sidebarCredits');
const auxNavList = byId('auxNavList');
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

let sidebarAuthState = { signedIn: false, email: '', userId: '' };

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
  const itemMarkup = (item, extraClass = '') => {
    const icon = item.id === 'voice'
      ? `<span class="sidebar-icon-status">
          ${iconMarkup(item.icon, 'sidebar-icon')}
          <span class="sidebar-recording-dot" aria-hidden="true"></span>
        </span>`
      : iconMarkup(item.icon, 'sidebar-icon');
    return `
      <li data-route="${item.route}" data-tooltip="${item.name}"${extraClass ? ` class="${extraClass}"` : ''}>
        <a data-nav-route="${item.route}" href="${routeUrl(item.route)}">
          ${icon}
          <span class="link-text">${item.name}</span>
        </a>
      </li>
    `;
  };

  const mainMarkup = NAV_ITEMS.map((item) => itemMarkup(item)).join('');
  const auxiliaryMarkup = AUX_ITEMS.map((item) => itemMarkup(item)).join('');

  navList.innerHTML = mainMarkup;
  auxNavList.innerHTML = auxiliaryMarkup;
  accountNavList.innerHTML = `
    <li data-route="account" data-tooltip="Account" hidden>
      <a data-nav-route="account" href="${routeUrl('account')}">
        <span class="sidebar-account-avatar" data-sidebar-account-avatar>${iconMarkup('user')}</span>
        <span class="link-text">Account</span>
      </a>
    </li>
  `;
  updateSidebarAccount(sidebarAuthState);
}

function updateSidebarAccount(authState) {
  sidebarAuthState = authState || sidebarAuthState;
  const item = accountNavList.querySelector('[data-route="account"]');
  const avatar = item?.querySelector('[data-sidebar-account-avatar]');
  if (!item || !avatar) return;
  item.hidden = false;
  if (sidebarAuthState.signedIn) {
    const initials = document.createElement('span');
    initials.className = 'sidebar-account-initials';
    initials.textContent = accountInitials(sidebarAuthState.email);
    avatar.replaceChildren(initials);
    avatar.classList.add('has-initials');
  } else {
    avatar.innerHTML = iconMarkup('user');
    avatar.classList.remove('has-initials');
  }
}

function updateSidebarCredits(creditState) {
  sidebarCredits.hidden = !creditState.configured;
  if (!creditState.configured) {
    sidebarCredits.replaceChildren();
    return;
  }

  sidebarCredits.innerHTML = `
    <section class="sidebar-credit-card" aria-label="Credit balance">
      <div class="sidebar-credit-heading">
        <strong data-credit-plan>Credits</strong>
        <a data-nav-route="account" href="${routeUrl('account')}">Plan details</a>
      </div>
      <p class="sidebar-credit-balance" data-credit-balance></p>
      <div class="sidebar-credit-track" role="progressbar" aria-label="Credits available">
        <span data-credit-track-fill></span>
      </div>
    </section>
  `;

  const credits = creditState.credits;
  const balance = sidebarCredits.querySelector('[data-credit-balance]');
  const track = sidebarCredits.querySelector('.sidebar-credit-track');
  const fill = sidebarCredits.querySelector('[data-credit-track-fill]');
  if (!credits) {
    balance.textContent = creditState.error ? 'Credits unavailable' : 'Loading credits…';
    track.hidden = true;
    return;
  }

  sidebarCredits.querySelector('[data-credit-plan]').textContent = creditPlanLabel(credits.plan);
  balance.textContent = `${formatCreditCount(credits.available)} of ${formatCreditCount(credits.grant)} credits available`;
  const ratio = credits.grant > 0 ? Math.min(1, credits.available / credits.grant) : 0;
  fill.style.width = `${ratio * 100}%`;
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(credits.grant));
  track.setAttribute('aria-valuenow', String(credits.available));
}

const router = new RouterCore(appRoot, {
  onRouteDidMount: ({ to }) => {
    const activeRoute = to.view === 'usage' ? 'account' : to.view;
    sidebar.querySelectorAll('[data-route]').forEach((item) => {
      const active = item.dataset.route === activeRoute;
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
    mount: (host, data) => {
      host.innerHTML = '';
      if (!cachedView) cachedView = VIEW_FACTORIES[item.id]();
      host.appendChild(cachedView);
      if (typeof cachedView.__onRoute === 'function') cachedView.__onRoute(data);
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
const recordingViews = new Set();

function updateViewActivityState() {
  navList.querySelectorAll('[data-route]').forEach((item) => {
    const route = String(item.dataset.route || '');
    const recording = recordingViews.has(route);
    item.classList.toggle('is-running', busyViews.has(route));
    item.classList.toggle('is-recording', recording);
    const baseLabel = String(item.querySelector('.link-text')?.textContent || '').trim();
    const accessibleLabel = recording ? `${baseLabel} — recording` : baseLabel;
    item.dataset.tooltip = accessibleLabel;
    const link = item.querySelector('[data-nav-route]');
    if (recording) link?.setAttribute('aria-label', accessibleLabel);
    else link?.removeAttribute('aria-label');
  });
}

window.addEventListener(VIEW_BUSY_EVENT, (event) => {
  const view = String(event?.detail?.view || '');
  if (!view) return;
  if (event.detail.busy) busyViews.add(view);
  else {
    busyViews.delete(view);
    recordingViews.delete(view);
  }
  updateViewActivityState();
});

window.addEventListener(VIEW_RECORDING_EVENT, (event) => {
  const view = String(event?.detail?.view || '');
  if (!view) return;
  if (event.detail.recording && busyViews.has(view)) recordingViews.add(view);
  else recordingViews.delete(view);
  updateViewActivityState();
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

function infoRoute(categoryId, sectionId = '') {
  const categoryPart = encodeURIComponent(categoryId);
  return sectionId
    ? `info/${categoryPart}/${encodeURIComponent(sectionId)}`
    : `info/${categoryPart}`;
}

function parseRouteHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const [view, ...parts] = raw.split('/');
  if (!router.has(view)) return null;
  if (view !== 'info' || parts.length === 0) return { view, data: null };
  if (parts.length > 2) return null;
  let categoryId = '';
  let sectionId = '';
  try {
    categoryId = decodeURIComponent(parts[0]);
    sectionId = parts[1] ? decodeURIComponent(parts[1]) : '';
  } catch {
    return null;
  }
  if (!getInfoCategory(categoryId)) return null;
  if (sectionId && !getInfoSection(categoryId, sectionId)) return null;
  return { view, data: { categoryId, sectionId } };
}

function navigateInfoCategory(categoryId, sectionId = '') {
  const category = getInfoCategory(categoryId);
  const section = category && sectionId ? getInfoSection(category.id, sectionId) : null;
  const data = category ? { categoryId: category.id, sectionId: section ? sectionId : '' } : null;
  const route = category ? infoRoute(category.id, data.sectionId) : 'info';
  router.navigate('info', data, { url: routeUrl(route) });
}

function navigateToAccount() {
  router.navigate('account', null, { url: routeUrl('account') });
}

function navigateToUsage() {
  router.navigate('usage', null, { url: routeUrl('usage') });
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
auxNavList.addEventListener('click', navigateFromNavList);
accountNavList.addEventListener('click', navigateFromNavList);
sidebarCredits.addEventListener('click', navigateFromNavList);
subscribeDesktopCreditState(updateSidebarCredits);
onAuthChange((authState) => {
  setDesktopCreditOwner(authState?.signedIn && authState.userId
    ? `user:${String(authState.userId)}`
    : 'anonymous');
  updateSidebarAccount(authState);
  refreshDesktopCredits().catch(() => {});
});

function init() {
  initDesktopAppearance(presetStylesheet);
  updateSidebarUI(shellState.getSnapshot().sidebarOpen);
  bindMobileSidebarDismiss(shellState, sidebar, 600);
  renderNav();

  router.bindPopState({
    parseHash: ({ hash }) => parseRouteHash(hash),
  });

  // Kick auth off before the first view mounts so account controls and bearer
  // headers settle as early as possible. First paint does not wait on the
  // CDN-loaded SDK.
  getConfig()
    .then(async (config) => {
      configureDesktopCredits(config?.credits || {});
      updateSidebarAccount(sidebarAuthState);
      await initAuth(config?.auth || {});
      await refreshDesktopCredits();
    })
    .catch(() => {});

  // Voice is the app's main flow: land there when the hash is empty or unknown.
  const hash = window.location.hash.replace(/^#/, '');
  const initialRoute = parseRouteHash(hash) || { view: 'voice', data: null };
  const initialHash = initialRoute.view === 'info' && initialRoute.data?.categoryId
    ? infoRoute(initialRoute.data.categoryId, initialRoute.data.sectionId)
    : initialRoute.view;
  router.start(initialRoute.view, initialRoute.data, { url: routeUrl(initialHash) });
}

init();

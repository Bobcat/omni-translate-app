// Supabase Auth, Google sign-in only, via Google Identity Services: the
// Google-rendered button opens the account chooser in a popup (no page
// redirect, so no return-URL handling anywhere) and yields an ID token,
// which the Supabase SDK exchanges for a session (signInWithIdToken). Both
// libraries load lazily and only when /api/config reports auth as
// configured — an unconfigured deployment stays anonymous-only and never
// fetches them. Session persistence and token refresh are SDK defaults.
// The account UI lives in settings/views; this module only renders into an
// element it is handed.

import { setAuthTokenProvider } from './shared/auth-headers.js';

const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const GIS_SDK_URL = 'https://accounts.google.com/gsi/client';
const GOOGLE_BUTTON_WIDTH = 280;

let enabled = false;
let initialized = false;
let client = null;
let readyPromise = null;
let gisPromise = null;
let gisInitialized = false;
let googleClientId = '';
let accessToken = '';
let current = { signedIn: false, email: '', userId: '' };
const listeners = new Set();
const googleButtonElements = new Set();
let googleThemeObserver = null;

// Kicks off SDK loading; resolves once the initial session state is known.
// No-op when the deployment has no auth provider configured.
export function initAuth(authConfig) {
  if (!authConfig?.configured) return Promise.resolve();
  enabled = true;
  // The provider closure reads the module's current token, so this one call
  // covers sign-in, sign-out and token refresh.
  setAuthTokenProvider(getAccessToken);
  // A failed setup (e.g. the CDN is unreachable) must not reject app init;
  // the account UI then stays on the sign-in card and its button never renders.
  readyPromise = setup(authConfig).catch((err) => {
    console.warn('Auth init failed:', err);
  });
  return readyPromise;
}

export function isEnabled() {
  return enabled;
}

export function getAccessToken() {
  return accessToken;
}

// Resolves once the initial session (restored or none) has been applied.
// Resolves immediately when auth is not configured.
export function whenAuthReady() {
  return readyPromise || Promise.resolve();
}

// Fires with { signedIn, email, userId } on init and on every SDK auth-state change.
// A listener registered after init fires immediately with the current state.
export function onAuthChange(callback) {
  listeners.add(callback);
  if (initialized) callback(current);
  return () => listeners.delete(callback);
}

// Renders Google's own sign-in button into `element` — Google's branding
// rules require their rendered button rather than a home-grown one. It
// opens the account chooser in a popup. Safe to call before auth init has
// settled (a view created during the first ticks of app boot, ahead of the
// /api/config response): the render then waits for the first settled auth
// state. The Google-owned iframe cannot inherit our CSS theme, so a theme
// change re-renders it with Google's matching supported button theme.
export async function renderGoogleButton(element) {
  googleButtonElements.add(element);
  observeGoogleButtonTheme();
  try {
    if (!initialized) await firstAuthState();
    const gis = await loadGis();
    if (!gis || !client || !googleClientId) return;
    const theme = googleButtonTheme();
    if (element.childElementCount && element.dataset.googleButtonTheme === theme) return;
    if (!gisInitialized) {
      gis.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleGoogleCredential,
      });
      gisInitialized = true;
    }
    element.replaceChildren();
    gis.accounts.id.renderButton(element, {
      type: 'standard',
      theme,
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: GOOGLE_BUTTON_WIDTH,
    });
    element.dataset.googleButtonTheme = theme;
  } catch (err) {
    console.warn('Google sign-in button failed:', err);
  }
}

function googleButtonTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'filled_blue' : 'outline';
}

function observeGoogleButtonTheme() {
  if (googleThemeObserver) return;
  googleThemeObserver = new MutationObserver(() => {
    for (const element of googleButtonElements) renderGoogleButton(element);
  });
  googleThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

export async function signOut() {
  if (!client) return;
  await client.auth.signOut();
}

// Resolves on the first auth-state notification — i.e. once setup() has
// applied the initial session.
function firstAuthState() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthChange(() => {
      unsubscribe();
      resolve();
    });
  });
}

// The popup yields a Google ID token; the SDK verifies and exchanges it for
// a Supabase session, which reports through onAuthStateChange like any
// other sign-in.
async function handleGoogleCredential({ credential }) {
  if (!credential || !client) return;
  try {
    const { error } = await client.auth.signInWithIdToken({
      provider: 'google',
      token: credential,
    });
    if (error) console.warn('Google sign-in failed:', error.message);
  } catch (err) {
    console.warn('Google sign-in failed:', err);
  }
}

// Loads the Google Identity Services script once; resolves to null when the
// script cannot be loaded (offline, blocked by an extension).
function loadGis() {
  if (window.google?.accounts) return Promise.resolve(window.google);
  if (!gisPromise) {
    gisPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = GIS_SDK_URL;
      script.async = true;
      script.onload = () => resolve(window.google || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
  }
  return gisPromise;
}

async function setup({ supabase_url: supabaseUrl, publishable_key: publishableKey, google_client_id: clientId }) {
  googleClientId = clientId || '';
  const { createClient } = await import(SUPABASE_SDK_URL);
  client = createClient(supabaseUrl, publishableKey);
  client.auth.onAuthStateChange((_event, session) => {
    applySession(session);
    notify();
  });
  // getSession() awaits the client's own initialization (storage restore),
  // so this reflects the same session the initial onAuthStateChange event
  // reported; applying it twice is harmless.
  const { data } = await client.auth.getSession();
  applySession(data?.session || null);
  initialized = true;
  notify();
}

function applySession(session) {
  accessToken = session?.access_token || '';
  current = {
    signedIn: Boolean(session?.user),
    email: session?.user?.email || '',
    userId: session?.user?.id || '',
  };
}

function notify() {
  for (const callback of listeners) callback(current);
}

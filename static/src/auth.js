// Supabase Auth, Google sign-in only. The SDK is loaded as an ES module from
// the CDN, and only when /api/config reports auth as configured — an
// unconfigured deployment stays anonymous-only and never fetches it.
// Session persistence, OAuth-hash detection and token refresh are the SDK
// defaults. The module is DOM-free; the account UI lives in settings/views.

import { setAuthTokenProvider } from './shared/auth-headers.js';

const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let enabled = false;
let initialized = false;
let client = null;
let readyPromise = null;
let accessToken = '';
let current = { signedIn: false, email: '' };
const listeners = new Set();

// Kicks off SDK loading; resolves once the initial session state is known.
// No-op when the deployment has no auth provider configured.
export function initAuth(authConfig) {
  if (!authConfig?.configured) return Promise.resolve();
  enabled = true;
  // The provider closure reads the module's current token, so this one call
  // covers sign-in, sign-out and token refresh.
  setAuthTokenProvider(getAccessToken);
  // A failed setup (e.g. the CDN is unreachable) must not reject app init;
  // the account UI then stays on the sign-in card and sign-in clicks no-op.
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

// Resolves once the initial session (restored, from the OAuth redirect hash,
// or none) has been applied. Resolves immediately when auth is not configured.
export function whenAuthReady() {
  return readyPromise || Promise.resolve();
}

// Fires with { signedIn, email } on init and on every SDK auth-state change.
// A listener registered after init fires immediately with the current state.
export function onAuthChange(callback) {
  listeners.add(callback);
  if (initialized) callback(current);
  return () => listeners.delete(callback);
}

export async function signInWithGoogle() {
  await whenAuthReady();
  if (!client) return;
  // On success the browser navigates to Google and back to redirectTo.
  await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
}

export async function signOut() {
  if (!client) return;
  await client.auth.signOut();
}

async function setup({ supabase_url: supabaseUrl, publishable_key: publishableKey }) {
  const { createClient } = await import(SUPABASE_SDK_URL);
  client = createClient(supabaseUrl, publishableKey);
  client.auth.onAuthStateChange((_event, session) => {
    applySession(session);
    notify();
  });
  // getSession() awaits the client's own initialization (storage restore +
  // OAuth hash detection), so this reflects the same session the initial
  // onAuthStateChange event reported; applying it twice is harmless.
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
  };
}

function notify() {
  for (const callback of listeners) callback(current);
}

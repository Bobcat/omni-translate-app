// Settings-sheet Account subpage: the sign-in card when signed out, account
// email + plan + sign-out when signed in. The whole feature hides (titlebar
// button included) when the deployment has no auth provider configured — dev
// stays anonymous-only. Rendered on sheet open, on subpage entry, and on every
// auth-state change.

import { els } from '../els.js';
import { api } from '../api-client.js';
import { isEnabled, onAuthChange, renderGoogleButton, signOut } from '../auth.js';
import { accountInitials } from '../../shared/account-display.js';

let authState = { signedIn: false, email: '' };
let planFetchToken = 0;

export function initAccountSettings() {
  els.accountButton.hidden = !isEnabled();
  if (!isEnabled()) return;
  renderGoogleButton(els.googleSignInHolder);
  els.accountSignOutButton.addEventListener('click', async () => {
    els.accountSignOutButton.disabled = true;
    try {
      await signOut();
    } catch (err) {
      console.warn('Sign out failed:', err);
      els.accountSignOutButton.textContent = 'Could not sign out — retry';
    } finally {
      els.accountSignOutButton.disabled = false;
    }
  });
  onAuthChange((next) => {
    authState = next;
    renderAccountButton();
    renderAccountSettings();
  });
  renderAccountButton();
  renderAccountSettings();
}

function renderAccountButton() {
  const signedIn = Boolean(authState.signedIn);
  if (signedIn) {
    els.accountButtonInitials.hidden = false;
    els.accountButtonInitials.textContent = accountInitials(authState.email);
    els.accountButton.replaceChildren(els.accountButtonInitials);
  } else {
    els.accountButtonIcon.hidden = false;
    els.accountButton.replaceChildren(els.accountButtonIcon);
  }
  const label = signedIn && authState.email
    ? `Open account for ${authState.email}`
    : 'Open account';
  els.accountButton.setAttribute('aria-label', label);
  els.accountButton.title = label;
}

export function renderAccountSettings() {
  if (!isEnabled()) return;
  els.accountSignedOut.hidden = authState.signedIn;
  els.accountSignedIn.hidden = !authState.signedIn;
  if (!authState.signedIn) return;
  els.accountSignOutButton.textContent = 'Sign out';
  els.accountEmail.textContent = authState.email;
  renderPlanLabel();
}

// The plan comes from /api/me (called with the bearer token). The token guard
// drops a stale response that lands after sign-out.
async function renderPlanLabel() {
  const token = ++planFetchToken;
  els.accountPlan.textContent = '';
  try {
    const me = await api.getMe();
    if (token !== planFetchToken) return;
    els.accountPlan.textContent = planLabel(me?.principal?.plan);
  } catch {
    // A failed fetch leaves the plan blank rather than showing a wrong label.
  }
}

function planLabel(plan) {
  return plan === 'free' ? 'Free plan' : 'Anonymous';
}

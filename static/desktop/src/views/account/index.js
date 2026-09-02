import { isEnabled, onAuthChange, signOut } from '../../auth.js';
import {
  creditGrantLabel,
  creditPlanLabel,
  formatCreditCount,
  formatCreditRenewal,
} from '../../shared/credit-display.js';
import {
  refreshDesktopCredits,
  subscribeDesktopCreditState,
} from '../../shared/credit-state.js?v=20260902-credits-25';
import { createAccountPlans } from './plans.js?v=20260902-credits-26';

export function createAccountView() {
  const container = document.createElement('div');
  container.className = 'view settings-view account-view';
  const heading = document.createElement('h1');
  heading.className = 'visually-hidden';
  heading.textContent = 'Account';
  const creditGroup = document.createElement('section');
  creditGroup.className = 'settings-group';
  creditGroup.setAttribute('aria-label', 'Plan and credits');
  creditGroup.hidden = true;
  const plansGroup = createAccountPlans();
  container.append(heading, creditGroup, plansGroup);
  initCreditGroup(creditGroup);
  container.__onActivate = () => refreshDesktopCredits().catch(() => {});
  return container;
}

function initCreditGroup(creditGroup) {
  let creditState = null;
  let authState = { signedIn: false, email: '' };

  subscribeDesktopCreditState((next) => {
    creditState = next;
    update();
  });
  onAuthChange((next) => {
    authState = next;
    update();
  });

  function update() {
    creditGroup.hidden = !creditState?.configured;
    if (!creditGroup.hidden) renderCreditGroup(creditGroup, creditState, authState);
  }
}

function renderCreditGroup(creditGroup, creditState, authState) {
  creditGroup.replaceChildren();
  if (isEnabled() && authState.signedIn) {
    creditGroup.appendChild(createAccountIdentity(authState));
  }

  const details = document.createElement('dl');
  details.className = 'account-credit-details';

  const credits = creditState.credits;
  if (!credits) {
    const status = document.createElement('p');
    status.className = 'account-credit-status';
    status.textContent = creditState.error
      ? 'Credit details are temporarily unavailable.'
      : 'Loading credit details…';
    creditGroup.appendChild(status);
    return;
  }

  appendCreditRow(details, 'Plan', creditPlanLabel(credits.plan));
  appendCreditRow(details, 'Available', `${formatCreditCount(credits.available)} credits`);
  appendCreditRow(
    details,
    creditGrantLabel(credits.period),
    `${formatCreditCount(credits.grant)} credits`,
  );
  appendCreditRow(details, 'Credits renew', formatCreditRenewal(credits.period_end));
  creditGroup.appendChild(details);
}

function createAccountIdentity(authState) {
  const identity = document.createElement('div');
  identity.className = 'account-identity';
  const copy = document.createElement('div');
  copy.className = 'account-identity-copy';
  const label = document.createElement('span');
  label.textContent = 'Signed in as';
  const email = document.createElement('span');
  email.className = 'account-identity-email';
  email.textContent = authState.email;
  copy.append(label, email);
  const actions = document.createElement('div');
  actions.className = 'account-identity-actions';
  const signOutButton = document.createElement('button');
  signOutButton.type = 'button';
  signOutButton.className = 'link-btn';
  signOutButton.textContent = 'Sign out';
  signOutButton.addEventListener('click', async () => {
    signOutButton.disabled = true;
    try {
      await signOut();
    } catch (err) {
      console.warn('Sign out failed:', err);
      signOutButton.textContent = 'Could not sign out — retry';
      signOutButton.disabled = false;
    }
  });
  actions.appendChild(signOutButton);
  identity.append(copy, actions);
  return identity;
}

function appendCreditRow(details, label, value) {
  const row = document.createElement('div');
  row.className = 'account-credit-row';
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  row.append(term, description);
  details.appendChild(row);
}

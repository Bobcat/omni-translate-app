import { isEnabled, onAuthChange, signOut } from '../../auth.js';
import { getMe } from '../../shared/api.js?v=20260829-voice-modes-11';
import { createSignInCard } from '../../shared/signin-card.js';

export function createAccountView() {
  const container = document.createElement('div');
  container.className = 'view settings-view account-view';
  const heading = document.createElement('h1');
  heading.className = 'visually-hidden';
  heading.textContent = 'Account';
  const accountGroup = document.createElement('section');
  accountGroup.className = 'settings-group';
  accountGroup.setAttribute('aria-label', 'Account');
  accountGroup.hidden = true;
  container.append(heading, accountGroup);
  initAccountGroup(accountGroup);
  return container;
}

function initAccountGroup(accountGroup) {
  let planFetchToken = 0;

  onAuthChange((authState) => {
    accountGroup.hidden = !isEnabled();
    if (!accountGroup.hidden) render(authState);
  });

  function render(authState) {
    accountGroup.replaceChildren();
    if (!authState.signedIn) {
      accountGroup.appendChild(createSignInCard('You are currently not signed in.'));
      return;
    }
    const title = document.createElement('h3');
    title.textContent = 'Account';
    const emailRow = document.createElement('div');
    emailRow.className = 'setting-row';
    const emailText = document.createElement('span');
    emailText.textContent = authState.email;
    emailRow.appendChild(emailText);
    const planRow = document.createElement('div');
    planRow.className = 'setting-row';
    const planCaption = document.createElement('span');
    planCaption.textContent = 'Plan';
    const planValue = document.createElement('span');
    planRow.append(planCaption, planValue);
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
    accountGroup.append(title, emailRow, planRow, signOutButton);
    fillPlanLabel(planValue);
  }

  async function fillPlanLabel(planValue) {
    const token = ++planFetchToken;
    try {
      const me = await getMe();
      if (token !== planFetchToken) return;
      planValue.textContent = me?.principal?.plan === 'free' ? 'Free plan' : 'Anonymous';
    } catch {
      // Leave the plan blank when the account request is temporarily unavailable.
    }
  }
}

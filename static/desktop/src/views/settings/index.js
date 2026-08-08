// Settings view — UI shell only. Lean user-facing groups (microphone, speech)
// with placeholder controls; wiring and the real option set come later. The
// Account group at the top is live: it is the desktop sign-in surface. Auth
// init may not have settled when this view is created (a reload landing on
// #settings runs the factory ahead of the /api/config response), so the
// group starts hidden and the first auth state reveals it — on a deployment
// without an auth provider no state ever arrives and it stays hidden.

import { isEnabled, onAuthChange, signOut } from '../../auth.js';
import { getMe } from '../../shared/api.js';
import { createSignInCard } from '../../shared/signin-card.js';

export function createSettingsView() {
  const container = document.createElement('div');
  container.className = 'view settings-view';
  container.innerHTML = `
    <section class="settings-group" aria-label="Microphone">
      <h3>Microphone</h3>
      <label class="setting-row">
        <span>Amplification</span>
        <input type="range" min="0.5" max="3" step="0.1" value="1.5" disabled>
      </label>
      <label class="setting-row">
        <span>Stop after silence</span>
        <select disabled>
          <option>3 sec</option>
          <option>5 sec</option>
          <option>10 sec</option>
          <option>15 sec</option>
          <option>30 sec</option>
          <option>Off</option>
        </select>
      </label>
    </section>
    <section class="settings-group" aria-label="Speech">
      <h3>Speech</h3>
      <label class="setting-row">
        <span>Engine</span>
        <select disabled>
          <option>Kokoro</option>
          <option>VoxCPM2</option>
          <option>NanoVLLM VoxCPM</option>
        </select>
      </label>
    </section>
    <p class="preview-note">UI preview — not wired to the backend yet.</p>
  `;

  const accountGroup = document.createElement('section');
  accountGroup.className = 'settings-group';
  accountGroup.setAttribute('aria-label', 'Account');
  accountGroup.hidden = true;
  container.prepend(accountGroup);
  initAccountGroup(accountGroup);

  return container;
}

// Signed out: the sign-in card. Signed in: email, plan label and a sign-out
// button. Revealed and re-rendered on every auth-state change.
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

  // The plan comes from /api/me (called with the bearer token). The token
  // guard drops a stale response that lands after sign-out.
  async function fillPlanLabel(planValue) {
    const token = ++planFetchToken;
    try {
      const me = await getMe();
      if (token !== planFetchToken) return;
      planValue.textContent = me?.principal?.plan === 'free' ? 'Free plan' : 'Anonymous';
    } catch {
      // A failed fetch leaves the plan blank rather than showing a wrong label.
    }
  }
}

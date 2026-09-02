import { isEnabled, onAuthChange, renderGoogleButton } from '../../auth.js';
import { creditPlanLabel, formatCreditCount } from '../../shared/credit-display.js';
import { subscribeDesktopCreditState } from '../../shared/credit-state.js?v=20260902-credits-25';

export function createAccountPlans() {
  const section = document.createElement('section');
  section.className = 'settings-group account-plans';
  section.setAttribute('aria-label', 'Available plans');
  section.hidden = true;

  let creditState = null;
  let authState = { signedIn: false };
  let renderSignature = '';

  subscribeDesktopCreditState((next) => {
    creditState = next;
    render();
  });
  onAuthChange((next) => {
    authState = next;
    render();
  });

  function render() {
    const plans = creditState?.plans || [];
    section.hidden = !creditState?.configured || plans.length === 0;
    if (section.hidden) return;
    const currentPlan = String(creditState?.credits?.plan || '');
    const signature = JSON.stringify({
      currentPlan,
      signedIn: Boolean(authState.signedIn),
      plans,
    });
    if (signature === renderSignature) return;
    renderSignature = signature;

    section.innerHTML = `
      <header class="account-plans-header">
        <div>
          <h3>Available plans</h3>
          <p>Choose the plan that fits your use.</p>
        </div>
        <button type="button" class="link-btn account-credit-help">How credits work</button>
      </header>
      <div class="account-plan-grid" data-plan-grid></div>
      <dialog class="account-credit-dialog" data-credit-dialog>
        <form method="dialog">
          <h2>How credits work</h2>
          <p>Credits are the usage budget for work in Omni Translate.</p>
          <ul>
            <li>The exact credit use is shown before you confirm work that uses credits.</li>
            <li>After confirmation, that amount is reserved and your available balance falls immediately.</li>
            <li>Completed work uses the reserved credits. A refundable technical failure returns them.</li>
            <li>Stopping after processing has started does not return the credits.</li>
            <li>Included plan credits renew each month. Unused monthly credits do not carry over.</li>
          </ul>
          <button type="submit" class="account-dialog-close">Close</button>
        </form>
      </dialog>
    `;

    const grid = section.querySelector('[data-plan-grid]');
    for (const plan of plans) {
      grid.appendChild(createPlanCard(plan, {
        current: plan.code === currentPlan,
        signedIn: Boolean(authState.signedIn),
      }));
    }

    const dialog = section.querySelector('[data-credit-dialog]');
    section.querySelector('.account-credit-help').addEventListener('click', () => dialog.showModal());
  }

  return section;
}

function createPlanCard(plan, { current, signedIn }) {
  const card = document.createElement('article');
  card.className = `account-plan-card${current ? ' is-current' : ''}`;

  const heading = document.createElement('div');
  heading.className = 'account-plan-heading';
  const title = document.createElement('h4');
  title.textContent = creditPlanLabel(plan.code);
  heading.appendChild(title);
  if (current) {
    const badge = document.createElement('span');
    badge.className = 'account-plan-badge';
    badge.textContent = 'Current';
    heading.appendChild(badge);
  }

  const price = document.createElement('div');
  price.className = 'account-plan-price';
  const amount = document.createElement('strong');
  amount.textContent = formatPlanPrice(plan);
  const period = document.createElement('span');
  period.textContent = `/ ${plan.billingPeriod || 'period'}`;
  price.append(amount, period);

  const action = document.createElement('div');
  action.className = 'account-plan-action';
  if (current) {
    action.textContent = 'Current plan';
  } else if (plan.accountRequired && !signedIn && isEnabled()) {
    action.classList.add('google-signin-holder');
    renderGoogleButton(action);
  } else if (plan.accountRequired && !signedIn) {
    action.textContent = 'Account sign-in is unavailable';
  } else {
    action.textContent = plan.accountRequired ? 'Available with an account' : 'No account required';
  }

  const features = document.createElement('ul');
  features.className = 'account-plan-features';
  for (const feature of planFeatures(plan)) {
    const item = document.createElement('li');
    item.textContent = feature;
    features.appendChild(item);
  }

  card.append(heading, price, action, features);
  return card;
}

export function formatPlanPrice(plan) {
  const currency = /^[A-Z]{3}$/.test(String(plan?.currency || '').toUpperCase())
    ? String(plan.currency).toUpperCase()
    : 'EUR';
  const minorUnits = Math.max(0, Number(plan?.priceMinorUnits) || 0);
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minorUnits / 100);
}

export function planFeatures(plan) {
  const features = [
    `${formatCreditCount(plan.grant)} included credits each ${plan.period || 'period'}`,
  ];
  if (plan.accountRequired) features.push('Use your credits on any signed-in device');
  features.push('Exact credit use shown before work starts');
  return features;
}

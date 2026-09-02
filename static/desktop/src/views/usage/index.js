import { onAuthChange } from '../../auth.js';
import { formatCreditCount } from '../../shared/credit-display.js';
import {
  refreshDesktopCredits,
  subscribeDesktopCreditState,
} from '../../shared/credit-state.js?v=20260902-credits-25';
import { getCreditActivity } from './api.js';

const ACTIVITY_STATES = new Set(['reserved', 'consumed', 'released']);

export function createUsageView() {
  const container = document.createElement('div');
  container.className = 'view settings-view usage-view';
  container.innerHTML = `
    <header class="usage-view-header">
      <h1>Usage</h1>
      <p>Recent credit reservations and completed work.</p>
    </header>
    <div class="usage-date-range" role="group" aria-label="Usage date range">
      <label>
        <span>From</span>
        <input type="date" data-usage-from>
      </label>
      <label>
        <span>To</span>
        <input type="date" data-usage-to>
      </label>
    </div>
    <section class="settings-group usage-activity" aria-labelledby="usageActivityTitle" hidden>
      <h3 id="usageActivityTitle">Recent activity</h3>
      <div class="usage-activity-body"></div>
    </section>
  `;

  const section = container.querySelector('.usage-activity');
  const body = container.querySelector('.usage-activity-body');
  const dateRange = container.querySelector('.usage-date-range');
  const fromInput = container.querySelector('[data-usage-from]');
  const toInput = container.querySelector('[data-usage-to]');
  const initialRange = defaultUsageDateRange();
  fromInput.value = initialRange.from;
  toInput.value = initialRange.to;
  syncDateConstraints(fromInput, toInput);
  let active = false;
  let configured = false;
  let creditLoading = false;
  let ownerKey = 'anonymous';
  let ownerVersion = 0;
  let filterVersion = 0;
  let entries = [];
  let loading = false;
  let error = '';
  let refreshPromise = null;

  subscribeDesktopCreditState((creditState) => {
    const refreshCompleted = creditLoading && !creditState.loading;
    configured = creditState.configured;
    creditLoading = creditState.loading;
    section.hidden = !configured;
    if (!configured) {
      entries = [];
      loading = false;
      error = '';
      render();
      return;
    }
    render();
    if (active && refreshCompleted) refresh();
  });

  onAuthChange((authState) => {
    const nextOwnerKey = authState?.signedIn && authState.userId
      ? `user:${String(authState.userId)}`
      : 'anonymous';
    if (nextOwnerKey === ownerKey) return;
    ownerKey = nextOwnerKey;
    ownerVersion += 1;
    refreshPromise = null;
    entries = [];
    loading = active && configured;
    error = '';
    render();
    if (active && configured && !creditLoading) refresh();
  });

  dateRange.addEventListener('change', (event) => {
    normalizeDateInputs(fromInput, toInput, event.target);
    filterVersion += 1;
    refreshPromise = null;
    entries = [];
    loading = active && configured;
    error = '';
    render();
    if (active && configured) refresh();
  });

  function refresh() {
    if (!configured || refreshPromise) return refreshPromise || Promise.resolve();
    const requestOwnerVersion = ownerVersion;
    const requestFilterVersion = filterVersion;
    const bounds = usageDateBounds({ from: fromInput.value, to: toInput.value });
    loading = true;
    error = '';
    render();
    const pending = getCreditActivity(bounds)
      .then((payload) => {
        if (
          requestOwnerVersion !== ownerVersion
          || requestFilterVersion !== filterVersion
        ) return;
        entries = normalizeCreditActivity(payload);
        loading = false;
        render();
      })
      .catch(() => {
        if (
          requestOwnerVersion !== ownerVersion
          || requestFilterVersion !== filterVersion
        ) return;
        loading = false;
        error = 'Credit activity is temporarily unavailable.';
        render();
      })
      .finally(() => {
        if (refreshPromise === pending) refreshPromise = null;
      });
    refreshPromise = pending;
    return pending;
  }

  function render() {
    body.replaceChildren();
    if (loading) {
      body.appendChild(createStatus('Loading credit activity…'));
      return;
    }
    if (error) {
      body.appendChild(createStatus(error));
      return;
    }
    if (entries.length === 0) {
      body.appendChild(createStatus('No credit activity yet.'));
      return;
    }

    const list = document.createElement('ul');
    list.className = 'usage-activity-list';
    for (const entry of entries) list.appendChild(createActivityRow(entry));
    body.appendChild(list);
  }

  container.__onActivate = () => {
    refreshDesktopCredits().catch(() => {});
    active = true;
    if (configured) {
      loading = true;
      render();
      if (!creditLoading) refresh();
    }
  };
  container.__onDeactivate = () => {
    active = false;
  };
  return container;
}

export function normalizeCreditActivity(payload) {
  if (!Array.isArray(payload?.activity)) return [];
  return payload.activity.flatMap((entry) => {
    const credits = Number(entry?.credits);
    const state = String(entry?.state || '');
    if (!Number.isFinite(credits) || credits < 0 || !ACTIVITY_STATES.has(state)) return [];
    return [{
      action: String(entry?.action || 'work'),
      credits: Math.trunc(credits),
      state,
      occurredAt: String(entry?.occurred_at || ''),
    }];
  });
}

export function creditActivityAction(action) {
  return String(action || '') === 'pdf_translation' ? 'PDF translation' : 'Work';
}

export function creditActivityState(state) {
  if (state === 'reserved') return 'Reserved';
  if (state === 'released') return 'Returned';
  return 'Used';
}

export function defaultUsageDateRange(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const firstDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
  return { from: localDateValue(firstDay), to: localDateValue(today) };
}

export function usageDateBounds({ from = '', to = '' } = {}) {
  const fromDate = parseLocalDate(from);
  const toDate = parseLocalDate(to);
  const toBoundary = toDate
    ? new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1)
    : null;
  return {
    fromAt: fromDate ? fromDate.toISOString() : '',
    toBefore: toBoundary ? toBoundary.toISOString() : '',
  };
}

function localDateValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDateValue(date) === value ? date : null;
}

function normalizeDateInputs(fromInput, toInput, changedInput) {
  if (fromInput.value && toInput.value && fromInput.value > toInput.value) {
    if (changedInput === fromInput) toInput.value = fromInput.value;
    else fromInput.value = toInput.value;
  }
  syncDateConstraints(fromInput, toInput);
}

function syncDateConstraints(fromInput, toInput) {
  fromInput.max = toInput.value;
  toInput.min = fromInput.value;
}

function createStatus(message) {
  const status = document.createElement('p');
  status.className = 'usage-activity-status';
  status.textContent = message;
  return status;
}

function createActivityRow(entry) {
  const item = document.createElement('li');
  const details = document.createElement('div');
  details.className = 'usage-activity-details';
  const action = document.createElement('span');
  action.className = 'usage-activity-action';
  action.textContent = creditActivityAction(entry.action);
  const occurredAt = createActivityTime(entry.occurredAt);
  details.appendChild(action);
  if (occurredAt) details.appendChild(occurredAt);

  const usage = document.createElement('div');
  usage.className = 'usage-activity-usage';
  const credits = document.createElement('strong');
  credits.textContent = `${formatCreditCount(entry.credits)} credits`;
  const state = document.createElement('span');
  state.textContent = creditActivityState(entry.state);
  usage.append(credits, state);
  item.append(details, usage);
  return item;
}

function createActivityTime(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return null;
  const time = document.createElement('time');
  time.dateTime = date.toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
  return time;
}

// Page-lifetime credit summary shared by the desktop shell and workflows.

import { getCredits } from './api.js?v=20260902-credits-23';

const listeners = new Set();

let state = initialState();
let refreshPromise = null;
let configurationVersion = 0;
let ownerKey = 'anonymous';

function initialState() {
  return {
    configured: false,
    loading: false,
    credits: null,
    plans: [],
    error: '',
  };
}

function snapshot() {
  return {
    ...state,
    credits: state.credits ? { ...state.credits } : null,
    plans: state.plans.map((plan) => ({ ...plan })),
  };
}

function publish(next) {
  state = next;
  const current = snapshot();
  for (const listener of listeners) listener(current);
  return current;
}

export function configureDesktopCredits(config) {
  const plans = normalizeCreditPlans(config?.plans);
  configurationVersion += 1;
  refreshPromise = null;
  return publish({ configured: true, loading: false, credits: null, plans, error: '' });
}

export function getDesktopCreditState() {
  return snapshot();
}

export function setDesktopCreditOwner(nextOwnerKey) {
  const next = String(nextOwnerKey || 'anonymous');
  if (next === ownerKey) return snapshot();
  ownerKey = next;
  configurationVersion += 1;
  refreshPromise = null;
  if (!state.configured) return snapshot();
  return publish({ ...state, loading: false, credits: null, error: '' });
}

export function subscribeDesktopCreditState(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export function refreshDesktopCredits() {
  if (!state.configured) return Promise.resolve(snapshot());
  if (refreshPromise) return refreshPromise;

  const version = configurationVersion;
  publish({ ...state, loading: true, error: '' });
  refreshPromise = getCredits()
    .then((payload) => {
      if (!state.configured || version !== configurationVersion) return snapshot();
      return publish({
        ...state,
        loading: false,
        credits: normalizeCredits(payload?.credits),
        error: '',
      });
    })
    .catch((error) => {
      if (!state.configured || version !== configurationVersion) return snapshot();
      publish({
        ...state,
        loading: false,
        error: String(error?.message || 'Credit balance is unavailable.'),
      });
      throw error;
    })
    .finally(() => {
      if (version === configurationVersion) refreshPromise = null;
    });
  return refreshPromise;
}

function normalizeCreditPlans(plans) {
  if (!Array.isArray(plans)) return [];
  return plans.map((plan) => {
    const grant = Number(plan?.credits_per_period);
    const priceMinorUnits = Number(plan?.price_minor_units);
    return {
      code: String(plan?.code || ''),
      grant: Number.isFinite(grant) ? Math.max(0, grant) : 0,
      period: String(plan?.period || ''),
      accountRequired: Boolean(plan?.account_required),
      priceMinorUnits: Number.isFinite(priceMinorUnits) ? Math.max(0, priceMinorUnits) : 0,
      currency: String(plan?.currency || 'EUR').toUpperCase(),
      billingPeriod: String(plan?.billing_period || 'month'),
      pdfPagesPerJob: Math.max(0, Number(plan?.pdf_pages_per_job) || 0),
      pdfPreview: Boolean(plan?.pdf_preview),
    };
  }).filter((plan) => plan.code && plan.grant > 0);
}

function normalizeCredits(credits) {
  const available = Number(credits?.available);
  const grant = Number(credits?.grant);
  return {
    plan: String(credits?.plan || ''),
    available: Number.isFinite(available) ? Math.max(0, available) : 0,
    grant: Number.isFinite(grant) ? Math.max(0, grant) : 0,
    period: String(credits?.period || ''),
    period_end: String(credits?.period_end || ''),
  };
}

export function formatCreditCount(value) {
  return Math.max(0, Number(value) || 0).toLocaleString();
}

export function creditPlanLabel(plan) {
  const code = String(plan || '').toLowerCase();
  if (code === 'free') return 'Free plan';
  if (code === 'anonymous') return 'Guest';
  return code ? `${code.charAt(0).toUpperCase()}${code.slice(1)} plan` : 'Credits';
}

export function creditGrantLabel(period) {
  return String(period || '').toLowerCase() === 'month' ? 'Monthly grant' : 'Credit grant';
}

export function formatCreditRenewal(periodEnd) {
  const date = new Date(String(periodEnd || ''));
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(date);
}

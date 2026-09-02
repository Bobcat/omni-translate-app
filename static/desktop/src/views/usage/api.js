import { authHeaders } from '../../shared/auth-headers.js';

export async function getCreditActivity({ fromAt = '', toBefore = '' } = {}) {
  const query = new URLSearchParams();
  if (fromAt) query.set('from_at', String(fromAt));
  if (toBefore) query.set('to_before', String(toBefore));
  const suffix = query.size ? `?${query}` : '';
  const response = await fetch(`/api/credits/activity${suffix}`, {
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

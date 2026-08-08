// Image entitlement and period balance shown on the mobile setup surface.

import { api } from '../api-client.js';
import { els } from '../els.js';

let fetchToken = 0;

export async function refreshImageUsageCopy() {
  const token = ++fetchToken;
  try {
    const [data, usageData] = await Promise.all([api.getEntitlements(), api.getUsage()]);
    if (token !== fetchToken) return;
    const limit = data?.entitlements?.['image_translation.max_characters_per_job'];
    if (typeof limit !== 'number' || !els.setupImageRule) return;
    let copy = `Image translation needs no account and supports up to ${limit.toLocaleString()} translatable characters per image.`;
    const characters = (usageData?.usage || [])
      .find((entry) => entry.metric === 'translation.source_characters');
    if (typeof characters?.remaining === 'number' && typeof characters?.limit === 'number') {
      copy += ` Character balance: ${characters.remaining.toLocaleString()} of ${characters.limit.toLocaleString()} left`;
      copy += usageBreakdown(characters);
      copy += `${formatResetDate(characters.period_end)}.`;
    }
    els.setupImageRule.textContent = copy;
  } catch {
    // Keep the current product-limit copy already rendered in the document.
  }
}

function usageBreakdown(entry) {
  const consumed = Number(entry?.consumed || 0);
  const reserved = Number(entry?.reserved || 0);
  return ` · ${consumed.toLocaleString()} used · ${reserved.toLocaleString()} pending`;
}

function formatResetDate(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return '';
  return ` · resets ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date)}`;
}

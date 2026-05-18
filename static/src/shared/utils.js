// Tiny generic helpers. Add new ones sparingly — anything that grows a
// real domain should move to its own module.

export function cloneSettings(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

export function mergeSettings(base, override) {
  const merged = cloneSettings(base);
  mergeSettingsInto(merged, override || {});
  return merged;
}

export function mergeSettingsInto(target, override) {
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      mergeSettingsInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

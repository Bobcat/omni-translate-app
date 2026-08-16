// Shared microphone-level mapping for the mobile and desktop recording halos.

export function micHaloVisual(value, { listening = false } = {}) {
  const level = normalizeMicLevel(value);
  const haloLevel = listening
    ? Math.min(1, 0.4 + 0.6 * levelToHaloUnit(level))
    : 0;
  const clipRisk = listening && level >= 0.95;
  const hot = listening && level >= 0.85;
  const red = clipRisk ? 185 : hot ? 245 : 59;
  const green = clipRisk ? 28 : hot ? 158 : 130;
  const blue = clipRisk ? 28 : hot ? 11 : 246;
  const alpha = haloLevel ? 0.08 + haloLevel * (clipRisk ? 0.42 : hot ? 0.36 : 0.3) : 0;

  return {
    level,
    clipRisk,
    scale: (1 + haloLevel * 0.55).toFixed(3),
    color: haloLevel
      ? `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`
      : 'transparent',
  };
}

export function normalizeMicLevel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

function levelToHaloUnit(level) {
  // Visual-only gain keeps the halo responsive on devices that report very
  // low raw peaks. The dB mapping spreads quiet-to-loud over the full range.
  const visual = Math.min(1, level * 8);
  if (visual <= 0) return 0;
  const db = 20 * Math.log10(visual);
  return Math.max(0, Math.min(1, (db + 50) / 50));
}

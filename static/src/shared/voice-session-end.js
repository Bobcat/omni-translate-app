const SESSION_LIMIT_REASONS = new Set([
  'session_duration_limit',
  'session_storage_limit',
]);

export function voiceSessionEndMessage(message) {
  if (!SESSION_LIMIT_REASONS.has(String(message?.reason || ''))) return '';
  return String(message?.message || 'Voice session limit reached.');
}

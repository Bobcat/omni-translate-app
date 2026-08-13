export function accountInitials(email) {
  const localPart = String(email || '').trim().split('@')[0];
  const parts = localPart.split(/[._-]+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return (parts[0] || 'A').slice(0, 2).toUpperCase();
}

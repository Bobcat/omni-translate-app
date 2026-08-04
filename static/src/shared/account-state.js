// Call once when an auth transition changes the principal behind app state.
// The first notification establishes the baseline; token refreshes keep it.

export function createAccountChangeGuard(onAccountChanged) {
  let current = null;

  return (authState) => {
    const next = authState?.signedIn ? `user:${String(authState.userId || '')}` : 'anonymous';
    if (current !== null && next !== current) onAccountChanged();
    current = next;
  };
}

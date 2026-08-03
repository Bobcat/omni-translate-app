// Account-scoped PDF state must not survive a sign-out or a direct switch to
// another authenticated user. Token refreshes for the same user are ignored.

export function createAccountChangeGuard(onAccountLeft) {
  let currentUserId = '';

  return (authState) => {
    const nextUserId = authState?.signedIn ? String(authState.userId || '') : '';
    if (currentUserId && nextUserId !== currentUserId) onAccountLeft();
    currentUserId = nextUserId;
  };
}

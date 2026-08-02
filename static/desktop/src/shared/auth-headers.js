// Bearer-token plumbing for the API client. The auth module registers a token
// provider at init; every outgoing request merges the provider's current token
// (when non-empty) into its headers as `Authorization: Bearer <token>`.
// DOM-less on purpose: unit-tested directly (tests/js/auth-headers.test.mjs).

let tokenProvider = null;

export function setAuthTokenProvider(provider) {
  tokenProvider = typeof provider === 'function' ? provider : null;
}

export function authHeaders(base = {}) {
  const headers = { ...base };
  const token = tokenProvider ? String(tokenProvider() || '') : '';
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

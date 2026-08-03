// Tests for the bearer-token header helper (node --test, DOM-less). Both
// frontends carry their own copy by convention — mobile under static/src,
// desktop under static/desktop/src — and both are covered here. The auth
// module registers a provider closure once at init; token changes (sign-in,
// sign-out, refresh) must be visible on the very next authHeaders() call.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as mobile from '../../static/src/shared/auth-headers.js';
import * as desktop from '../../static/desktop/src/shared/auth-headers.js';

const copies = [
  ['mobile', mobile],
  ['desktop', desktop],
];

for (const [name, mod] of copies) {
  test(`${name}: no token provider -> no Authorization header`, () => {
    mod.setAuthTokenProvider(null);
    assert.deepEqual(mod.authHeaders(), {});
    assert.deepEqual(mod.authHeaders({ Accept: 'application/json' }), { Accept: 'application/json' });
  });

  test(`${name}: empty token -> no Authorization header`, () => {
    mod.setAuthTokenProvider(() => '');
    assert.deepEqual(mod.authHeaders(), {});
  });

  test(`${name}: token -> Bearer header, merged with base headers`, () => {
    mod.setAuthTokenProvider(() => 'token-abc');
    assert.deepEqual(mod.authHeaders(), { Authorization: 'Bearer token-abc' });
    assert.deepEqual(mod.authHeaders({ Accept: 'application/json' }), {
      Accept: 'application/json',
      Authorization: 'Bearer token-abc',
    });
  });

  test(`${name}: a provider change is reflected on the next call`, () => {
    mod.setAuthTokenProvider(() => 'first');
    assert.equal(mod.authHeaders().Authorization, 'Bearer first');
    mod.setAuthTokenProvider(() => 'second');
    assert.equal(mod.authHeaders().Authorization, 'Bearer second');
    mod.setAuthTokenProvider(() => '');
    assert.deepEqual(mod.authHeaders(), {});
  });
}

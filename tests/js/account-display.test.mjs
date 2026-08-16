import assert from 'node:assert/strict';
import test from 'node:test';

import { accountInitials } from '../../static/shared/account-display.js';

test('account initials use the email local part without exposing the address', () => {
  assert.equal(accountInitials('gunnar@example.com'), 'GU');
  assert.equal(accountInitials('gunnar.uhl@example.com'), 'GU');
  assert.equal(accountInitials(''), 'A');
});

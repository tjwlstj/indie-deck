import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGogSearchAuthority } from '../../desktop/src/gog-search-authority.ts';

const a = '0123456789abcdef', b = 'fedcba9876543210', c = 'aaaaaaaaaaaaaaaa';
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64);
const candidate = { id: '1234', name: 'Test game', imageHash: hash };

test('results and selections are game-scoped and never expose image hashes', () => {
  const authority = createGogSearchAuthority();
  const aToken = authority.begin(a), bToken = authority.begin(b);
  assert.deepEqual(authority.complete(a, aToken, [candidate]), [{ id: '1234', name: 'Test game' }]);
  assert.deepEqual(authority.complete(b, bToken, [{ id: '5678', name: 'Other game', imageHash: otherHash }]), [{ id: '5678', name: 'Other game' }]);
  assert.equal(authority.grant(b, '1234'), undefined);
  assert.equal(authority.grant(a, '../1234'), undefined);
  const grant = authority.grant(a, '1234');
  assert.ok(grant);
  assert.equal(authority.isCurrent(a, '1234', grant), true);
  assert.equal(authority.isCurrent(b, '1234', grant), false);
});

test('latest search wins before and after an asynchronous image fetch', () => {
  const authority = createGogSearchAuthority();
  const first = authority.begin(a);
  authority.complete(a, first, [candidate]);
  const pending = authority.grant(a, '1234');
  assert.ok(pending);
  const next = authority.begin(a);
  assert.equal(authority.isCurrent(a, '1234', pending), false);
  assert.deepEqual(authority.complete(a, first, [candidate]), []);
  assert.deepEqual(authority.complete(a, next, [{ ...candidate, imageHash: otherHash }]), [{ id: '1234', name: 'Test game' }]);
  assert.equal(authority.isCurrent(a, '1234', pending), false);
  assert.deepEqual(authority.complete(a, next, [candidate]), []);
});

test('bounded eviction and malformed candidates revoke or deny pending selections', () => {
  const authority = createGogSearchAuthority(2);
  const first = authority.begin(a);
  authority.complete(a, first, [candidate]);
  const pending = authority.grant(a, '1234'); assert.ok(pending);
  const second = authority.begin(b);
  assert.deepEqual(authority.complete(b, second, [
    { ...candidate, id: '../1' }, { ...candidate, imageHash: 'not-a-hash' },
    { ...candidate, id: '5678', name: 'invalid\nname' },
  ]), []);
  assert.equal(authority.grant(b, '5678'), undefined);
  authority.begin(c);
  assert.equal(authority.isCurrent(a, '1234', pending), false);
  assert.equal(authority.grant(a, '1234'), undefined);
  assert.deepEqual(authority.complete(a, first, [candidate]), []);
});

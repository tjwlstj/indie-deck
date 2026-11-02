import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptsStoreSnapshot, acceptStoreConnectionsRead, applyStoreConnectionsPayload, beginStoreConnectionsRead,
  failStoreConnectionsRead, storeCandidatePresentation, storeHandoffMessageKey, applyStoreConnectionsMutation, storeLinksForGame,
} from '../../desktop/renderer/store-model.js';

function payload(revision = 1, id = 'saved-link') {
  return { snapshot: { schemaVersion: 1, revision, links: [{ id, provider: 'steam', productId: '123' }] },
    providers: [{ id: 'steam', authMode: 'external-browser' }], products: [{ id: 'managed-a', title: 'A' }] };
}

test('a delayed connection list or failure cannot undo a successful save or removal', () => {
  const state: any = { storeConnections: payload(1), storeRequestToken: 0, storeReadError: null };
  const oldRead = beginStoreConnectionsRead(state);
  assert.equal(applyStoreConnectionsPayload(state, payload(2, 'newer-link')), true);
  assert.equal(acceptStoreConnectionsRead(state, oldRead, payload(1)), false);
  assert.equal(failStoreConnectionsRead(state, oldRead, 'old disk error'), false);
  assert.equal(state.storeConnections.snapshot.links[0].id, 'newer-link');
  assert.equal(state.storeReadError, null);
  assert.equal(applyStoreConnectionsPayload(state, { ...payload(3), snapshot: { schemaVersion: 1, revision: 3, links: [] } }), true);
  const nextRead = beginStoreConnectionsRead(state);
  assert.equal(acceptStoreConnectionsRead(state, nextRead, payload(2)), false);
  assert.deepEqual(state.storeConnections.snapshot.links, []);
  assert.equal(state.storeReadError, null);
});

test('current catalog failure preserves visible connections and disables saved-state mutation until a fresh read', () => {
  const state: any = { storeConnections: payload(1), storeRequestToken: 0, storeReadError: null };
  const read = beginStoreConnectionsRead(state);
  assert.equal(acceptStoreConnectionsRead(state, read, { snapshot: null, error: 'ui.stores.error.connectionsCorrupt' }), false);
  assert.equal(state.storeConnections.snapshot.links.length, 1);
  assert.equal(state.storeReadError, 'ui.stores.error.connectionsCorrupt');
  const candidate = { id: 'issued-candidate', provider: 'steam', productId: '123', url: 'https://store.steampowered.com/app/123/' };
  assert.equal(storeCandidatePresentation(candidate, payload().products, 'managed-a', false, state.storeReadError).canSave, false);
  const retry = beginStoreConnectionsRead(state);
  assert.equal(acceptStoreConnectionsRead(state, retry, payload(2)), true);
  assert.equal(state.storeReadError, null);
  assert.equal(storeCandidatePresentation(candidate, payload().products, 'managed-a').canSave, true);
});

test('a committed mutation followed by a response-read failure blocks changes without discarding the visible record', () => {
  const state: any = { storeConnections: payload(2), storeRequestToken: 0, storeReadError: null };
  const oldRead = beginStoreConnectionsRead(state);
  assert.equal(applyStoreConnectionsMutation(state, { snapshot: null, error: 'ui.stores.error.connectionsCorrupt' }), false);
  assert.equal(state.storeConnections.snapshot.revision, 2);
  assert.equal(state.storeReadError, 'ui.stores.error.connectionsCorrupt');
  assert.equal(acceptStoreConnectionsRead(state, oldRead, payload(2)), false);
  assert.equal(state.storeReadError, 'ui.stores.error.connectionsCorrupt');
  const retry = beginStoreConnectionsRead(state);
  assert.equal(acceptStoreConnectionsRead(state, retry, payload(3)), true);
  assert.equal(state.storeReadError, null);
});

test('product-link review needs an issued candidate and an existing explicitly selected managed product', () => {
  const candidate = { id: 'issued-candidate', provider: 'booth', productId: '456', url: 'https://booth.pm/en/items/456' };
  assert.equal(storeCandidatePresentation(candidate, payload().products).canSave, true);
  assert.equal(storeCandidatePresentation(candidate, payload().products, 'managed-a').canSave, true);
  assert.equal(storeCandidatePresentation(candidate, payload().products, 'removed-product').canSave, false);
  assert.equal(storeCandidatePresentation(candidate, payload().products, '', true).canSave, false);
  assert.equal(storeCandidatePresentation({ ...candidate, id: undefined }, payload().products).canSave, false);
  assert.equal(storeCandidatePresentation(null, payload().products).canSave, false);
  assert.equal(storeCandidatePresentation(candidate, payload().products).authenticated, false);
  assert.equal(storeCandidatePresentation(candidate, payload().products).ownershipVerified, false);
});

test('browser and client acknowledgements never become an authenticated or installed status', () => {
  assert.equal(storeHandoffMessageKey({ opened: true, kind: 'browser', authentication: 'unverified' }), 'ui.stores.openedBrowser');
  assert.equal(storeHandoffMessageKey({ opened: true, kind: 'official-client', authentication: 'unverified' }), 'ui.stores.openedClient');
  assert.equal(storeHandoffMessageKey({ opened: true, kind: 'browser', authentication: 'verified', installed: true }), 'ui.stores.openedBrowser');
  for (const result of [null, {}, { opened: false, kind: 'browser' }, { opened: true, kind: 'renderer-program' }]) {
    assert.equal(storeHandoffMessageKey(result), 'ui.stores.error.handoff');
  }
});

test('malformed snapshots cannot replace current store connection state', () => {
  const valid = payload().snapshot;
  assert.equal(acceptsStoreSnapshot(null, valid), true);
  for (const invalid of [null, {}, { ...valid, schemaVersion: 2 }, { ...valid, revision: -1 },
    { ...valid, revision: 1.5 }, { ...valid, links: null }, { ...valid, links: [{}] }]) {
    assert.equal(acceptsStoreSnapshot(valid, invalid), false);
  }
});

test('game detail store references follow explicit managed product identity and never equal titles', () => {
  const catalog = { products: [{ id: 'game-a', title: 'Same title' }, { id: 'game-b', title: 'Same title' }],
    installations: [{ id: 'version-a', archiveId: 'archive-a', productId: 'game-a' },
      { id: 'version-b', archiveId: 'archive-b', productId: 'game-b' }] };
  const records = [{ id: 'archive-a', gameId: 'path-a' }, { id: 'archive-b', gameId: 'path-b' }];
  const snapshot = { links: [{ id: 'shop-a', managedProductId: 'game-a', title: 'Same title' },
    { id: 'shop-b', managedProductId: 'game-b', title: 'Same title' }, { id: 'unlinked', title: 'Same title' }] };
  assert.deepEqual(storeLinksForGame(catalog, records, snapshot, 'path-a').map((link) => link.id), ['shop-a']);
  assert.deepEqual(storeLinksForGame(catalog, records, snapshot, 'path-b').map((link) => link.id), ['shop-b']);
  assert.deepEqual(storeLinksForGame(catalog, records, snapshot, 'unknown'), []);
  assert.deepEqual(storeLinksForGame(catalog, records, { links: [] }, 'path-a'), []);
});

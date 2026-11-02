/** Renderer ordering and presentation only. Main validates providers and ids. */
import { managedInstallationForGame } from './archive-model.js';

export function storeLinksForGame(catalog, records, snapshot, gameId) {
  if (typeof gameId !== 'string' || !gameId) return [];
  const managed = managedInstallationForGame(catalog, records, gameId);
  if (!managed || !Array.isArray(snapshot?.links)) return [];
  return snapshot.links.filter((link) => link.managedProductId === managed.product.id);
}
function validSnapshot(snapshot) {
  return snapshot?.schemaVersion === 1 && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 &&
    Array.isArray(snapshot.links) && snapshot.links.every((link) => typeof link?.id === 'string' &&
      typeof link.provider === 'string' && typeof link.productId === 'string');
}

export function acceptsStoreSnapshot(current, incoming) {
  return validSnapshot(incoming) && (!validSnapshot(current) || incoming.revision >= current.revision);
}

export function beginStoreConnectionsRead(state) {
  state.storeRequestToken = (state.storeRequestToken ?? 0) + 1;
  state.storeReadPending = true;
  return state.storeRequestToken;
}

/** Direct mutations invalidate older queued list responses, including failures. */
export function applyStoreConnectionsPayload(state, payload) {
  const current = state.storeConnections?.snapshot;
  if (!payload || !acceptsStoreSnapshot(current, payload.snapshot)) return false;
  state.storeConnections = payload;
  state.storeConnectionsLoaded = true;
  state.storeReadError = payload.error || null;
  state.storeReadPending = false;
  state.storeRequestToken = (state.storeRequestToken ?? 0) + 1;
  return true;
}

export function acceptStoreConnectionsRead(state, token, payload) {
  if (token !== state.storeRequestToken) return false;
  if (applyStoreConnectionsPayload(state, payload)) return true;
  state.storeReadPending = false;
  if (validSnapshot(payload?.snapshot) && validSnapshot(state.storeConnections?.snapshot) &&
      payload.snapshot.revision < state.storeConnections.snapshot.revision) return false;
  state.storeConnectionsLoaded = true;
  if (payload?.error) {
    // Keep the last visible records. They cannot become mutable authority while
    // the current read failed, and corrupt data is never replaced in the UI.
    state.storeReadError = payload.error;
    if (!state.storeConnections && Array.isArray(payload.providers)) {
      state.storeConnections = { ...payload, snapshot: null };
    }
  } else state.storeReadError = 'ui.stores.error.unavailable';
  return false;
}

export function failStoreConnectionsRead(state, token, error) {
  if (token !== state.storeRequestToken) return false;
  state.storeReadPending = false;
  state.storeConnectionsLoaded = true;
  state.storeReadError = typeof error === 'string' ? error : error?.message || 'ui.stores.error.unavailable';
  return true;
}

/** A save can commit before its response is assembled. Preserve that uncertainty
 * as a read error instead of leaving old visible records writable. */
export function applyStoreConnectionsMutation(state, payload) {
  if (applyStoreConnectionsPayload(state, payload)) return true;
  const token = beginStoreConnectionsRead(state);
  failStoreConnectionsRead(state, token, payload?.error || 'ui.stores.error.unavailable');
  return false;
}

export function storeCandidatePresentation(candidate, products, managedProductId = '', blocked = false, readError = false) {
  const validCandidate = Boolean(candidate && typeof candidate.id === 'string' && candidate.id.length > 0 &&
    typeof candidate.provider === 'string' && typeof candidate.productId === 'string' && typeof candidate.url === 'string');
  const validProduct = !managedProductId || (Array.isArray(products) && products.some((product) => product.id === managedProductId));
  return { canSave: validCandidate && validProduct && !blocked && !readError, authenticated: false, ownershipVerified: false };
}

/** Browser or protocol dispatch is never proof of login, entitlement or install. */
export function storeHandoffMessageKey(result) {
  if (result?.opened !== true) return 'ui.stores.error.handoff';
  return result.kind === 'official-client' ? 'ui.stores.openedClient'
    : result.kind === 'browser' ? 'ui.stores.openedBrowser' : 'ui.stores.error.handoff';
}

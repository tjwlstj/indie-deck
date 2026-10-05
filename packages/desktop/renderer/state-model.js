/**
 * Pure renderer state transitions.
 *
 * This module deliberately has no DOM or Electron dependency. The launcher can
 * therefore use the exact same identity/revision rules in production and in a
 * small Node test without pretending that event ordering is deterministic.
 */

function sequenceOf(value) {
  return Number.isSafeInteger(value) ? value : -1;
}

function normaliseLog(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

export function isOperationActive(operation) {
  return Boolean(operation && (!operation.outcome || operation.refreshing));
}

export function createProvisionalOperation({ requestId, gameId, kind, planId }) {
  return {
    requestId,
    gameId,
    kind,
    ...(planId ? { planId } : {}),
    sequence: -1,
    phase: 'queued',
    stepIndex: 0,
    stepCount: 0,
    received: 0,
    total: 0,
    log: [],
    outcome: null,
  };
}

/** Adds the main-issued id without letting a late handshake replace a new job. */
export function applyOperationHandshake(operation, handshake) {
  if (!operation || operation.requestId !== handshake?.requestId) return operation;
  if (operation.operationId && operation.operationId !== handshake.operationId) return operation;
  return { ...operation, operationId: handshake.operationId };
}

function sameOperation(operation, event) {
  if (!operation || !event || operation.requestId !== event.requestId) return false;
  if (operation.operationId && event.operationId !== operation.operationId) return false;
  return true;
}

/**
 * Applies a progress event/snapshot only when its identity and sequence are
 * newer. Before the start handshake, requestId is the provisional correlation
 * key; after it, operationId is required as well.
 */
export function reduceOperationProgress(operation, event) {
  if (!operation && event) {
    return {
      ...event,
      sequence: sequenceOf(event.sequence),
      log: normaliseLog(event.log),
      outcome: null,
    };
  }
  if (!sameOperation(operation, event)) return operation;
  if (sequenceOf(event.sequence) <= sequenceOf(operation.sequence)) return operation;

  const log = normaliseLog(operation.log);
  if (typeof event.log === 'string' && event.log.length > 0) log.push(event.log);
  else if (Array.isArray(event.log)) log.splice(0, log.length, ...normaliseLog(event.log));

  const transferChanged =
    event.phase !== operation.phase || (event.assetId !== undefined && event.assetId !== operation.assetId);
  return {
    ...operation,
    ...event,
    operationId: event.operationId ?? operation.operationId,
    received: event.received ?? (transferChanged ? 0 : operation.received),
    total: event.total ?? (transferChanged ? 0 : operation.total),
    fromCache: event.fromCache ?? (transferChanged ? false : operation.fromCache),
    log,
    outcome: null,
  };
}

/** Restores an active main-process snapshot after a renderer reload. */
export function restoreOperationSnapshot(operation, snapshot) {
  if (!snapshot) return operation;
  if (operation) {
    if (!sameOperation(operation, snapshot)) {
      // A currently active main snapshot outranks an unrelated retained
      // terminal card that happened to arrive first during reload.
      return operation.outcome
        ? { ...snapshot, sequence: sequenceOf(snapshot.sequence), log: normaliseLog(snapshot.logs ?? snapshot.log), outcome: null }
        : operation;
    }
    if (sequenceOf(snapshot.sequence) === sequenceOf(operation.sequence) && !operation.outcome) {
      // A live event carries only its newest log line, while current() carries
      // the accumulated snapshot logs. When both describe the exact same
      // operation sequence, the snapshot is authoritative for log history.
      const snapshotLog = normaliseLog(snapshot.logs ?? snapshot.log);
      if (snapshotLog.length > normaliseLog(operation.log).length) return { ...operation, log: snapshotLog };
      return operation;
    }
    if (sequenceOf(snapshot.sequence) < sequenceOf(operation.sequence)) return operation;
  }
  return {
    ...snapshot,
    sequence: sequenceOf(snapshot.sequence),
    log: normaliseLog(snapshot.logs ?? snapshot.log),
    outcome: null,
  };
}

/** Turns the matching operation into a durable, dismissible terminal card. */
export function reduceOperationOutcome(operation, outcome) {
  if (!outcome) return operation;
  if (operation && !sameOperation(operation, outcome)) return operation;
  if (operation && sequenceOf(outcome.sequence) <= sequenceOf(operation.sequence)) return operation;

  return {
    ...(operation ?? {}),
    ...outcome,
    sequence: sequenceOf(outcome.sequence),
    log: normaliseLog(outcome.logs ?? operation?.log),
    outcome,
  };
}

/** During boot there can be several ACK-pending terminal results. They are
 * returned oldest-first by main; keep an active snapshot, otherwise feature
 * the newest retained result after all post-states have been merged. */
export function recoverRetainedOutcome(operation, outcomes) {
  if (isOperationActive(operation)) return operation;
  const retained = Array.isArray(outcomes) ? outcomes : [];
  if (retained.length === 0) return operation;
  return reduceOperationOutcome(null, retained[retained.length - 1]);
}

function revisionOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Applies a full library payload unless a newer revision is already visible. */
export function mergeLibraryPayload(state, payload) {
  const revision = revisionOf(payload?.index?.revision);
  if (revision < revisionOf(state.libraryRevision)) return false;

  state.games = payload?.index?.games ?? [];
  state.stats = payload?.stats ?? null;
  state.audits = new Map((payload?.audits ?? []).map((audit) => [audit.id, audit]));
  state.libraryRevision = revision;
  return true;
}

/**
 * Atomically merges post-mutation library state while applying detail/config
 * only to the still-selected game. A mutation for A must update A's list row
 * even when the user has moved on to B.
 */
export function mergePostMutationState(state, postState) {
  if (!postState) return { library: false, detail: false, translatorConfig: false };

  const library = postState.library ? mergeLibraryPayload(state, postState.library) : false;
  const gameId = postState.gameId;
  const incomingRevision = revisionOf(postState.gameRevision);
  const knownRevision = revisionOf(state.gameRevisions.get(gameId));
  const revisionIsCurrent = incomingRevision >= knownRevision;

  let detail = false;
  let translatorConfig = false;
  if (revisionIsCurrent) {
    state.gameRevisions.set(gameId, incomingRevision);

    if (postState.translatorConfig !== undefined) {
      if (postState.translatorConfig === null) state.translatorConfigs.delete(gameId);
      else state.translatorConfigs.set(gameId, postState.translatorConfig);
      translatorConfig = true;
    }

    if (state.selected === gameId && postState.detail !== undefined) {
      state.detail = postState.detail;
      detail = true;
    }
  }

  return { library, detail, translatorConfig };
}

/** Applies a normal game:detail response only for the newest selection call. */
export function acceptDetailResponse(state, gameId, requestToken, response) {
  if (state.selected !== gameId || state.selectionRequestToken !== requestToken) return false;
  const incomingRevision = revisionOf(response?.gameRevision);
  const knownRevision = revisionOf(state.gameRevisions.get(gameId));
  if (incomingRevision < knownRevision) return false;
  state.gameRevisions.set(gameId, incomingRevision);
  if (response?.translatorConfig !== undefined) {
    if (response.translatorConfig === null) state.translatorConfigs.delete(gameId);
    else state.translatorConfigs.set(gameId, response.translatorConfig);
  }
  state.detail = response;
  return true;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptDetailResponse,
  applyOperationHandshake,
  createProvisionalOperation,
  mergeLibraryPayload,
  mergePostMutationState,
  reduceOperationOutcome,
  reduceOperationProgress,
  recoverRetainedOutcome,
  restoreOperationSnapshot,
  isOperationActive,
} from '../../desktop/renderer/state-model.js';

function rendererState(selected: string | null = null) {
  return {
    games: [],
    stats: null,
    audits: new Map(),
    libraryRevision: 0,
    gameRevisions: new Map<string, number>(),
    translatorConfigs: new Map(),
    selected,
    selectionRequestToken: 0,
    detail: null,
  };
}

test('operation progress is correlated by request/operation id and monotonic sequence', () => {
  let operation = createProvisionalOperation({ requestId: 'request-a', gameId: 'game-a', kind: 'install', planId: 'plan-a' });
  operation = reduceOperationProgress(operation, {
    requestId: 'request-a',
    operationId: 'operation-a',
    gameId: 'game-a',
    kind: 'install',
    sequence: 1,
    phase: 'download',
    assetId: 'asset-a',
    received: 50,
    total: 100,
    log: 'download started',
  });
  assert.equal(operation.operationId, 'operation-a');
  assert.equal(operation.phase, 'download');
  assert.deepEqual(operation.log, ['download started']);

  const downloadLog = reduceOperationProgress(operation, {
    requestId: 'request-a', operationId: 'operation-a', gameId: 'game-a', kind: 'install',
    sequence: 2, phase: 'download', log: 'still downloading',
  });
  assert.equal(downloadLog.received, operation.received);
  assert.equal(downloadLog.total, operation.total);

  const verify = reduceOperationProgress(downloadLog, {
    requestId: 'request-a',
    operationId: 'operation-a',
    gameId: 'game-a',
    kind: 'install',
    sequence: 3,
    phase: 'verify',
  });
  assert.equal(verify.received, 0);
  assert.equal(verify.total, 0);
  assert.equal(verify.fromCache, false);

  const stale = reduceOperationProgress(verify, { ...verify, sequence: 3, phase: 'extract' });
  assert.equal(stale, verify);
  const foreign = reduceOperationProgress(verify, {
    ...verify,
    requestId: 'request-b',
    operationId: 'operation-b',
    sequence: 4,
    phase: 'extract',
  });
  assert.equal(foreign, verify);

  const unrelatedOutcome = reduceOperationOutcome(verify, {
    requestId: 'request-b', operationId: 'operation-b', gameId: 'game-b', kind: 'uninstall',
    sequence: 99, status: 'failed', mutationStatus: 'partial', rollbackStatus: 'partial',
    rollbackFailures: [], refreshStatus: 'failed', logs: ['unrelated'],
  });
  assert.equal(unrelatedOutcome, verify);
});

test('a late start handshake cannot attach to a newer provisional operation', () => {
  const current = createProvisionalOperation({ requestId: 'new', gameId: 'game-b', kind: 'uninstall' });
  assert.equal(applyOperationHandshake(current, { requestId: 'old', operationId: 'operation-old' }), current);
  assert.equal(applyOperationHandshake(current, { requestId: 'new', operationId: 'operation-new' }).operationId, 'operation-new');
});

test('a terminal card blocks new mutations only while its state refresh is running', () => {
  assert.equal(isOperationActive({ outcome: { status: 'success' } }), false);
  assert.equal(isOperationActive({ outcome: { status: 'success' }, refreshing: true }), true);
});

test('renderer reload restores an active snapshot and a terminal outcome with logs', () => {
  const snapshot = {
    requestId: 'request-a',
    operationId: 'operation-a',
    gameId: 'game-a',
    kind: 'install',
    sequence: 7,
    phase: 'extract',
    logs: ['one', 'two'],
  };
  const active = restoreOperationSnapshot(null, snapshot);
  assert.equal(active.phase, 'extract');
  assert.deepEqual(active.log, ['one', 'two']);

  const terminal = reduceOperationOutcome(active, {
    ...snapshot,
    sequence: 8,
    status: 'needs-user-action',
    mutationStatus: 'committed',
    rollbackStatus: 'not-run',
    rollbackFailures: [],
    refreshStatus: 'complete',
    logs: ['one', 'two', 'manual step remains'],
  });
  assert.equal(terminal.outcome.status, 'needs-user-action');
  assert.deepEqual(terminal.log, ['one', 'two', 'manual step remains']);

  const nextActive = restoreOperationSnapshot(terminal, {
    requestId: 'request-b', operationId: 'operation-b', gameId: 'game-b', kind: 'uninstall',
    sequence: 1, phase: 'preflight', stepIndex: 0, stepCount: 0, logs: ['new operation'],
  });
  assert.equal(nextActive.operationId, 'operation-b');
  assert.equal(nextActive.outcome, null);
  assert.deepEqual(nextActive.log, ['new operation']);
});

test('same-sequence current snapshot restores log history omitted by the live progress event', () => {
  const live = reduceOperationProgress(null, {
    requestId: 'request-a', operationId: 'operation-a', gameId: 'game-a', kind: 'install',
    sequence: 7, phase: 'extract', log: 'latest line',
  });
  assert.deepEqual(live.log, ['latest line']);

  const restored = restoreOperationSnapshot(live, {
    requestId: 'request-a', operationId: 'operation-a', gameId: 'game-a', kind: 'install',
    sequence: 7, phase: 'extract', logs: ['earlier line', 'latest line'],
  });
  assert.deepEqual(restored.log, ['earlier line', 'latest line']);
  assert.equal(restored.sequence, 7);
});

test('renderer reload features the newest of several retained outcomes', () => {
  const oldSuccess = {
    requestId: 'old', operationId: 'operation-old', gameId: 'game-a', kind: 'install',
    sequence: 4, status: 'success', mutationStatus: 'committed', rollbackStatus: 'not-run',
    rollbackFailures: [], refreshStatus: 'complete', logs: ['old success'],
  };
  const latestFailure = {
    requestId: 'new', operationId: 'operation-new', gameId: 'game-b', kind: 'uninstall',
    sequence: 3, status: 'failed', mutationStatus: 'partial', rollbackStatus: 'partial',
    rollbackFailures: [], refreshStatus: 'failed', logs: ['latest failure'],
  };
  const recovered = recoverRetainedOutcome(null, [oldSuccess, latestFailure]);
  assert.equal(recovered.operationId, 'operation-new');
  assert.equal(recovered.outcome.status, 'failed');
  assert.deepEqual(recovered.log, ['latest failure']);

  const active = restoreOperationSnapshot(null, {
    requestId: 'active', operationId: 'operation-active', gameId: 'game-c', kind: 'install',
    sequence: 2, phase: 'download', logs: [],
  });
  assert.equal(recoverRetainedOutcome(active, [oldSuccess, latestFailure]), active);
});

test('postState updates game A in the library while selected game B keeps its detail', () => {
  const state = rendererState('game-b');
  state.detail = { profile: { id: 'game-b', name: 'B' }, gameRevision: 2 };
  state.gameRevisions.set('game-b', 2);

  const result = mergePostMutationState(state, {
    gameId: 'game-a',
    gameRevision: 4,
    library: {
      index: { revision: 4, games: [{ id: 'game-a', name: 'A', installedTranslators: [{ translatorId: 'x' }] }] },
      stats: { total: 1, withTranslator: 1 },
      audits: [],
    },
    detail: { profile: { id: 'game-a', name: 'A' }, gameRevision: 4 },
    translatorConfig: { config: { translatorId: 'x' }, gameRevision: 4 },
  });

  assert.equal(result.library, true);
  assert.equal(result.detail, false);
  assert.equal(state.games[0].id, 'game-a');
  assert.equal(state.detail.profile.id, 'game-b');
  assert.equal(state.translatorConfigs.get('game-a').config.translatorId, 'x');
});

test('older library and detail responses cannot overwrite newer post-mutation state', () => {
  const state = rendererState('game-a');
  state.libraryRevision = 9;
  state.gameRevisions.set('game-a', 6);
  state.selectionRequestToken = 3;
  state.detail = { profile: { id: 'game-a', version: 'new' }, gameRevision: 6 };

  assert.equal(
    mergeLibraryPayload(state, { index: { revision: 8, games: [{ id: 'stale' }] }, stats: {}, audits: [] }),
    false,
  );
  assert.equal(state.games.length, 0);

  assert.equal(
    mergeLibraryPayload(state, { index: { revision: 9, games: [{ id: 'same-revision-authoritative' }] }, stats: {}, audits: [] }),
    true,
  );
  assert.equal(state.games[0].id, 'same-revision-authoritative');

  assert.equal(
    acceptDetailResponse(state, 'game-a', 3, { profile: { id: 'game-a', version: 'old' }, gameRevision: 5 }),
    false,
  );
  assert.equal(state.detail.profile.version, 'new');
});

test('selection tokens reject A to B to A responses that return out of order', () => {
  const state = rendererState('game-a');
  state.selectionRequestToken = 3;

  assert.equal(acceptDetailResponse(state, 'game-a', 1, { profile: { id: 'game-a', marker: 'first' }, gameRevision: 1 }), false);
  assert.equal(acceptDetailResponse(state, 'game-b', 2, { profile: { id: 'game-b' }, gameRevision: 1 }), false);
  assert.equal(acceptDetailResponse(state, 'game-a', 3, { profile: { id: 'game-a', marker: 'latest' }, gameRevision: 1 }), true);
  assert.equal(state.detail.profile.marker, 'latest');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationManager, type OperationOutcome, type OperationProgress, type OperationResult } from '../../desktop/src/operations.ts';

function harness() {
  const queue: (() => Promise<void>)[] = [];
  const progress: OperationProgress[] = [];
  const outcomes: OperationOutcome[] = [];
  const manager = new OperationManager({
    enqueue: (work) => queue.push(work), progress: (event) => progress.push(event), outcome: (event) => outcomes.push(event),
  });
  return { manager, queue, progress, outcomes };
}

const gameId = '0123456789abcdef';
const success: OperationResult = {
  status: 'success', mutationStatus: 'committed', rollbackStatus: 'not-run', rollbackFailures: [],
  refreshStatus: 'complete', postState: { gameId, gameRevision: 2 },
};

test('Unity remove/reinstall uses the same recoverable slot and preview correlation', async () => {
  const h = harness();
  for (const kind of ['remove-translator', 'reinstall-translator'] as const) {
    const started = h.manager.start({ gameId, kind, requestId: kind, planId: 'opaque-preview' }, async (report) => {
      report({ phase: 'backup', stepIndex: 3, stepCount: 5 });
      return success;
    });
    assert.equal(h.manager.current().active?.kind, kind);
    await h.queue.at(-1)!();
    assert.equal(h.manager.outcome(started.operationId)?.planId, 'opaque-preview');
    assert.equal(h.manager.acknowledge(started.operationId), true);
  }
});

test('font maintenance uses the same queue, correlation and recoverable outcome', async () => {
  const h = harness();
  h.manager.start({ gameId, kind: 'install-font', requestId: 'font-request', planId: 'opaque-font-plan' }, async (report) => {
    report({ phase: 'configure', stepIndex: 2, stepCount: 3 });
    return success;
  });
  assert.equal(h.manager.current().active?.kind, 'install-font');
  assert.throws(() => h.manager.start({ gameId, kind: 'install', requestId: 'overlap' }, async () => success), /already running/);
  await h.queue[0]!();
  assert.equal(h.outcomes[0]?.kind, 'install-font');
  assert.equal(h.outcomes[0]?.planId, 'opaque-font-plan');
  assert.equal(h.outcomes[0]?.refreshStatus, 'complete');
});

test('start reserves one slot and exposes queued progress before the file writer runs', async () => {
  const h = harness();
  let writes = 0;
  const first = h.manager.start({ gameId, kind: 'install', requestId: 'request1' }, async (report) => {
    writes += 1;
    report({ phase: 'download', stepIndex: 1, stepCount: 3, assetId: 'loader', received: 10, total: 20 });
    report({ log: 'downloaded loader' });
    report({ phase: 'extract', stepIndex: 2 });
    return success;
  });
  assert.equal(writes, 0);
  assert.equal(h.manager.current().active?.operationId, first.operationId);
  assert.equal(h.progress[0]?.phase, 'queued');
  assert.throws(() => h.manager.start({ gameId, kind: 'uninstall', requestId: 'request2' }, async () => success), /already running/);
  await h.queue[0]!();
  assert.equal(writes, 1);
  assert.equal(h.outcomes.length, 1);
  assert.deepEqual(h.progress.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(h.progress.at(-1)?.received, undefined, 'download bytes cannot become extraction percent');
  assert.equal(h.progress.at(-1)?.assetId, undefined);
  assert.equal(h.outcomes[0]?.sequence, 5);
  assert.equal(h.manager.current().active, null);
});

test('a renderer can recover and acknowledge results after missing every event', async () => {
  const h = harness();
  const started = h.manager.start({ gameId, kind: 'install', requestId: 'recover' }, async (report) => {
    report({ phase: 'verify', fromCache: true, log: 'cached archive verified' });
    const snapshot = h.manager.current().active;
    assert.equal(snapshot?.fromCache, true);
    assert.deepEqual(snapshot?.logs, ['cached archive verified']);
    snapshot!.logs.push('renderer cannot mutate main state');
    return success;
  });
  await h.queue[0]!();
  assert.deepEqual(h.manager.current().outcomes[0]?.logs, ['cached archive verified']);
  assert.equal(h.manager.outcome(started.operationId)?.refreshStatus, 'complete');
  assert.equal(h.manager.acknowledge('unknown'), false);
  assert.equal(h.manager.outcome(started.operationId)?.status, 'success');
  assert.equal(h.manager.acknowledge(started.operationId), true);
  assert.equal(h.manager.outcome(started.operationId), null);
  assert.deepEqual(h.manager.current().outcomes, []);
});

test('unexpected runner failure settles once, releases the slot and does not claim rollback', async () => {
  const h = harness();
  h.manager.start({ gameId, kind: 'install', requestId: 'failure' }, async () => { throw new Error('unexpected'); });
  await h.queue[0]!();
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.outcomes[0]?.status, 'failed');
  assert.equal(h.outcomes[0]?.error, 'unexpected');
  assert.equal(h.outcomes[0]?.rollbackStatus, 'not-run');
  assert.equal(h.outcomes[0]?.refreshStatus, 'failed');
  const next = h.manager.start({ gameId, kind: 'uninstall', requestId: 'next' }, async () => success);
  await h.queue[1]!();
  assert.equal(h.outcomes.length, 2);
  assert.equal(h.manager.outcome(next.operationId)?.status, 'success');
  assert.notEqual(h.outcomes[0]?.operationId, next.operationId);
});

test('operation ids are main-issued and malformed correlation ids cannot reserve a slot', () => {
  const h = harness();
  for (const requestId of [undefined, '', '../bad', 'x'.repeat(81)]) {
    assert.throws(() => h.manager.start({ gameId, kind: 'install', requestId: requestId as string }, async () => success), /request id/);
  }
  assert.equal(h.manager.isActive(), false);
  assert.equal(h.queue.length, 0);
});

test('unacknowledged results apply backpressure without losing recovery evidence', async () => {
  const h = harness();
  for (let index = 0; index < 10; index += 1) {
    h.manager.start({ gameId, kind: 'install', requestId: `retained-${index}` }, async () => success);
    await h.queue[index]!();
  }
  assert.throws(() => h.manager.start({ gameId, kind: 'install', requestId: 'overflow' }, async () => success), /acknowledge/);
  assert.equal(h.manager.current().outcomes.length, 10);
  h.manager.acknowledge(h.outcomes[0]!.operationId);
  h.manager.start({ gameId, kind: 'install', requestId: 'resumed' }, async () => success);
  assert.equal(h.manager.isActive(), true);
});

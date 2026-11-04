import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSecurityController, type SecuritySnapshot } from '../../desktop/src/security-controller.ts';
import type { SecurityScanResult, SecurityScannerStatus, SecurityUpdateResult } from '../../desktop/src/security-scanner.ts';

const HASH = 'a'.repeat(64);
const engine = (signatureVersion = '1.463.115.0'): SecurityScannerStatus => ({ provider: 'microsoft-defender', state: 'ready',
  engineVersion: '1.1.26090.1', signatureVersion, signatureAgeDays: 0, policy: 'existing-defender-policy' });
const clean = (sha256 = HASH): SecurityScanResult => ({ provider: 'microsoft-defender', verdict: 'clean', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  fingerprint: { scope: 'file', sha256, files: 1, bytes: 128 }, engineVersion: '1.1.26090.1', signatureVersion: '1.463.115.0' });
function fixture(options: { manual?: boolean; emit?: (snapshot: SecuritySnapshot) => void; busy?: boolean; enqueueError?: 'sync' | 'async' } = {}) {
  const queued: { work: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }[] = [];
  let scans = 0, updates = 0;
  const scanner = {
    status: async (): Promise<SecurityScannerStatus> => engine(),
    scanTarget: async (_target: string, _request?: { signal?: AbortSignal }): Promise<SecurityScanResult> => { scans += 1; return clean(); },
    updateSignatures: async (_request?: { signal?: AbortSignal }): Promise<SecurityUpdateResult> => { updates += 1; return { provider: 'microsoft-defender', state: 'updated', status: engine(), changed: false }; },
  };
  const controller = createSecurityController({ scanner, isBusy: () => options.busy === true, emit: options.emit,
    enqueue: (work) => {
      if (options.enqueueError === 'sync') throw Error('private scheduling path');
      if (options.enqueueError === 'async') return Promise.reject(Error('private queue details'));
      if (!options.manual) return Promise.resolve().then(work);
      return new Promise<void>((resolve, reject) => { queued.push({ work, resolve, reject }); });
    },
  });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const runQueued = async () => {
    const next = queued.shift(); assert.ok(next, 'a work item was queued');
    try { await next.work(); next.resolve(); } catch (error) { next.reject(error); }
    await flush();
  };
  return { controller, scanner, queued, runQueued, flush, counts: () => ({ scans, updates }) };
}

test('manual scans reserve a running task before queue execution and reject duplicate or externally busy work', async () => {
  const item = fixture({ manual: true });
  const started = item.controller.startGameScan('game', '/main-owned-fixture');
  assert.equal(started.task?.status, 'running'); assert.equal(started.task.gameId, 'game');
  assert.equal(item.counts().scans, 0); assert.equal(item.queued.length, 1);
  assert.throws(() => item.controller.startGameScan('other', '/other'), /ui.security.busy/);
  assert.throws(() => item.controller.startUpdate(), /ui.security.busy/);
  await item.runQueued(); assert.equal(item.controller.current().task?.status, 'complete'); assert.equal(item.counts().scans, 1);
  const busy = fixture({ busy: true });
  assert.throws(() => busy.controller.startGameScan('game', '/unused'), /ui.security.busy/);
  assert.throws(() => busy.controller.startUpdate(), /ui.security.busy/);
  assert.equal(busy.controller.current().task, null); assert.deepEqual(busy.counts(), { scans: 0, updates: 0 });
});

test('a before-use scan runs afresh on every call and is never reused as an execution permit', async () => {
  const item = fixture();
  await item.controller.scanBeforeUse('/main-owned-fixture', 'game', HASH);
  await item.controller.scanBeforeUse('/main-owned-fixture', 'game', HASH);
  assert.equal(item.counts().scans, 2); assert.equal(item.queued.length, 0);
  assert.equal(item.controller.current().task?.sequence, 2);
});

test('attention, unavailable results and provider exceptions block both file use and stage publication', async () => {
  for (const kind of ['attention', 'not-checked', 'throw'] as const) {
    const item = fixture();
    item.scanner.scanTarget = async () => {
      if (kind === 'throw') throw Error('private native diagnostics');
      return { ...clean(), verdict: kind, reason: kind === 'attention' ? 'engine-attention' : 'engine-unavailable', fingerprint: undefined };
    };
    const message = kind === 'attention' ? /ui.security.block.attention/ : /ui.security.block.notChecked/;
    await assert.rejects(item.controller.scanBeforeUse('/fixture', 'game'), message);
    assert.equal(item.controller.current().task?.status, 'failed');
    await assert.rejects(item.controller.scanStage('/stage'), message);
    assert.equal(item.controller.current().task?.status, 'failed');
    assert.doesNotMatch(JSON.stringify(item.controller.current()), /private native/);
  }
});

test('nominal clean results without a valid fingerprint or bounded engine/signature identity are rejected', async () => {
  for (const patch of [{ fingerprint: undefined }, { engineVersion: undefined }, { signatureVersion: 'private arbitrary text' },
    { fingerprint: { scope: 'file' as const, sha256: 'bad', files: 1, bytes: 128 } },
    { fingerprint: { scope: 'file' as const, sha256: HASH, files: 2, bytes: 128 } }]) {
    const item = fixture(); item.scanner.scanTarget = async () => ({ ...clean(), ...patch });
    await assert.rejects(item.controller.scanBeforeUse('/fixture'), /ui.security.block.notChecked/);
    assert.equal(item.controller.current().task?.result?.reason, 'engine-error');
    assert.equal(item.controller.current().task?.result?.fingerprint, undefined);
  }
});

test('an expected archive hash mismatch is a failed task with no usable fingerprint', async () => {
  const item = fixture();
  await assert.rejects(item.controller.scanBeforeUse('/archive', undefined, 'b'.repeat(64)), /ui.security.block.changed/);
  const task = item.controller.current().task;
  assert.equal(task?.status, 'failed'); assert.equal(task.result?.verdict, 'not-checked');
  assert.equal(task.result?.reason, 'target-changed'); assert.equal(task.result?.fingerprint, undefined);
});

test('a hash mismatch never publishes a clean result or overwrites a different task started from its failure event', async () => {
  let item: ReturnType<typeof fixture>;
  let nextId: string | undefined;
  const events: SecuritySnapshot[] = [];
  item = fixture({ manual: true, emit: (snapshot) => {
    events.push(snapshot);
    if (snapshot.task?.kind === 'scan-file' && snapshot.task.status === 'failed' && !nextId) nextId = item.controller.startGameScan('next', '/next').task!.id;
  } });
  await assert.rejects(item.controller.scanBeforeUse('/archive', 'old', 'b'.repeat(64)), /ui.security.block.changed/);
  assert.equal(events.some((snapshot) => snapshot.task?.kind === 'scan-file' && snapshot.task.status === 'complete'), false);
  assert.equal(item.controller.current().task?.id, nextId); assert.equal(item.controller.current().task?.status, 'running');
  assert.equal(item.controller.current().task?.gameId, 'next');
  await item.runQueued(); assert.equal(item.controller.current().task?.status, 'complete');
});

test('cancelling queued work prevents any native scan or signature update from starting', async () => {
  const item = fixture({ manual: true });
  const scan = item.controller.startGameScan('game', '/fixture'); item.controller.cancel(scan.task!.id);
  await item.runQueued();
  assert.equal(item.counts().scans, 0); assert.equal(item.controller.current().task?.status, 'cancelled');
  assert.equal(item.controller.current().task?.result?.reason, 'cancelled');
  const update = item.controller.startUpdate(); item.controller.cancel(update.task!.id);
  await item.runQueued();
  assert.equal(item.counts().updates, 0); assert.equal(item.controller.current().task?.status, 'cancelled');
  assert.equal(item.controller.current().task?.updateResult?.state, 'not-updated');
});

test('a late nominal scan success after cancellation is converted into not-checked and blocks use', async () => {
  const item = fixture();
  let finish!: (result: SecurityScanResult) => void;
  item.scanner.scanTarget = async () => await new Promise((resolve) => { finish = resolve; });
  const pending = item.controller.scanBeforeUse('/fixture', 'game');
  const id = item.controller.current().task!.id;
  item.controller.cancel('different-task'); assert.equal(item.controller.current().task?.status, 'running');
  item.controller.cancel(id); finish(clean());
  await assert.rejects(pending, /ui.security.block.notChecked/);
  assert.equal(item.controller.current().task?.status, 'cancelled'); assert.equal(item.controller.current().task?.result?.reason, 'cancelled');
  assert.equal(item.controller.current().task?.result?.fingerprint, undefined);
});

test('signature-update cancellation cannot publish a successful completion from a late provider result', async () => {
  const item = fixture({ manual: true });
  let finish!: (result: SecurityUpdateResult) => void;
  item.scanner.updateSignatures = async () => await new Promise((resolve) => { finish = resolve; });
  const task = item.controller.startUpdate();
  const running = item.runQueued(); await Promise.resolve();
  item.controller.cancel(task.task!.id);
  finish({ provider: 'microsoft-defender', state: 'updated', status: engine(), changed: true });
  await running;
  assert.equal(item.controller.current().task?.status, 'cancelled');
  assert.deepEqual(item.controller.current().task?.updateResult, { state: 'not-updated', reason: 'cancelled' });
});

test('queue reservation failures release the controller and never expose scheduling diagnostics', async () => {
  for (const kind of ['sync', 'async'] as const) {
    const item = fixture({ enqueueError: kind });
    if (kind === 'sync') assert.throws(() => item.controller.startGameScan('game', '/fixture'), /ui.security.actionFailed/);
    else { item.controller.startGameScan('game', '/fixture'); await item.flush(); }
    assert.equal(item.controller.current().task?.status, 'failed');
    assert.deepEqual(item.counts(), { scans: 0, updates: 0 });
    assert.doesNotMatch(JSON.stringify(item.controller.current()), /private|path|details/);
    await item.controller.scanBeforeUse('/internal-operation'); assert.equal(item.controller.current().task?.status, 'complete');
  }
});

test('an already-current successful signature update completes with verified metadata; contradictory success fails', async () => {
  const item = fixture({ manual: true });
  item.controller.startUpdate(); await item.runQueued();
  assert.equal(item.controller.current().task?.status, 'complete');
  assert.equal(item.controller.current().task?.updateResult?.changed, false);
  assert.equal(item.controller.current().engine?.signatureVersion, '1.463.115.0');
  for (const invalid of [{ ...engine(), state: 'unavailable' as const }, { ...engine(), signatureVersion: undefined }]) {
    item.scanner.updateSignatures = async () => ({ provider: 'microsoft-defender', state: 'updated', status: invalid, changed: false });
    item.controller.startUpdate(); await item.runQueued();
    assert.equal(item.controller.current().task?.status, 'failed');
    assert.equal(item.controller.current().task?.updateResult?.reason, 'status-error');
  }
});

test('throwing observers cannot block scan execution, alter returned snapshots or keep the controller busy', async () => {
  const item = fixture({ emit: (snapshot) => { if (snapshot.task) snapshot.task.status = 'cancelled'; throw Error('observer failure'); } });
  const result = await item.controller.scanBeforeUse('/fixture'); assert.equal(result.verdict, 'clean');
  const snapshot = item.controller.current(); assert.equal(snapshot.task?.status, 'complete');
  snapshot.task!.status = 'cancelled'; assert.equal(item.controller.current().task?.status, 'complete');
  await item.controller.scanBeforeUse('/second'); assert.equal(item.controller.current().task?.sequence, 2);
});

test('an older pending status refresh cannot overwrite the engine identity from a completed scan', async () => {
  const item = fixture(); let resolveStatus!: (value: SecurityScannerStatus) => void;
  item.scanner.status = async () => await new Promise((resolve) => { resolveStatus = resolve; });
  const old = item.controller.refresh();
  await item.controller.scanBeforeUse('/fixture');
  resolveStatus(engine('1.400.0.0')); await old;
  assert.equal(item.controller.current().engine?.signatureVersion, '1.463.115.0');
});

test('failed or malformed status refreshes expose unavailable metadata instead of stale readiness or provider diagnostics', async () => {
  const item = fixture();
  await item.controller.refresh(); assert.equal(item.controller.current().engine?.state, 'ready');
  item.scanner.status = async () => { throw Error('private provider path and diagnostics'); };
  const failed = await item.controller.refresh();
  assert.equal(failed.engine?.state, 'unavailable'); assert.equal(failed.engine.reason, 'status-error');
  assert.doesNotMatch(JSON.stringify(failed), /private|provider path|diagnostics/);
  item.scanner.status = async () => ({ ...engine(), signatureVersion: undefined });
  assert.equal((await item.controller.refresh()).engine?.state, 'unavailable');
});

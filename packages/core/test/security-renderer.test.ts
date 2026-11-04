import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptSecurityRead, applySecuritySnapshot, beginSecurityRead, canCancelSecurityTask,
  createSecurityViewState, failSecurityRead, normalizeSecurityResult, normalizeSecuritySnapshot,
  reduceSecuritySnapshot, securityPresentation,
} from '../../desktop/renderer/security-model.js';

const engine = { provider: 'microsoft-defender', state: 'ready', signatureVersion: '1.2.3.4', signatureAgeDays: 0 };
const task = (sequence: number, status = 'running', extra = {}) => ({ id: `task-${sequence}`, sequence, kind: 'scan-game', status, ...extra });

test('security display projection removes native output, paths and unrelated fields', () => {
  const projected = normalizeSecuritySnapshot({ engine: { ...engine, executable: 'C:/private/scanner.exe', reason: 'C:/private/error' },
    task: task(1, 'complete', { gameId: '0123456789abcdef', result: { verdict: 'attention', reason: 'native-attention', stdout: 'private-output',
      path: 'C:/private/game', signatureVersion: '1.2.3.4' }, error: 'C:/private/error', argv: ['private'] }), secret: 'private' });
  assert.equal(projected.engine.reason, undefined);
  assert.deepEqual(projected.task.result, { verdict: 'attention', reason: 'native-attention', signatureVersion: '1.2.3.4' });
  assert.doesNotMatch(JSON.stringify(projected), /private|stdout|executable|argv/);
});

test('old security task events and terminal regressions cannot restore a running scan', () => {
  const completed = normalizeSecuritySnapshot({ engine, task: task(3, 'complete', { result: { verdict: 'clean' } }) });
  for (const incoming of [{ engine, task: task(2) }, { engine, task: task(3) }, { engine, task: null },
    { engine, task: task(3, 'failed') }, { engine, task: task(3, 'complete', { id: 'other-task' }) }]) {
    assert.equal(reduceSecuritySnapshot(completed, incoming), completed);
  }
  assert.equal(reduceSecuritySnapshot(completed, { engine, task: task(4) }).task.status, 'running');
});

test('live security events invalidate older status-read replies and failures', () => {
  const view = createSecurityViewState(), token = beginSecurityRead(view);
  assert.equal(applySecuritySnapshot(view, { engine, task: task(2) }), true);
  assert.equal(acceptSecurityRead(view, token, { engine: null, task: null }), false);
  assert.equal(failSecurityRead(view, token), false);
  assert.equal(view.snapshot.task.sequence, 2); assert.equal(view.readError, false);
});

test('cancel targets only the exact current task and stays available during a scan mutation', () => {
  const snapshot = normalizeSecuritySnapshot({ engine, task: task(1) });
  assert.equal(canCancelSecurityTask(snapshot, 'task-1'), true);
  assert.equal(canCancelSecurityTask(snapshot, 'task-0'), false);
  assert.equal(canCancelSecurityTask(snapshot, 'task-1', 'cancel'), false);
  const display = securityPresentation(snapshot, { mutationBlocked: true });
  assert.equal(display.canCancel, true); assert.equal(display.canScan, false); assert.equal(display.indeterminate, true);
});

test('stale, unavailable and unread engine states never enable a new scan', () => {
  assert.equal(securityPresentation({ engine, task: null }).canScan, true);
  assert.equal(securityPresentation({ engine: { ...engine, state: 'stale' }, task: null }).canScan, false);
  assert.equal(securityPresentation({ engine: { ...engine, state: 'stale' }, task: null }).canUpdate, true);
  for (const value of [{ engine: null, task: null }, { engine: { ...engine, state: 'unavailable' }, task: null }]) {
    assert.equal(securityPresentation(value).canScan, false);
  }
  assert.equal(securityPresentation({ engine, task: null }, { readError: true }).canScan, false);
  assert.equal(securityPresentation({ engine, task: null }, { action: 'scan-game' }).busy, true);
});

test('security result vocabulary preserves ambiguous and incomplete outcomes', () => {
  assert.deepEqual(normalizeSecurityResult({ verdict: 'attention', reason: 'native-attention' }), { verdict: 'attention', reason: 'native-attention' });
  assert.deepEqual(normalizeSecurityResult({ verdict: 'not-checked', reason: 'timeout' }), { verdict: 'not-checked', reason: 'timeout' });
  assert.equal(normalizeSecurityResult({ verdict: 'safe', reason: 'native-attention' }), null);
  assert.equal(normalizeSecuritySnapshot({ engine: { provider: 'other', state: 'ready' }, task: null }), null);
  assert.equal(normalizeSecuritySnapshot({ engine, task: task(-1) }), null);
  assert.equal(normalizeSecuritySnapshot({ engine, task: task(1, 'safe') }), null);
});

test('signature-update completion remains separate from a clean file scan', () => {
  const snapshot = normalizeSecuritySnapshot({ engine, task: task(2, 'complete', {
    kind: 'signature-update', updateResult: { state: 'updated', changed: false, status: { executable: 'C:/private/engine.exe' } },
  }) });
  assert.deepEqual(snapshot.task.updateResult, { state: 'updated', changed: false });
  assert.equal(snapshot.task.result, undefined);
  assert.equal(canCancelSecurityTask(snapshot, 'task-2'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|executable/);
});

test('selected-file and game-folder results keep their scope without exposing fingerprint paths', () => {
  for (const scope of ['file', 'directory']) {
    const projected = normalizeSecurityResult({ verdict: 'clean', completedAt: '2026-11-04T00:00:00.000Z',
      fingerprint: { scope, files: scope === 'file' ? 1 : 12, bytes: 2048, path: 'C:/private/game', sha256: 'private-untrusted-data' } });
    assert.equal(projected.fingerprint.scope, scope);
    assert.doesNotMatch(JSON.stringify(projected), /private|sha256|path/);
  }
});

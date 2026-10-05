import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { canCancelScan, isScanActive, reduceScanStatus, scanPresentation, validScanDepth } from '../../desktop/renderer/scan-model.js';

function snapshot(overrides = {}) {
  return { id: 'scan-a', sequence: 1, status: 'running', depth: 6,
    visited: 30, candidates: 8, found: 5, skipped: 4, unreadable: 0, depthLimited: 0,
    current: 'fixture/folder', canCancel: true, ...overrides };
}

test('scan snapshots require main-global monotonic sequences and known statuses', () => {
  const current = snapshot({ sequence: 8 });
  for (const incoming of [snapshot({ sequence: 7 }), snapshot({ sequence: 8 }), snapshot({ id: 'old-task', sequence: 2 }),
    snapshot({ sequence: Number.NaN }), snapshot({ sequence: -1 }), snapshot({ status: 'unknown', sequence: 9 }), snapshot({ id: '', sequence: 9 })]) {
    assert.equal(reduceScanStatus(current, incoming), current);
  }
  const next = reduceScanStatus(current, snapshot({ id: 'scan-b', sequence: 9 }));
  assert.equal(next.id, 'scan-b');
  assert.equal(next.visited, 30);
});

test('terminal scan snapshots cannot reopen the same task but a newer task may start', () => {
  for (const status of ['complete', 'cancelled', 'failed']) {
    const terminal = snapshot({ status, sequence: 10 });
    assert.equal(isScanActive(terminal), false);
    assert.equal(reduceScanStatus(terminal, snapshot({ sequence: 11 })), terminal);
    assert.equal(reduceScanStatus(terminal, snapshot({ id: 'scan-b', sequence: 11 })).id, 'scan-b');
  }
  assert.equal(isScanActive(snapshot({ status: 'cancelling' })), true);
});

test('scan cancellation is tied to the displayed opaque task and closes once main starts committing', () => {
  const task = snapshot();
  assert.equal(canCancelScan(task, 'scan-a'), true);
  assert.equal(canCancelScan(task, 'stale-task'), false);
  assert.equal(canCancelScan(task, 'scan-a', true), false);
  assert.equal(canCancelScan({ ...task, canCancel: false }, 'scan-a'), false);
  for (const status of ['cancelling', 'complete', 'cancelled', 'failed']) {
    assert.equal(canCancelScan({ ...task, status }, 'scan-a'), false);
  }
  assert.equal(canCancelScan(null, undefined), false);
});

test('scan presentation uses honest counters and indeterminate progress, not a made-up percentage', () => {
  const display = scanPresentation(snapshot({ visited: 230, candidates: 45, found: 20, unreadable: 3, depthLimited: 12 }));
  assert.equal(display.indeterminate, true);
  assert.equal(display.visited, 230);
  assert.equal(display.candidates, 45);
  assert.equal(display.found, 20);
  assert.equal(display.unreadable, 3);
  assert.equal(display.depthLimited, 12);
  assert.equal('percent' in display, false);
  const invalidCounters = scanPresentation(snapshot({ visited: -1, candidates: Number.NaN, found: '12' }));
  assert.equal(invalidCounters.visited, 0);
  assert.equal(invalidCounters.candidates, 0);
  assert.equal(invalidCounters.found, 0);
  assert.equal(scanPresentation(null, true).active, true);
  assert.equal(scanPresentation(null, true).canCancel, false);
});

test('cancelled and failed scans explicitly retain the prior library while complete snapshots carry the new payload', () => {
  for (const status of ['cancelled', 'failed']) {
    const display = scanPresentation(snapshot({ status }));
    assert.equal(display.previousLibraryPreserved, true);
    assert.equal(display.indeterminate, false);
  }
  const incoming = snapshot({ status: 'complete', result: { revision: 12, index: { games: [] } } });
  const reduced = reduceScanStatus(null, incoming);
  assert.equal(scanPresentation(reduced).previousLibraryPreserved, false);
  assert.deepEqual(reduced.result, incoming.result);
  incoming.visited = 99;
  assert.equal(reduced.visited, 30);
});

test('a failed display refresh after a successful save does not claim the previous library was preserved', () => {
  const display = scanPresentation(snapshot({ status: 'failed', saved: true }));
  assert.equal(display.previousLibraryPreserved, false);
  assert.equal(display.savedRefreshFailed, true);
  assert.equal(display.indeterminate, false);
  assert.equal(scanPresentation(snapshot({ status: 'failed', saved: false })).previousLibraryPreserved, true);
  assert.equal(scanPresentation(snapshot({ status: 'complete', saved: true })).savedRefreshFailed, false);
});

test('all saved scan depths 0 through 12 round-trip without replacing an existing two-level choice', () => {
  for (let depth = 0; depth <= 12; depth += 1) assert.equal(validScanDepth(depth), true);
  for (const depth of [-1, 13, 2.5, Number.NaN, '6', undefined]) assert.equal(validScanDepth(depth), false);
  const settings = fs.readFileSync(new URL('../../desktop/renderer/panels/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /depth <= 12/);
  assert.match(settings, /validScanDepth\(depth\) \? depth : 6/);
  assert.match(settings, /depth !== 2/);
});

test('scan subscription and cancellation binding precede queued boot reads and no longer use legacy scanProgress', () => {
  const app = fs.readFileSync(new URL('../../desktop/renderer/app.js', import.meta.url), 'utf8');
  const boot = app.slice(app.indexOf('async function boot()'));
  assert.ok(boot.indexOf('bindScanEvents();') < boot.indexOf('await refreshMToolStatus();'));
  assert.ok(boot.indexOf('recoverScanStatus()') < boot.indexOf('await refreshLibraryView(false);'));
  const bind = app.slice(app.indexOf('function bindScanEvents()'), app.indexOf('function setTransientTask'));
  assert.match(bind, /api\.on\.scanStatus\(acceptScanStatus\)/);
  assert.match(bind, /\$\('cancelScan'\)\.addEventListener/);
  assert.doesNotMatch(app, /api\.on\.scanProgress\(/);
  const cancel = app.slice(app.indexOf('async function cancelScan()'), app.indexOf('function bindScanEvents()'));
  assert.match(cancel, /canCancelScan\(state\.scanStatus, capturedId/);
  assert.match(cancel, /api\.library\.cancelScan\(capturedId\)/);
  assert.doesNotMatch(cancel, /if \(mutationBlocked\(\)\)/);
  const store = fs.readFileSync(new URL('../../desktop/renderer/store.js', import.meta.url), 'utf8');
  assert.match(store, /state\.scanRequestPending \|\| isScanActive\(state\.scanStatus\)/);
});

test('global scan controls are outside both scrollable views and every new UI key has Korean and English text', () => {
  const html = fs.readFileSync(new URL('../../desktop/renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="scanTask"') > html.lastIndexOf('</main>'));
  assert.ok(html.indexOf('id="scanTask"') < html.indexOf('<footer'));
  assert.match(html, /id="scanTaskProgress"[^>]*><\/progress>/);
  const en = JSON.parse(fs.readFileSync(new URL('../../../locales/en.json', import.meta.url), 'utf8'));
  const ko = JSON.parse(fs.readFileSync(new URL('../../../locales/ko.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(ko.ui.scan), Object.keys(en.ui.scan));
  for (const [key, value] of Object.entries(en.ui.scan)) {
    if (typeof value === 'string') assert.equal(typeof ko.ui.scan[key], 'string', key);
  }
});

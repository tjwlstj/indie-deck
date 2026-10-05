import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { withinLibraryRoots } from '../../desktop/src/library-roots.ts';
import { LibraryScanController, type LibraryScanTask } from '../../desktop/src/library-scan.ts';

test('library boundary accepts drive roots, trailing separators and UNC shares without widening authority', () => {
  const paths = path.win32;
  for (const [target, root] of [
    ['D:\\Games\\Game', 'D:\\'],
    ['D:\\Games\\Game', 'D:\\Games\\'],
    ['D:\\GAMES\\GAME', 'd:\\games'],
    ['D:\\Games', 'D:\\Games'],
    ['\\\\server\\share\\Games\\Game', '\\\\server\\share\\'],
    ['\\\\server\\share\\Games', '\\\\server\\share'],
  ]) assert.equal(withinLibraryRoots(target!, [root!], paths), true, `${root} contains ${target}`);
  for (const [target, root] of [
    ['D:\\Games-old\\Game', 'D:\\Games'],
    ['D:\\Games\\..\\Other\\Game', 'D:\\Games'],
    ['E:\\Games\\Game', 'D:\\'],
    ['\\\\server\\share-other\\Games', '\\\\server\\share'],
    ['\\\\other\\share\\Games', '\\\\server\\share'],
  ]) assert.equal(withinLibraryRoots(target!, [root!], paths), false, `${root} excludes ${target}`);
});

test('scan snapshots are main-owned and sequence increases across progress and new tasks', () => {
  const events: LibraryScanTask[] = [];
  const controller = new LibraryScanController((task) => events.push(task));
  const signal = controller.start(6);
  const first = controller.snapshot()!;
  assert.equal(signal.aborted, false);
  first.current = 'renderer-controlled';
  assert.equal(controller.snapshot()!.current, '');
  controller.progress({ depth: 6, current: 'fixture', visited: 10, candidates: 2, found: 1,
    skipped: 3, unreadable: 0, depthLimited: 4 });
  const progressed = controller.snapshot()!;
  assert.ok(progressed.sequence > first.sequence);
  assert.equal(progressed.visited, 10);
  controller.finish('complete', { result: { index: { games: [] } } });
  const terminal = controller.snapshot()!;
  assert.equal(terminal.canCancel, false);
  assert.ok(terminal.sequence > progressed.sequence);
  controller.start(4);
  assert.notEqual(controller.snapshot()!.id, first.id);
  assert.ok(controller.snapshot()!.sequence > terminal.sequence);
  assert.ok(events.length >= 3);
});

test('scan cancellation accepts only the active id and cannot overwrite a cancelling task with late progress', () => {
  const controller = new LibraryScanController(() => {});
  const signal = controller.start(6);
  const current = controller.snapshot()!;
  assert.throws(() => controller.start(2), /busy/);
  assert.equal(controller.cancel('stale'), false);
  assert.equal(controller.cancel({ id: current.id }), false);
  assert.equal(signal.aborted, false);
  assert.equal(controller.cancel(current.id), true);
  assert.equal(signal.aborted, true);
  assert.equal(controller.cancel(current.id), false);
  controller.progress({ depth: 6, visited: 999, candidates: 0, found: 0, skipped: 0,
    unreadable: 0, depthLimited: 0, current: 'late' });
  assert.equal(controller.snapshot()!.status, 'cancelling');
  assert.equal(controller.snapshot()!.visited, 0);
  assert.throws(() => controller.commit(), /cancelled/);
  controller.finish('cancelled', { error: 'previous library kept' });
  assert.equal(controller.snapshot()!.status, 'cancelled');
});

test('commit atomically closes late cancellation before saving the complete index', () => {
  const controller = new LibraryScanController(() => {});
  const signal = controller.start(6);
  const id = controller.snapshot()!.id;
  controller.commit();
  assert.equal(controller.snapshot()!.status, 'running');
  assert.equal(controller.snapshot()!.canCancel, false);
  assert.equal(controller.cancel(id), false);
  assert.equal(signal.aborted, false);
  controller.finish('complete', { result: { revision: 2 } });
  assert.equal(controller.snapshot()!.status, 'complete');
});

test('scan cancel and snapshot IPC bypass the writer queue and scan options keep main authority', () => {
  const main = fs.readFileSync(new URL('../../desktop/src/main.ts', import.meta.url), 'utf8');
  const preload = fs.readFileSync(new URL('../../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /return withinLibraryRoots\(gamePath, libraryRoots\)/);
  assert.match(main, /handle\('library:scanCurrent', \(\) => libraryScan.snapshot\(\)\)/);
  assert.match(main, /handle\('library:cancelScan', \(id: unknown\) => libraryScan.cancel\(id\)\)/);
  assert.doesNotMatch(main, /handleMutation\('library:(?:scanCurrent|cancelScan)'/);
  assert.match(main, /channel === 'library:scan' && pendingMutations > 0/);
  assert.match(main, /onBeforeSave: \(\) => libraryScan.commit\(\)/);
  assert.match(preload, /scanCurrent: \(\) => call\('library:scanCurrent'\)/);
  assert.match(preload, /cancelScan: \(id\) => call\('library:cancelScan', id\)/);
  const scan = main.slice(main.indexOf("handleMutation('library:scan'"), main.indexOf("handle('game:detail'"));
  assert.doesNotMatch(scan, /options\??\.(roots|signal|maxDirectories|onBeforeSave)/);
});

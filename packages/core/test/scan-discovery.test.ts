import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  detectGame, scanLibrary, scanLibraryAsync, normalizeScanDepth,
  ScanCancelledError, ScanLimitError, type ScanProgress,
} from '../src/detect/index.ts';
import { configPath, libraryPath, loadConfig, loadLibrary, refreshLibrary, saveConfig, saveLibrary } from '../src/library/index.ts';
import { loadRegistry } from '../src/registry/index.ts';
import { FsProbe, ProbeDirectoryLimitError } from '../src/util/fsx.ts';

const registry = loadRegistry();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-discovery-'));
after(() => {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
});

function exe(): Buffer {
  const value = Buffer.alloc(512);
  value.writeUInt16LE(0x5a4d); value.writeUInt32LE(0x80, 0x3c);
  value.writeUInt32LE(0x4550, 0x80); value.writeUInt16LE(0x8664, 0x84);
  return value;
}
function write(relative: string, content: string | Buffer): string {
  const target = path.join(temporary, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
  return target;
}
function rpg(relative: string): string {
  write(`${relative}/Game.exe`, exe()); write(`${relative}/nw.dll`, 'static fixture');
  write(`${relative}/package.json`, '{"name":"fixture"}'); write(`${relative}/js/rpg_core.js`, '// fixture');
  write(`${relative}/data/System.json`, '{"gameTitle":"Discovery fixture"}');
  return path.join(temporary, relative);
}
function makeEmptyTree(relative: string, count = 80): string {
  const root = path.join(temporary, relative); fs.mkdirSync(root, { recursive: true });
  for (let index = 0; index < count; index += 1) fs.mkdirSync(path.join(root, `Folder-${index}`));
  return root;
}
async function configure(dataDir: string, roots: string[], scanDepth = 6): Promise<void> {
  await saveConfig({ roots, locale: 'en', defaults: { targetLanguage: 'ko', sourceLanguage: 'ja', endpoint: 'GoogleTranslate' }, scanDepth }, dataDir);
}

test('scan depth has a bounded six-level default and valid old settings remain unchanged', async () => {
  for (const value of [undefined, null, '2', -1, NaN, Infinity, {}, []]) assert.equal(normalizeScanDepth(value), 6);
  assert.equal(normalizeScanDepth(0), 0); assert.equal(normalizeScanDepth(2), 2);
  assert.equal(normalizeScanDepth(2.9), 2); assert.equal(normalizeScanDepth(99), 12);
  const dataDir = path.join(temporary, 'depth-config');
  assert.equal((await loadConfig(dataDir)).scanDepth, 6);
  await configure(dataDir, [], 2); assert.equal((await loadConfig(dataDir)).scanDepth, 2);
  await configure(dataDir, [], 0); assert.equal((await loadConfig(dataDir)).scanDepth, 0);
  fs.writeFileSync(configPath(dataDir), '{"roots":[],"scanDepth":"2000"}');
  assert.equal((await loadConfig(dataDir)).scanDepth, 6);
  fs.writeFileSync(configPath(dataDir), '{"roots":[],"scanDepth":999999}');
  assert.equal((await loadConfig(dataDir)).scanDepth, 12);
});

test('nested Windows, Program Files and Users game containers are not name-based exclusions', () => {
  const root = path.join(temporary, 'named-containers');
  const games = [rpg('named-containers/Category/Game/Windows'), rpg('named-containers/Program Files/Steam/Game'),
    rpg('named-containers/Users/Player/Games/Game'), rpg('named-containers/Recovery/Temp/Game')];
  rpg('named-containers/node_modules/Excluded'); rpg('named-containers/.git/Excluded');
  rpg('named-containers/.staging-fixture/Excluded'); rpg('named-containers/.indiedeck/Excluded');
  let last: ScanProgress | undefined;
  assert.deepEqual(scanLibrary(registry, [root], { onStatus: (value) => { last = value; } }).map((game) => game.path).sort(), games.sort());
  assert.equal(last?.found, 4); assert.equal(last?.candidates, 4); assert.ok((last?.skipped ?? 0) >= 4);
  assert.equal(last?.depth, 6); assert.equal(last?.depthLimited, 0);
});

test('only actual OS locations are excluded, not a same-named Windows release', () => {
  const original = process.env['WINDIR'];
  const system = path.join(temporary, 'os-locations/System/Windows');
  rpg('os-locations/System/Windows/NotAGameToScan');
  const real = rpg('os-locations/Release/Windows');
  process.env['WINDIR'] = system;
  try {
    assert.deepEqual(scanLibrary(registry, [path.join(temporary, 'os-locations')]).map((game) => game.path), [real]);
    assert.deepEqual(scanLibrary(registry, [system]), []);
  } finally {
    if (original === undefined) delete process.env['WINDIR']; else process.env['WINDIR'] = original;
  }
});

test('engine evidence without a root executable does not hide a nested playable game', () => {
  const root = path.join(temporary, 'marker-only');
  write('marker-only/Wrapper/UnityPlayer.dll', 'static marker');
  const game = rpg('marker-only/Wrapper/Release/Game');
  const parent = detectGame(registry, path.dirname(path.dirname(game)));
  assert.equal(parent?.engineId, 'unity'); assert.equal(parent?.executable, undefined, 'direct classification remains available');
  let candidates = 0;
  assert.deepEqual(scanLibrary(registry, [root], { onStatus: (value) => { candidates = value.candidates; } }).map((game) => game.path), [game]);
  assert.equal(candidates, 1, 'only the actual root executable triggers full engine classification');
});

test('a recursive Unreal marker cannot turn an executable-free wrapper into the game', () => {
  write('unreal-wrapper/Wrapper/Engine/Binaries/Win64/fixture.txt', 'static engine marker');
  write('unreal-wrapper/Wrapper/Release/Game-Win64-Shipping.exe', exe());
  write('unreal-wrapper/Wrapper/Release/Project/Content/Paks/game.pak', 'static pack marker');
  const wrapper = path.join(temporary, 'unreal-wrapper/Wrapper');
  assert.equal(detectGame(registry, wrapper)?.engineId, 'unreal');
  assert.equal(detectGame(registry, wrapper)?.executable, undefined);
  const result = scanLibrary(registry, [path.dirname(wrapper)]);
  assert.deepEqual(result.map((game) => game.path), [path.join(wrapper, 'Release')]);
  assert.equal(result[0]?.executable, 'Game-Win64-Shipping.exe');
});

test('default traversal discovers deeply wrapped builds but explicit depth still limits it', () => {
  const game = rpg('default-depth/Category/Title/Version/Windows/Game');
  const root = path.join(temporary, 'default-depth');
  let status: ScanProgress | undefined;
  assert.deepEqual(scanLibrary(registry, [root], { depth: 2, onStatus: (value) => { status = value; } }), []);
  assert.ok((status?.depthLimited ?? 0) > 0);
  assert.deepEqual(scanLibrary(registry, [root]).map((game) => game.path), [game]);
});

test('helper-only and non-launchable payload folders remain classification-only', () => {
  write('non-launchable/Flash/only.swf', 'static fixture');
  write('non-launchable/Unity/UnityPlayer.dll', 'static fixture');
  write('non-launchable/Unity/UnityCrashHandler64.exe', exe());
  assert.equal(detectGame(registry, path.join(temporary, 'non-launchable/Flash'))?.engineId, 'flash');
  assert.equal(detectGame(registry, path.join(temporary, 'non-launchable/Unity'))?.engineId, 'unity');
  let final: ScanProgress | undefined;
  assert.deepEqual(scanLibrary(registry, [path.join(temporary, 'non-launchable')], { onStatus: (value) => { final = value; } }), []);
  assert.equal(final?.candidates, 0);
});

test('async and sync discovery share direct roots, overlaps and terminal-game rules', async () => {
  const first = rpg('async-compare/Game'), second = rpg('async-compare/Wrapper/Nested');
  rpg('async-compare/Game/Embedded');
  const roots = [path.join(temporary, 'async-compare'), first, path.dirname(second)];
  const simplify = (game: ReturnType<typeof detectGame>) => ({ path: game?.path, engineId: game?.engineId, executable: game?.executable });
  assert.deepEqual((await scanLibraryAsync(registry, roots)).map(simplify), scanLibrary(registry, roots).map(simplify));
  assert.deepEqual((await scanLibraryAsync(registry, roots)).map((game) => game.path), [first, second]);
  assert.deepEqual((await scanLibraryAsync(registry, [first], { depth: 0 })).map((game) => game.path), [first]);
});

test('async traversal yields before completion and cancellation stops further work', async () => {
  const root = makeEmptyTree('yield-tree');
  let visited = 0, heartbeatVisited = -1;
  const heartbeat = new Promise<void>((resolve) => setImmediate(() => { heartbeatVisited = visited; resolve(); }));
  await scanLibraryAsync(registry, [root], { onStatus: (value) => { visited = value.visited; } });
  await heartbeat;
  assert.ok(heartbeatVisited > 0 && heartbeatVisited < visited, 'event-loop work executes during, not only after, the scan');
  const cancelled = new AbortController();
  setImmediate(() => cancelled.abort());
  await assert.rejects(scanLibraryAsync(registry, [root], { signal: cancelled.signal }), ScanCancelledError);
  assert.throws(() => scanLibrary(registry, [root], { signal: cancelled.signal }), ScanCancelledError);
});

test('directory-budget failure never saves a partial library index', async () => {
  const first = rpg('budget-tree/First'); rpg('budget-tree/Second');
  const dataDir = path.join(temporary, 'budget-data');
  await configure(dataDir, [path.dirname(first)]);
  await saveLibrary({ games: [detectGame(registry, first)!], roots: [path.dirname(first)], scannedAt: 'original' }, dataDir);
  const before = fs.readFileSync(libraryPath(dataDir), 'utf8'); let commits = 0;
  await assert.rejects(refreshLibrary(registry, { dataDir, maxDirectories: 2, onBeforeSave: () => { commits += 1; } }), ScanLimitError);
  assert.equal(fs.readFileSync(libraryPath(dataDir), 'utf8'), before); assert.equal(commits, 0);
  assert.throws(() => scanLibrary(registry, [path.dirname(first)], { maxDirectories: 1 }), ScanLimitError);
});

test('cancelled discovery and cancellation immediately before save keep the previous index', async () => {
  const root = makeEmptyTree('cancel-tree');
  const dataDir = path.join(temporary, 'cancel-data');
  await configure(dataDir, [root]); await saveLibrary({ games: [], roots: [root], scannedAt: 'original' }, dataDir);
  const before = fs.readFileSync(libraryPath(dataDir), 'utf8');
  const during = new AbortController(); let commits = 0;
  setImmediate(() => during.abort());
  await assert.rejects(refreshLibrary(registry, { dataDir, signal: during.signal, onBeforeSave: () => { commits += 1; } }), ScanCancelledError);
  assert.equal(fs.readFileSync(libraryPath(dataDir), 'utf8'), before); assert.equal(commits, 0);
  const preSave = new AbortController();
  await assert.rejects(refreshLibrary(registry, { dataDir, signal: preSave.signal, onBeforeSave: () => { commits += 1; preSave.abort(); } }), ScanCancelledError);
  assert.equal(fs.readFileSync(libraryPath(dataDir), 'utf8'), before); assert.equal(commits, 1);
});

test('unreadable folders retain affected previous rows while genuinely missing games disappear', async () => {
  const blocked = rpg('access-tree/Blocked'), good = rpg('access-tree/Good');
  const root = path.dirname(blocked), dataDir = path.join(temporary, 'access-data');
  const old = { ...detectGame(registry, blocked)!, scannedAt: 'old-profile' };
  const missing = { ...old, path: path.join(root, 'ActuallyDeleted'), name: 'ActuallyDeleted' };
  await configure(dataDir, [root]); await saveLibrary({ games: [old, missing], roots: [root], scannedAt: 'original' }, dataDir);
  const original = fs.readdirSync;
  fs.readdirSync = ((directory: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(directory)) === blocked) throw Object.assign(new Error('Fixture access denied'), { code: 'EACCES' });
    return Reflect.apply(original, fs, [directory, options]);
  }) as typeof fs.readdirSync;
  let final: ScanProgress | undefined;
  try {
    const updated = await refreshLibrary(registry, { dataDir, onStatus: (value) => { final = value; } });
    assert.deepEqual(updated.games.map((game) => game.path), [blocked, good]);
    assert.equal(updated.games.find((game) => game.path === blocked)?.scannedAt, 'old-profile');
    assert.equal(updated.revision, 2); assert.equal(final?.unreadable, 1);
    assert.deepEqual((await loadLibrary(dataDir)).games, updated.games);
  } finally { fs.readdirSync = original; }
});

test('an unavailable registered drive/share retains previous rows without inventing fresh detection', async () => {
  const seed = rpg('disconnected-seed/Game'), root = path.join(temporary, 'DisconnectedLibrary');
  const old = { ...detectGame(registry, seed)!, path: path.join(root, 'Game'), scannedAt: 'previous-profile' };
  const dataDir = path.join(temporary, 'disconnected-data');
  await configure(dataDir, [root]); await saveLibrary({ games: [old], roots: [root], scannedAt: 'previous-scan' }, dataDir);
  let final: ScanProgress | undefined;
  assert.deepEqual(scanLibrary(registry, [root]), [], 'direct scanner still has no fabricated results for missing roots');
  const updated = await refreshLibrary(registry, { dataDir, onStatus: (value) => { final = value; } });
  assert.deepEqual(updated.games, [old]); assert.equal(final?.found, 0); assert.equal(final?.unreadable, 1);
});

test('engine scopes cap new listings without exhausting the next engine or poisoning cached evidence', () => {
  const root = makeEmptyTree('probe-scope', 4), probe = new FsProbe(root);
  probe.namesIn('');
  assert.throws(() => probe.withDirectoryLimit(1, () => {
    probe.namesIn('Folder-0'); probe.namesIn('Folder-1');
  }), ProbeDirectoryLimitError);
  assert.doesNotThrow(() => probe.withDirectoryLimit(1, () => {
    probe.namesIn('Folder-0'); probe.namesIn('Folder-1');
  }), 'the cached listing consumes no new budget and the failed listing can be read by the next scope');
});

test('wide multi-segment and recursive engine rules cannot bypass bulk traversal bounds', async () => {
  const relative = 'probe-wide/Wrapper', root = path.join(temporary, relative);
  write(`${relative}/Start.exe`, exe());
  for (let index = 0; index < 160; index += 1) fs.mkdirSync(path.join(root, `D${String(index).padStart(3, '0')}`, 'Content'), { recursive: true });
  write(`${relative}/ZZZ/Content/Paks/static.pak`, 'marker');
  const real = rpg(`${relative}/ZZZ/ActualGame`);
  const synthetic = {
    ...registry.engines[0]!, id: 'wide-glob-fixture', name: 'Wide glob fixture', minScore: 60, probes: [],
    rules: [{ kind: 'dirGlob' as const, value: '*/Content/Paks', score: 60 }],
  };
  const custom = { ...registry, engines: [synthetic, ...registry.engines] };
  assert.equal(detectGame(custom, root)?.engineId, synthetic.id, 'direct classification keeps the unchanged unrestricted API');
  let final: ScanProgress | undefined; const affected: string[] = [];
  const found = await scanLibraryAsync(custom, [root], {
    onStatus: (value) => { final = value; }, onUnreadable: (directory) => affected.push(directory),
  });
  assert.deepEqual(found.map((game) => game.path), [real], 'the incomplete outer engine score is never saved or treated as terminal');
  assert.equal(found[0]?.engineId, 'rpgmaker-mv');
  assert.equal(final?.probeLimited, 1); assert.equal(final?.unreadable, 0);
  assert.deepEqual(affected, [root], 'inconclusive prior game rows can be preserved separately from access-error counts');
});

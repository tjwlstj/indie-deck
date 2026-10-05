import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { detectGame } from '../src/detect/index.ts';
import {
  libraryPath,
  libraryStats,
  loadLibrary,
  refreshLibraryGame,
  saveLibrary,
} from '../src/library/index.ts';
import { loadRegistry } from '../src/registry/index.ts';

const reg = loadRegistry();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-library-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function testDir(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Builds a PE header with the given machine type, enough for game detection. */
function fakeExe(machine = 0x8664): Buffer {
  const buf = Buffer.alloc(512);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80);
  buf.writeUInt16LE(machine, 0x84);
  return buf;
}

function makeUnityGame(parent: string, name: string, deepMarker = ''): string {
  const root = path.join(parent, name);
  const files: Record<string, string | Buffer> = {
    [`${name}.exe`]: fakeExe(),
    'UnityPlayer.dll': 'stub',
    'GameAssembly.dll': 'stub',
    [`${name}_Data/globalgamemanagers`]: Buffer.concat([Buffer.alloc(48), Buffer.from('2021.3.23f1\0')]),
    [`${name}_Data/il2cpp_data/Metadata/global-metadata.dat`]: deepMarker,
  };
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

test('legacy library indexes load at revision zero', async () => {
  const dataDir = testDir('legacy-data');
  fs.writeFileSync(
    libraryPath(dataDir),
    JSON.stringify({ games: [], scannedAt: '2026-08-22T00:00:00.000Z', roots: ['D:/Games'] }),
    'utf8',
  );

  const loaded = await loadLibrary(dataDir);
  assert.equal(loaded.revision, 0);
  assert.equal(loaded.scannedAt, '2026-08-22T00:00:00.000Z');
  assert.deepEqual(loaded.roots, ['D:/Games']);
});

test('saveLibrary atomically replaces the file and advances from the newest revision', async () => {
  const dataDir = testDir('save-data');
  fs.writeFileSync(
    libraryPath(dataDir),
    JSON.stringify({ games: [], scannedAt: 'old', roots: [], revision: 4 }),
    'utf8',
  );

  const first = await saveLibrary({ games: [], scannedAt: 'first', roots: [], revision: 1 }, dataDir);
  assert.equal(first.revision, 5, 'a stale writer advances from the revision already on disk');

  const second = await saveLibrary({ games: [], scannedAt: 'second', roots: [] }, dataDir);
  assert.equal(second.revision, 6);
  assert.deepEqual(await loadLibrary(dataDir), second);
  assert.deepEqual(fs.readdirSync(dataDir), ['library.json'], 'the same-directory temporary file is cleaned up');
});

test('refreshLibraryGame deep-refreshes one row and keeps library metadata and statistics current', async () => {
  const root = testDir('targeted-root');
  const dataDir = testDir('targeted-data');
  const targetPath = makeUnityGame(root, 'Target', 'TMPro UnityEngine.InputSystem');
  const otherPath = makeUnityGame(root, 'Other');
  const targetBefore = detectGame(reg, targetPath);
  const otherBefore = detectGame(reg, otherPath);
  assert.ok(targetBefore);
  assert.ok(otherBefore);
  assert.equal(targetBefore.unity?.usesTextMeshPro, undefined, 'the seed profile was not deep-probed');

  const scannedAt = '2026-08-22T12:34:56.000Z';
  const seeded = await saveLibrary(
    { games: [targetBefore, otherBefore], scannedAt, roots: [root] },
    dataDir,
  );
  const preservedOther = (await loadLibrary(dataDir)).games.find((game) => game.path === otherPath);
  assert.ok(preservedOther);
  assert.equal(libraryStats(seeded).withTranslator, 0);

  const translatorMarker = path.join(targetPath, 'BepInEx/core/XUnity.Common.dll');
  fs.mkdirSync(path.dirname(translatorMarker), { recursive: true });
  fs.writeFileSync(translatorMarker, 'translator marker');

  const refreshed = await refreshLibraryGame(reg, targetPath, { dataDir });
  assert.ok(refreshed.profile);
  assert.equal(refreshed.profile.unity?.usesTextMeshPro, true, 'targeted refresh uses deep detection by default');
  assert.equal(refreshed.profile.installedTranslators[0]?.translatorId, 'xunity-autotranslator');
  assert.equal(refreshed.index.revision, seeded.revision + 1);
  assert.equal(refreshed.index.scannedAt, scannedAt, 'a targeted refresh does not pretend to be a full scan');
  assert.deepEqual(refreshed.index.roots, [root]);
  assert.deepEqual(
    refreshed.index.games.find((game) => game.path === otherPath),
    preservedOther,
    'unrelated rows are preserved byte-for-byte at the data level',
  );
  assert.equal(libraryStats(refreshed.index).withTranslator, 1, 'statistics immediately see the new translator');
  assert.deepEqual(await loadLibrary(dataDir), refreshed.index, 'the returned index is the revision actually persisted');

  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
  fs.writeFileSync(path.join(targetPath, 'readme.txt'), 'engine markers removed');

  const removed = await refreshLibraryGame(reg, targetPath, { dataDir });
  assert.equal(removed.profile, null, 'an existing folder without a known engine is an explicit removal result');
  assert.equal(removed.index.revision, refreshed.index.revision + 1);
  assert.equal(removed.index.scannedAt, scannedAt);
  assert.deepEqual(removed.index.roots, [root]);
  assert.deepEqual(removed.index.games.map((game) => game.path), [otherPath]);
  assert.deepEqual(libraryStats(removed.index), {
    total: 1,
    byEngine: [{ engineId: 'unity', engineName: 'Unity', count: 1 }],
    withTranslator: 0,
    withLoader: 0,
    byBackend: { il2cpp: 1 },
  });
});

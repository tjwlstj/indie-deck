import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { detectGame, scanLibrary } from '../src/detect/index.ts';
import { addRoot, loadLibrary, refreshLibrary, refreshLibraryGame, saveConfig } from '../src/library/index.ts';
import { loadRegistry } from '../src/registry/index.ts';
import { importGameArchive } from '../../desktop/src/game-archives.ts';

const reg = loadRegistry(), parent = path.resolve(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(parent, 'indiedeck-scan-roots-'));
after(() => { assert.equal(path.dirname(temporary), parent); fs.rmSync(temporary, { recursive: true, force: true }); });
function executable(): Buffer {
  const bytes = Buffer.alloc(512); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84); return bytes;
}
function files(prefix = ''): Record<string, string | Buffer> {
  return { [`${prefix}Game.exe`]: executable(), [`${prefix}nw.dll`]: 'static fixture', [`${prefix}package.json`]: '{"name":"archive-game"}',
    [`${prefix}js/rpg_core.js`]: '// fixture', [`${prefix}data/System.json`]: '{"gameTitle":"Registered Root Fixture","locale":"ja_JP"}' };
}
function game(relative: string): string {
  const root = path.join(temporary, relative);
  for (const [name, data] of Object.entries(files())) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), data);
  }
  assert.ok(detectGame(reg, root)); return root;
}
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(contents: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(contents)) {
    const encoded = Buffer.from(name), data = Buffer.isBuffer(content) ? content : Buffer.from(content), checksum = crc32(data);
    const head = Buffer.alloc(30), cd = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(checksum, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(encoded.length, 26);
    cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8);
    cd.writeUInt32LE(checksum, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(encoded.length, 28); cd.writeUInt32LE(offset, 42);
    local.push(head, encoded, data); central.push(cd, encoded); offset += head.length + encoded.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(contents).length, 8); end.writeUInt16LE(Object.keys(contents).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('an explicitly registered ordinary game root is scanned even at child depth zero', () => {
  const root = game('direct/Game'); const progress: string[] = [];
  const found = scanLibrary(reg, [root], { depth: 0, onProgress: (current) => progress.push(current) });
  assert.deepEqual(found.map((profile) => profile.path), [root]); assert.deepEqual(progress, [root]);
  const platformRoot = game('direct/Windows');
  assert.deepEqual(scanLibrary(reg, [platformRoot], { depth: 0 }).map((profile) => profile.path), [platformRoot], 'an explicit platform folder is not a broad drive root');
});
test('parent-root child scanning keeps the configured depth and stops descending into a detected game', () => {
  const root = path.join(temporary, 'children');
  const immediate = game('children/Immediate'), nested = game('children/Wrapper/Nested');
  game('children/Immediate/Embedded'); game('children/Wrapper/Deep/TooDeep');
  assert.deepEqual(scanLibrary(reg, [root], { depth: 1 }).map((profile) => profile.path), [immediate]);
  assert.deepEqual(scanLibrary(reg, [root], { depth: 2 }).map((profile) => profile.path), [immediate, nested]);
});
test('parent, direct and duplicate roots return one row per game in either registration order', () => {
  const root = game('overlap/Game'), library = path.dirname(root);
  for (const roots of [[library, root, library, root], [root, library, root, library]]) {
    assert.deepEqual(scanLibrary(reg, roots).map((profile) => profile.path), [root]);
  }
  if (process.platform === 'win32') assert.equal(scanLibrary(reg, [root, root.toUpperCase()]).length, 1);
});
test('later overlapping roots retain their larger remaining child-search budget', () => {
  const root = game('budgets/Wrapper/Inner/Game');
  assert.deepEqual(scanLibrary(reg, [path.join(temporary, 'budgets')], { depth: 2 }), []);
  assert.deepEqual(scanLibrary(reg, [path.join(temporary, 'budgets'), path.join(temporary, 'budgets/Wrapper')], { depth: 2 }).map((profile) => profile.path), [root]);
});
test('hidden staging/metadata directories are not candidates but an explicitly selected dot-named game is', () => {
  const ordinary = game('hidden/.VisibleWhenSelected'), staging = game('hidden/.staging-fixture'), metadata = game('hidden/.indiedeck');
  assert.deepEqual(scanLibrary(reg, [path.join(temporary, 'hidden')]), []);
  assert.deepEqual(scanLibrary(reg, [ordinary, staging, metadata]).map((profile) => profile.path), [ordinary]);
  assert.deepEqual(scanLibrary(reg, [path.join(temporary, 'does-not-exist')]), []);
  assert.deepEqual(scanLibrary(reg, [path.join(ordinary, 'Game.exe')]), []);
});
test('a direct root or ancestor junction cannot redirect scanning to an unregistered game', (context) => {
  const outside = game('junction-outside/Game'), linked = path.join(temporary, 'linked-library');
  try { fs.symlinkSync(path.dirname(outside), linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip('host does not permit a junction fixture'); return; } throw error; }
  assert.deepEqual(scanLibrary(reg, [linked]), []); assert.deepEqual(scanLibrary(reg, [path.join(linked, 'Game')]), []);
});
test('ZIP-root and deeply wrapped imported games survive a normal persisted full-library refresh', async () => {
  for (const [name, prefix] of [['zip-root', ''], ['zip-wrapper', 'Release/Windows/Game/']] as const) {
    const dataDir = path.join(temporary, `data-${name}`), archive = path.join(temporary, `${name}.zip`);
    fs.writeFileSync(archive, zip(files(prefix)));
    await saveConfig({ roots: [], locale: 'en', defaults: { targetLanguage: 'ko', sourceLanguage: 'ja', endpoint: 'GoogleTranslate' }, scanDepth: 2 }, dataDir);
    const imported = await importGameArchive(archive, { dataDir, registry: reg });
    await addRoot(imported.record.gameRoot, dataDir);
    const targeted = await refreshLibraryGame(reg, imported.record.gameRoot, { dataDir });
    assert.deepEqual(targeted.index.games.map((profile) => profile.path), [imported.record.gameRoot]);
    const full = await refreshLibrary(reg, { dataDir });
    assert.deepEqual(full.games.map((profile) => profile.path), [imported.record.gameRoot]);
    assert.equal(full.revision, targeted.index.revision + 1); assert.equal(full.games[0]?.engineId, 'rpgmaker-mv');
    assert.deepEqual((await loadLibrary(dataDir)).games, full.games); assert.equal(fs.existsSync(archive), true);
  }
});

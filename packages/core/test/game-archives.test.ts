import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { loadRegistry } from '../src/registry/index.ts';
import { importGameArchive, inspectGameArchive, listGameArchives } from '../../desktop/src/game-archives.ts';

const reg = loadRegistry();
const parent = path.resolve(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(parent, 'indiedeck-game-archives-'));
after(() => { assert.equal(path.dirname(temporary), parent); fs.rmSync(temporary, { recursive: true, force: true }); });
const CRC = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC[(value ^ byte) & 0xff]!;
  return (value ^ 0xffffffff) >>> 0;
}
type ZipFixtureEntry = { name: string; data?: string | Buffer; method?: number; flags?: number; unixKind?: number; crc?: number; size?: number; extra?: Buffer; disk?: number; localName?: string; compressed?: Buffer };
function zip(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const method = entry.method ?? 0, flags = entry.flags ?? 0x800, extra = entry.extra ?? Buffer.alloc(0);
    const compressed = entry.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const size = entry.size ?? data.length, checksum = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!(flags & 8)) { local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); }
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(extra.length, 28);
    const fullLocal = Buffer.concat([local, localName, extra, compressed]);
    locals.push(fullLocal);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(checksum, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30); c.writeUInt16LE(entry.disk ?? 0, 34);
    c.writeUInt32LE((((entry.unixKind ?? (entry.name.endsWith('/') ? 0x4000 : 0x8000)) << 16) | (entry.name.endsWith('/') ? 0x10 : 0)) >>> 0, 38);
    c.writeUInt32LE(offset, 42); central.push(Buffer.concat([c, name, extra])); offset += fullLocal.length;
  }
  const allCentral = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(allCentral.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, allCentral, end]);
}
function archive(name: string, entries: ZipFixtureEntry[] | Buffer): string {
  const target = path.join(temporary, name);
  fs.writeFileSync(target, Buffer.isBuffer(entries) ? entries : zip(entries)); return target;
}
function pe(): Buffer {
  const value = Buffer.alloc(512); value.writeUInt16LE(0x5a4d); value.writeUInt32LE(0x80, 0x3c); value.writeUInt32LE(0x4550, 0x80); value.writeUInt16LE(0x8664, 0x84); return value;
}
function gameEntries(prefix = 'Example/'): ZipFixtureEntry[] {
  return [{ name: `${prefix}Game.exe`, data: pe() }, { name: `${prefix}nw.dll`, data: 'fixture only' },
    { name: `${prefix}package.json`, data: '{"name":"rpg-test"}' }, { name: `${prefix}js/rpg_core.js`, data: '// static fixture' },
    { name: `${prefix}data/System.json`, data: '{"gameTitle":"Archive Fixture","locale":"ja_JP"}', method: 8 }];
}
function dataDir(name: string): string { return path.join(temporary, `state-${name}`); }

test('archive recognition uses signatures, marks guessed version hints and does not expose source paths', async () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const input = archive('Example_v1.2.3.unrelated-extension', gameEntries());
  const result = await inspectGameArchive(input);
  assert.equal(result.format, 'zip'); assert.equal(result.status, 'ready'); assert.equal(result.canImport, true);
  assert.equal(result.fileCount, 5); assert.equal(result.versionHint, '1.2.3'); assert.equal(result.versionHintIsGuess, true);
  assert.equal(result.sha256, crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'));
  assert.equal('path' in result, false); assert.equal('archivePath' in result, false);
});
test('7z and both RAR formats are recognised but never sent to an external extractor', async () => {
  for (const [name, signature, format] of [['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], '7z'],
    ['rar4', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], 'rar'], ['rar5', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], 'rar']] as const) {
    const input = archive(`${name}.zip`, Buffer.from(signature));
    const result = await inspectGameArchive(input);
    assert.equal(result.format, format); assert.equal(result.status, 'recognized'); assert.equal(result.canImport, false);
    assert.equal(result.reasonKey, 'ui.archives.reason.extractionUnsupported');
    await assert.rejects(importGameArchive(input, { dataDir: dataDir(name), registry: reg }), /extractionUnsupported/);
    assert.equal(fs.existsSync(dataDir(name)), false);
  }
});
test('unknown, self-extracting and truncated files are rejected without making managed directories', async () => {
  for (const [name, bytes] of [['unknown', Buffer.from('not an archive')], ['sfx', Buffer.concat([pe(), zip(gameEntries())])],
    ['truncated', zip(gameEntries()).subarray(0, 60)], ['emptyfile', Buffer.alloc(0)]] as const) {
    const result = await inspectGameArchive(archive(`${name}.zip`, bytes)); assert.equal(result.canImport, false); assert.equal(result.status, 'invalid');
  }
});
test('archive traversal, ADS, rooted paths, links, Windows device names and launcher metadata are rejected', async () => {
  for (const [index, name] of ['../outside.txt', '/outside.txt', 'C:/outside.txt', 'a\\outside.txt', 'a/../b', 'a//b', 'a/./b',
    'file:stream', 'nul.txt', 'COM1', 'lpt².dat', 'CONOUT$', 'a/trailing.', 'a/trailing ', 'a/control\0.txt', 'a/.indiedeck/receipt.json', '.IndieDeck-game-version.json'].entries()) {
    const result = await inspectGameArchive(archive(`unsafe-${index}.zip`, [{ name, data: 'never write this' }]));
    assert.equal(result.canImport, false, name); assert.match(result.reasonKey ?? '', /unsafePath|reservedMetadata/, name);
  }
  const symlink = await inspectGameArchive(archive('symlink.zip', [{ name: 'link', data: '../outside', unixKind: 0xa000 }]));
  assert.equal(symlink.reasonKey, 'ui.archives.reason.linkedEntry');
  const unixLink = Buffer.alloc(17); unixLink.writeUInt16LE(0x000d); unixLink.writeUInt16LE(13, 2);
  const extraLink = await inspectGameArchive(archive('extra-link.zip', [{ name: 'link', data: 'outside', extra: unixLink }]));
  assert.equal(extraLink.reasonKey, 'ui.archives.reason.linkedEntry');
});
test('explicit and implicit case collisions and parent-file collisions are rejected', async () => {
  const cases = [['a', 'A'], ['a', 'a/child'], ['Folder/a', 'folder/b'], ['Folder/', 'folder/b'], ['a/b', 'A/'], ['a', 'a'], ['Σ.txt', 'ς.txt']];
  for (const [index, names] of cases.entries()) {
    const result = await inspectGameArchive(archive(`collision-${index}.zip`, names.map((name) => ({ name }))));
    assert.equal(result.reasonKey, 'ui.archives.reason.pathCollision', names.join(','));
  }
});
test('encrypted, split, ZIP64, non-UTF8 and unsupported compression archives fail closed', async () => {
  const fixtures: [string, ZipFixtureEntry, string][] = [
    ['encrypted', { name: 'a', flags: 0x801 }, 'encrypted'], ['split', { name: 'a', disk: 1 }, 'multipart'],
    ['zip64', { name: 'a', extra: Buffer.from([1, 0, 0, 0]) }, 'zip64'], ['legacy-encoding', { name: '한글.txt', flags: 0 }, 'unsupportedEncoding'],
    ['compression', { name: 'a', method: 12 }, 'unsupportedCompression'], ['local-name', { name: 'a', localName: 'b' }, 'invalidZip'],
    ['declared-size', { name: 'a', size: 0xffffffff }, 'zip64']];
  for (const [name, entry, reason] of fixtures) assert.equal((await inspectGameArchive(archive(`${name}.zip`, [entry]))).reasonKey, `ui.archives.reason.${reason}`);
});
test('ZIP imports stream ordinary stored/deflated files, publish exactly one supported game and preserve the source', async () => {
  const input = archive('import_v2.1.zip', [{ name: 'Example/' }, ...gameEntries()]);
  const before = fs.readFileSync(input), inspected = await inspectGameArchive(input), events: string[] = [];
  const result = await importGameArchive(input, { dataDir: dataDir('valid'), registry: reg, label: ' Release 2.1 ', expectedSha256: inspected.sha256,
    onProgress: (progress) => { events.push(progress.phase); assert.ok(progress.bytesDone <= progress.bytesTotal); } });
  assert.equal(result.duplicate, false); assert.equal(result.record.engineId, 'rpgmaker-mv'); assert.equal(result.record.title, 'Archive Fixture');
  assert.equal(result.record.label, 'Release 2.1'); assert.equal(result.record.versionHint, '2.1');
  assert.equal(path.dirname(result.record.root), path.join(dataDir('valid'), 'game-versions')); assert.equal(result.record.gameRoot, path.join(result.record.root, 'Example'));
  assert.deepEqual(fs.readFileSync(input), before); assert.deepEqual(fs.readFileSync(path.join(result.record.gameRoot, 'Game.exe')), pe());
  assert.equal(fs.readFileSync(path.join(result.record.gameRoot, 'data', 'System.json'), 'utf8'), '{"gameTitle":"Archive Fixture","locale":"ja_JP"}');
  assert.deepEqual(new Set(events), new Set(['verify', 'extract', 'detect', 'publish'])); assert.deepEqual(await listGameArchives(dataDir('valid')), [result.record]);
});
test('a game at ZIP root imports without turning the internal staging name into its display name', async () => {
  const result = await importGameArchive(archive('RootGame_v1.4.zip', gameEntries('')), { dataDir: dataDir('root'), registry: reg });
  assert.equal(result.record.gameRoot, result.record.root); assert.equal(result.record.gameName, 'RootGame_v1.4'); assert.equal(result.record.title, 'Archive Fixture');
});
test('identical source content dedupes while different versions remain side by side without changing older games', async () => {
  const store = dataDir('versions'), input = archive('versions-v1.0.zip', gameEntries());
  const first = await importGameArchive(input, { dataDir: store, registry: reg, label: 'one' });
  const same = await importGameArchive(input, { dataDir: store, registry: reg, label: 'do not rename old record' });
  assert.equal(same.duplicate, true); assert.equal(same.record.id, first.record.id); assert.equal(same.record.label, 'one');
  const secondInput = archive('versions-v2.0.zip', [...gameEntries(), { name: 'Example/new-version.txt', data: 'two' }]);
  const second = await importGameArchive(secondInput, { dataDir: store, registry: reg, label: 'two' });
  assert.equal(second.duplicate, false); assert.notEqual(second.record.id, first.record.id); assert.equal(fs.existsSync(first.record.gameRoot), true);
  assert.equal(fs.existsSync(path.join(first.record.gameRoot, 'new-version.txt')), false); assert.equal((await listGameArchives(store)).length, 2);
});
test('changed archive candidates, malformed labels and fake expected hashes cannot import', async () => {
  const input = archive('changed.zip', gameEntries()), expected = (await inspectGameArchive(input)).sha256;
  fs.writeFileSync(input, zip([...gameEntries(), { name: 'Example/changed.txt', data: 'changed' }]));
  await assert.rejects(importGameArchive(input, { dataDir: dataDir('changed'), registry: reg, expectedSha256: expected }), /changedArchive/);
  await assert.rejects(importGameArchive(input, { dataDir: dataDir('bad-hash'), registry: reg, expectedSha256: '../path' }), /changedArchive/);
  for (const label of ['x'.repeat(81), 'version\nspoof']) await assert.rejects(importGameArchive(input, { dataDir: dataDir('bad-label'), registry: reg, label }), /invalidLabel/);
  assert.equal(fs.existsSync(dataDir('changed')), false);
});
test('CRC mismatches and undeclared decompression output roll back only the owned staging folder', async () => {
  for (const [name, badEntry, reason] of [['bad-crc', { name: 'Example/bad.txt', data: 'crc data', crc: 0 }, 'crcMismatch'],
    ['bomb', { name: 'Example/bad.txt', data: 'x'.repeat(1024 * 1024), method: 8, size: 1 }, 'sizeMismatch']] as const) {
    const store = dataDir(name), input = archive(`${name}.zip`, [...gameEntries(), badEntry]);
    await assert.rejects(importGameArchive(input, { dataDir: store, registry: reg }), new RegExp(reason));
    assert.deepEqual(fs.readdirSync(path.join(store, 'game-versions')), []); assert.equal(fs.existsSync(input), true);
  }
});
test('empty, unknown and multiple-game ZIPs are recognised but cannot publish a game version', async () => {
  for (const [name, entries, reason] of [['emptyzip', [], 'noGame'], ['unknown-game', [{ name: 'readme.txt', data: 'not a supported engine' }], 'noGame'],
    ['multi-game', [...gameEntries('One/'), ...gameEntries('Two/')], 'multipleGames'],
    ['root-and-nested-games', [...gameEntries(''), ...gameEntries('Nested/')], 'multipleGames']] as const) {
    const input = archive(`${name}.zip`, [...entries]); assert.equal((await inspectGameArchive(input)).format, 'zip');
    await assert.rejects(importGameArchive(input, { dataDir: dataDir(name), registry: reg }), new RegExp(reason));
    assert.deepEqual(fs.readdirSync(path.join(dataDir(name), 'game-versions')), []);
  }
});
test('archive directory depth is bounded and unavailable imported executables are not dedupe targets', async () => {
  const deep = await inspectGameArchive(archive('too-deep.zip', [{ name: `${'a/'.repeat(17)}file.txt`, data: 'fixture' }]));
  assert.equal(deep.reasonKey, 'ui.archives.reason.limits');
  const input = archive('vanished-exe.zip', gameEntries()), store = dataDir('vanished-exe');
  const first = await importGameArchive(input, { dataDir: store, registry: reg });
  fs.unlinkSync(path.join(first.record.gameRoot, 'Game.exe')); assert.deepEqual(await listGameArchives(store), []);
  const replacement = await importGameArchive(input, { dataDir: store, registry: reg });
  assert.equal(replacement.duplicate, false); assert.notEqual(replacement.record.id, first.record.id); assert.equal(fs.existsSync(first.record.gameRoot), true);
});
test('persisted version paths are derived from managed UUID folders and forged out-of-root paths are ignored', async () => {
  const store = dataDir('tampered-record'), result = await importGameArchive(archive('record.zip', gameEntries()), { dataDir: store, registry: reg });
  const metadata = path.join(result.record.root, '.indiedeck-game-version.json'), original = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  fs.writeFileSync(metadata, JSON.stringify({ ...original, root: 'C:\\not-owned', gameRoot: 'C:\\not-owned' }));
  assert.equal((await listGameArchives(store))[0]?.gameRoot, result.record.gameRoot);
  fs.writeFileSync(metadata, JSON.stringify({ ...original, gameRelativePath: '../not-owned' })); assert.deepEqual(await listGameArchives(store), []);
  fs.writeFileSync(metadata, JSON.stringify({ ...original, id: '../not-owned' })); assert.deepEqual(await listGameArchives(store), []);
});
test('directory junctions cannot redirect managed version storage or archive-source ancestry', async (context) => {
  const outside = path.join(temporary, 'outside'), store = dataDir('junction'); fs.mkdirSync(outside); fs.mkdirSync(store);
  try { fs.symlinkSync(outside, path.join(store, 'game-versions'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip('host does not permit junction fixture'); return; } throw error; }
  const input = archive('junction.zip', gameEntries()); await assert.rejects(importGameArchive(input, { dataDir: store, registry: reg }), /unsafeSource/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.copyFileSync(input, path.join(outside, 'linked.zip'));
  const inspected = await inspectGameArchive(path.join(store, 'game-versions', 'linked.zip')); assert.equal(inspected.reasonKey, 'ui.archives.reason.unsafeSource');
});

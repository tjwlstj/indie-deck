import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import zlib from 'node:zlib';
import { extractZip, readZipEntries, safeJoin } from '../src/install/unzip.ts';

/** Minimal ZIP writer so the extractor is tested against bytes, not a mock. */
function buildZip(files: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const compressed = file.store ? file.data : zlib.deflateRawSync(file.data);
    const method = file.store ? 0 : 8;
    const crc = zlib.crc32 ? zlib.crc32(file.data) : 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-zip-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('reads the central directory of a deflate archive', async () => {
  const archive = path.join(tmp, 'a.zip');
  await fsp.writeFile(
    archive,
    buildZip([
      { name: 'BepInEx/core/BepInEx.dll', data: Buffer.from('x'.repeat(2048)) },
      { name: 'winhttp.dll', data: Buffer.from('proxy'), store: true },
    ]),
  );
  const entries = readZipEntries(await fsp.readFile(archive));
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.name, 'BepInEx/core/BepInEx.dll');
  assert.equal(entries[0]?.method, 8);
  assert.equal(entries[1]?.method, 0, 'stored entries stay stored');
});

test('extracts both deflate and stored entries to disk', async () => {
  const archive = path.join(tmp, 'b.zip');
  await fsp.writeFile(
    archive,
    buildZip([
      { name: 'BepInEx/plugins/XUnity.AutoTranslator/plugin.dll', data: Buffer.from('deflated payload'.repeat(50)) },
      { name: 'doorstop_config.ini', data: Buffer.from('[UnityDoorstop]\n'), store: true },
    ]),
  );
  const dest = path.join(tmp, 'game');
  const result = await extractZip(archive, dest);

  assert.equal(result.files.length, 2);
  assert.equal(
    await fsp.readFile(path.join(dest, 'BepInEx/plugins/XUnity.AutoTranslator/plugin.dll'), 'utf8'),
    'deflated payload'.repeat(50),
  );
  assert.equal(await fsp.readFile(path.join(dest, 'doorstop_config.ini'), 'utf8'), '[UnityDoorstop]\n');
});

test('dry run reports files without writing them', async () => {
  const archive = path.join(tmp, 'c.zip');
  await fsp.writeFile(archive, buildZip([{ name: 'Mods/mod.dll', data: Buffer.from('m') }]));
  const dest = path.join(tmp, 'dry');
  const result = await extractZip(archive, dest, { dryRun: true });
  assert.deepEqual(result.files, [path.normalize('Mods/mod.dll')]);
  assert.equal(fs.existsSync(dest), false);
});

test('stripComponents drops the wrapper folder', async () => {
  const archive = path.join(tmp, 'd.zip');
  await fsp.writeFile(archive, buildZip([{ name: 'wrapper/inner/file.txt', data: Buffer.from('hi') }]));
  const dest = path.join(tmp, 'stripped');
  const result = await extractZip(archive, dest, { stripComponents: 1 });
  assert.deepEqual(result.files, [path.normalize('inner/file.txt')]);
});

test('refuses path traversal and absolute paths', () => {
  const root = path.join(tmp, 'root');
  assert.equal(safeJoin(root, 'a/b.txt'), path.resolve(root, 'a/b.txt'));
  assert.throws(() => safeJoin(root, '../escape.txt'), /outside the target folder/);
  assert.throws(() => safeJoin(root, 'C:/Windows/system32/evil.dll'), /absolute path/);
});

test('rejects a non-zip file with a clear message', async () => {
  const archive = path.join(tmp, 'not.zip');
  await fsp.writeFile(archive, Buffer.from('this is not a zip file'));
  await assert.rejects(() => extractZip(archive, path.join(tmp, 'nope')), /Not a ZIP archive/);
});

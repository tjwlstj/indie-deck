import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, mock, test } from 'node:test';
import { extractZip, readEntryData, readZipEntries, MAX_ZIP_SOURCE_BYTES, MAX_ZIP_ENTRY_BYTES } from '../src/install/unzip.ts';

const parent = path.resolve(os.tmpdir()), temporary = await fs.mkdtemp(path.join(parent, 'indiedeck-unzip-security-'));
after(async () => { assert.equal(path.dirname(path.resolve(temporary)), parent); await fs.rm(temporary, { recursive: true, force: true }); });
interface File { name: string; data?: Buffer; stored?: boolean; flags?: number; attrs?: number; descriptor?: boolean; extra?: Buffer }
function zip(files: File[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = file.data ?? Buffer.from('payload'), compressed = file.stored ? data : zlib.deflateRawSync(data);
    const extra = file.extra ?? Buffer.alloc(0), flags = (file.flags ?? 0) | (file.descriptor ? 8 : 0), crc = zlib.crc32(data);
    const local = Buffer.alloc(30 + name.length + extra.length), central = Buffer.alloc(46 + name.length + extra.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(file.stored ? 0 : 8, 8);
    local.writeUInt32LE(file.descriptor ? 0 : crc, 14); local.writeUInt32LE(file.descriptor ? 0 : compressed.length, 18); local.writeUInt32LE(file.descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28); name.copy(local, 30); extra.copy(local, 30 + name.length);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(3 * 256 + 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(file.stored ? 0 : 8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(file.attrs ?? 0, 38); central.writeUInt32LE(offset, 42);
    name.copy(central, 46); extra.copy(central, 46 + name.length);
    const descriptor = file.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (file.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(data.length, 12); }
    locals.push(local, compressed, descriptor); centrals.push(central); offset += local.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function directory(buffer: Buffer): number { return buffer.readUInt32LE(buffer.length - 6); }
async function source(name: string, bytes: Buffer) { const archive = path.join(temporary, name + '.zip'); await fs.writeFile(archive, bytes); return archive; }
test('valid UTF-8 names, leading root directories and signed data descriptors remain supported', async () => {
  const bytes = zip([{ name: './', data: Buffer.alloc(0) }, { name: './folder/', data: Buffer.alloc(0) },
    { name: './folder/한글.txt', data: Buffer.from('checked'), flags: 0x800, descriptor: true }]);
  const entries = readZipEntries(bytes); assert.equal(entries.length, 3);
  assert.equal(readEntryData(bytes, entries[2]!).toString(), 'checked');
  const destination = path.join(temporary, 'unicode-output');
  await extractZip(await source('unicode', bytes), destination, { expectedSha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  assert.equal(await fs.readFile(path.join(destination, 'folder/한글.txt'), 'utf8'), 'checked');
});
test('encryption, split archives, Zip64 and excessive entry counts fail during metadata validation', () => {
  const ordinary = zip([{ name: 'file.txt' }]);
  const encrypted = Buffer.from(ordinary); encrypted.writeUInt16LE(1, 6); encrypted.writeUInt16LE(1, directory(encrypted) + 8);
  assert.throws(() => readZipEntries(encrypted), /Encrypted/);
  const split = Buffer.from(ordinary); split.writeUInt16LE(1, split.length - 18); assert.throws(() => readZipEntries(split), /Split/);
  const zip64 = Buffer.from(ordinary); zip64.writeUInt32LE(0xffffffff, zip64.length - 10); assert.throws(() => readZipEntries(zip64), /Zip64/);
  const many = Buffer.from(ordinary); many.writeUInt16LE(10001, many.length - 14); many.writeUInt16LE(10001, many.length - 12);
  assert.throws(() => readZipEntries(many), /entry count limit/);
  const extra = Buffer.alloc(4); extra.writeUInt16LE(1);
  assert.throws(() => readZipEntries(zip([{ name: 'file.txt', extra }])), /Zip64/);
});
test('absolute, traversal, alternate-stream and Windows alias paths cannot enter an extraction plan', () => {
  for (const name of ['/outside.txt', '\\\\server\\share\\file', '../outside', 'dir/../outside', 'dir\\..\\outside',
    'C:/outside.txt', 'file.txt:stream', 'CON.txt', 'dir/NUL', 'file.', 'dir. /file', 'name\u0000.txt', 'dir//file']) {
    assert.throws(() => readZipEntries(zip([{ name }])), /path|folder/);
  }
});
test('case aliases, duplicate output paths and file-parent collisions are rejected before writing', async () => {
  for (const files of [
    [{ name: 'Data/a.dll' }, { name: 'data/A.dll' }],
    [{ name: 'directory', stored: true }, { name: 'directory/file.txt' }],
  ]) assert.throws(() => readZipEntries(zip(files)), /Duplicate|conflict/);
  const archive = await source('stripping-aliases', zip([{ name: 'a/same.txt' }, { name: 'b/same.txt' }]));
  const destination = path.join(temporary, 'stripping-output');
  await assert.rejects(() => extractZip(archive, destination, { stripComponents: 1 }), /Duplicate/);
  await assert.rejects(() => fs.stat(destination), { code: 'ENOENT' });
});
test('symlink, device and reparse metadata cannot masquerade as regular ZIP files', () => {
  for (const attrs of [(0o120777 << 16) >>> 0, (0o020666 << 16) >>> 0, 0x400]) {
    assert.throws(() => readZipEntries(zip([{ name: 'file.txt', attrs }])), /Linked or special/);
  }
});
test('local name, size and central directory bounds must describe the same bytes', () => {
  const ordinary = zip([{ name: 'file.txt' }]);
  const name = Buffer.from(ordinary); name[30] = 0x78; assert.throws(() => readZipEntries(name), /headers disagree/);
  const size = Buffer.from(ordinary); size.writeUInt32LE(999, 18); assert.throws(() => readZipEntries(size), /sizes disagree/);
  const central = Buffer.from(ordinary); central.writeUInt16LE(65535, directory(central) + 28); assert.throws(() => readZipEntries(central), /bounds/);
  const badUtf8 = Buffer.from(ordinary); badUtf8[directory(badUtf8) + 46] = 0xff; assert.throws(() => readZipEntries(badUtf8), /UTF-8/);
  for (const length of [0, 3, 21]) assert.throws(() => readZipEntries(Buffer.alloc(length)), /Not a ZIP/);
});
test('overlapping local records cannot supply two entries', () => {
  const bytes = zip([{ name: 'a', data: Buffer.from('a'), stored: true }, { name: 'b', data: Buffer.from('b'), stored: true }]);
  const central = directory(bytes); bytes.writeUInt32LE(33, 18); bytes.writeUInt32LE(33, 22);
  bytes.writeUInt32LE(33, central + 20); bytes.writeUInt32LE(33, central + 24);
  assert.throws(() => readZipEntries(bytes), /Overlapping/);
});
test('forged deflate sizes and declared expanded ceilings are rejected with bounded output', async () => {
  const bomb = zip([{ name: 'bomb.bin', data: Buffer.alloc(1024 * 1024, 0x61) }]);
  bomb.writeUInt32LE(1, 22); bomb.writeUInt32LE(1, directory(bomb) + 24);
  const destination = path.join(temporary, 'bomb-output');
  await assert.rejects(async () => extractZip(await source('bomb', bomb), destination), /decompression.*limit/);
  await assert.rejects(() => fs.stat(destination), { code: 'ENOENT' });
  const excessive = zip([{ name: 'large.bin' }]); excessive.writeUInt32LE(MAX_ZIP_ENTRY_BYTES + 1, 22); excessive.writeUInt32LE(MAX_ZIP_ENTRY_BYTES + 1, directory(excessive) + 24);
  assert.throws(() => readZipEntries(excessive), /expanded byte limit/);
});
test('a later CRC mismatch is found before an earlier existing destination changes', async () => {
  const bytes = zip([{ name: 'existing.txt', stored: true }, { name: 'later.txt', stored: true }]);
  const second = readZipEntries(bytes)[1]!, central = directory(bytes) + 46 + 'existing.txt'.length;
  bytes.writeUInt32LE(0, second.offset + 14); bytes.writeUInt32LE(0, central + 16);
  const destination = path.join(temporary, 'crc-output'); await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'existing.txt'), 'original');
  await assert.rejects(async () => extractZip(await source('crc', bytes), destination), /CRC mismatch/);
  assert.equal(await fs.readFile(path.join(destination, 'existing.txt'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(destination), ['existing.txt']);
});
test('expected source hashes bind both preview and write to the scanned archive bytes', async () => {
  const first = zip([{ name: 'expected.txt' }]), archive = await source('bound-hash', first), destination = path.join(temporary, 'bound-output');
  const expectedSha256 = crypto.createHash('sha256').update(first).digest('hex');
  assert.deepEqual((await extractZip(archive, destination, { dryRun: true, expectedSha256 })).files, ['expected.txt']);
  await fs.writeFile(archive, zip([{ name: 'changed.txt' }]));
  await assert.rejects(() => extractZip(archive, destination, { expectedSha256 }), /checksum mismatch/);
  await assert.rejects(() => fs.stat(destination), { code: 'ENOENT' });
});
test('a linked later target or a linked source is refused without changing an earlier file', async () => {
  const bytes = zip([{ name: 'existing.txt' }, { name: 'linked/file.txt' }]), archive = await source('linked-target', bytes);
  const destination = path.join(temporary, 'linked-output'), outside = path.join(temporary, 'outside');
  await fs.mkdir(destination); await fs.mkdir(outside); await fs.writeFile(path.join(destination, 'existing.txt'), 'original');
  await fs.symlink(outside, path.join(destination, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => extractZip(archive, destination), /Linked ZIP filesystem/);
  assert.equal(await fs.readFile(path.join(destination, 'existing.txt'), 'utf8'), 'original'); assert.deepEqual(await fs.readdir(outside), []);
  const alias = path.join(temporary, 'hardlinked-source.zip'); await fs.link(archive, alias);
  await assert.rejects(() => extractZip(alias, path.join(temporary, 'hardlink-output')), /Linked or non-file/);
});
test('oversized source metadata is refused before allocating or reading the archive', async () => {
  const archive = await source('oversize', zip([{ name: 'file.txt' }]));
  const original = fs.lstat, actual = await original(archive);
  const oversized = Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { size: MAX_ZIP_SOURCE_BYTES + 1 });
  const stub = mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => String(args[0]) === archive ? oversized : original(...args));
  try { await assert.rejects(() => extractZip(archive, path.join(temporary, 'oversize-output')), /source byte limit/); }
  finally { stub.mock.restore(); }
});
test('the sum of expanded declarations is bounded independently of each entry', () => {
  const bytes = zip(Array.from({ length: 9 }, (_, index) => ({ name: 'part' + index, data: Buffer.from('a') })));
  let central = directory(bytes);
  for (let index = 0; index < 9; index += 1) {
    const local = bytes.readUInt32LE(central + 42);
    bytes.writeUInt32LE(MAX_ZIP_ENTRY_BYTES, local + 22); bytes.writeUInt32LE(MAX_ZIP_ENTRY_BYTES, central + 24);
    central += 46 + bytes.readUInt16LE(central + 28);
  }
  assert.throws(() => readZipEntries(bytes), /expanded byte limit/);
});
test('a same-size stage edit cannot be published as the decoded ZIP payload', async () => {
  const archive = await source('stage-edit', zip([{ name: 'output.txt', data: Buffer.from('expected bytes') }]));
  const destination = path.join(temporary, 'stage-edit-output'), originalOpen = fs.open;
  let edited = false;
  const stub = mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes('.indiedeck-unzip-') && args[1] === 'wx') {
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        await originalWrite(...writeArgs); await handle.write(Buffer.from('x'), 0, 1, 0); edited = true;
      };
    }
    return handle;
  });
  try { await assert.rejects(() => extractZip(archive, destination), /staged output differs/); }
  finally { stub.mock.restore(); }
  assert.equal(edited, true); assert.deepEqual(await fs.readdir(destination), []);
});
test('Win32 superscript devices and Unicode case aliases are rejected before extraction', async () => {
  for (const name of ['COM¹.txt', 'com².log', 'LPT³.bin', 'CONIN$', 'CONOUT$', 'folder/conout$.txt']) {
    assert.throws(() => readZipEntries(zip([{ name }])), /Unsafe ZIP entry path/);
  }
  assert.throws(() => readZipEntries(zip([{ name: 'Σ.txt' }, { name: 'ς.txt' }])), /case-colliding/);
  const stripped = await source('win32-strip-alias', zip([{ name: 'one/Σ.txt' }, { name: 'two/ς.txt' }]));
  const destination = path.join(temporary, 'win32-strip-output');
  await assert.rejects(() => extractZip(stripped, destination, { stripComponents: 1 }), /Duplicate ZIP output/);
  await assert.rejects(() => fs.stat(destination), { code: 'ENOENT' });
  const bytes = zip([{ name: 'win32-source-ς.zip' }]), archive = await source('win32-source-Σ', bytes);
  await assert.rejects(() => extractZip(archive, temporary), /replace its source archive/);
  assert.deepEqual(await fs.readFile(archive), bytes);
});

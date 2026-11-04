import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Stats } from 'node:fs';

export const MAX_ZIP_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_ZIP_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;
const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;
export interface ZipEntry {
  name: string; isDirectory: boolean; compressedSize: number; uncompressedSize: number;
  method: number; offset: number; crc32: number; flags?: number; externalAttributes?: number;
}
function bounds(buffer: Buffer, offset: number, size: number, limit = buffer.length): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > limit - size || limit > buffer.length) throw new Error('Corrupt ZIP header or entry bounds.');
}
function findEocd(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 0xffff - 22); index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIG && index + 22 + buffer.readUInt16LE(index + 20) === buffer.length) return index;
  }
  return -1;
}
function decodeName(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('ZIP entry names must be valid UTF-8.'); }
}
function normalizedName(relative: string, directory = false): string {
  if (typeof relative !== 'string' || relative.length > 1024 || /[\u0000-\u001f\u007f]/.test(relative)) throw new Error('Unsafe ZIP entry path.');
  const value = relative.replace(/\\/g, '/');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error('Refusing to extract absolute path.');
  const cleaned = value.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
  if ((cleaned === '' || cleaned === '.') && directory) return '';
  const parts = cleaned.split('/');
  if (parts.some((part) => part === '..')) throw new Error('Refusing to extract outside the target folder.');
  if (parts.some((part) => !part || part === '.' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[.]|$)/i.test(part))) throw new Error('Unsafe ZIP entry path.');
  return cleaned;
}
function pathKey(name: string): string { return name.normalize('NFC').toUpperCase().toLowerCase(); }
function extraFields(buffer: Buffer, offset: number, size: number): void {
  bounds(buffer, offset, size);
  const end = offset + size;
  for (let cursor = offset; cursor < end;) {
    bounds(buffer, cursor, 4, end);
    const id = buffer.readUInt16LE(cursor), length = buffer.readUInt16LE(cursor + 2);
    bounds(buffer, cursor + 4, length, end);
    if (id === 0x0001) throw new Error('Zip64 archives are not supported by the built-in extractor.');
    if (id === 0x9901) throw new Error('Encrypted ZIP entries are not supported.');
    if (id === 0x756e && length >= 6) {
      const kind = buffer.readUInt16LE(cursor + 8) & 0o170000;
      if (kind && kind !== 0o100000 && kind !== 0o040000) throw new Error('Linked or special ZIP entries are not supported.');
    }
    cursor += 4 + length;
  }
}
function localDetails(buffer: Buffer, entry: ZipEntry, limit: number): { start: number; end: number } {
  bounds(buffer, entry.offset, 30, limit);
  if (buffer.readUInt32LE(entry.offset) !== LFH_SIG) throw new Error('Corrupt ZIP local header.');
  const flags = buffer.readUInt16LE(entry.offset + 6), method = buffer.readUInt16LE(entry.offset + 8);
  const crc = buffer.readUInt32LE(entry.offset + 14), compressed = buffer.readUInt32LE(entry.offset + 18), uncompressed = buffer.readUInt32LE(entry.offset + 22);
  const nameSize = buffer.readUInt16LE(entry.offset + 26), extraSize = buffer.readUInt16LE(entry.offset + 28);
  bounds(buffer, entry.offset + 30, nameSize + extraSize, limit);
  if (flags !== entry.flags || method !== entry.method || decodeName(buffer.subarray(entry.offset + 30, entry.offset + 30 + nameSize)) !== entry.name) throw new Error('ZIP local and central headers disagree.');
  if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new Error('Zip64 archives are not supported by the built-in extractor.');
  if (flags & 8 ? (crc !== 0 && crc !== entry.crc32 || compressed !== 0 && compressed !== entry.compressedSize || uncompressed !== 0 && uncompressed !== entry.uncompressedSize)
    : crc !== entry.crc32 || compressed !== entry.compressedSize || uncompressed !== entry.uncompressedSize) throw new Error('ZIP local and central sizes disagree.');
  extraFields(buffer, entry.offset + 30 + nameSize, extraSize);
  const start = entry.offset + 30 + nameSize + extraSize;
  bounds(buffer, start, entry.compressedSize, limit);
  let end = start + entry.compressedSize;
  if (flags & 8) {
    const matches = (offset: number): boolean => offset <= limit - 12 && buffer.readUInt32LE(offset) === entry.crc32 &&
      buffer.readUInt32LE(offset + 4) === entry.compressedSize && buffer.readUInt32LE(offset + 8) === entry.uncompressedSize;
    if (end <= limit - 16 && buffer.readUInt32LE(end) === 0x08074b50 && matches(end + 4)) end += 16;
    else if (matches(end)) end += 12;
    else throw new Error('ZIP data descriptor is missing or corrupt.');
  }
  return { start, end };
}
function noFileAncestors(paths: Map<string, boolean>): void {
  for (const name of paths.keys()) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.get(parts.slice(0, index).join('/')) === false) throw new Error('ZIP file and directory paths conflict.');
    }
  }
}

/** Strict metadata validation precedes decoding or any destination mutation. */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ZIP_SOURCE_BYTES) throw new Error('ZIP source byte limit exceeded.');
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('Not a ZIP archive (end-of-central-directory record not found).');
  const count = buffer.readUInt16LE(eocd + 10), cdSize = buffer.readUInt32LE(eocd + 12), cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported by the built-in extractor.');
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) || buffer.readUInt16LE(eocd + 8) !== count) throw new Error('Split ZIP archives are not supported.');
  if (count > MAX_ZIP_ENTRIES || cdOffset + cdSize !== eocd) throw new Error('Corrupt ZIP central directory or entry count limit exceeded.');
  bounds(buffer, cdOffset, cdSize, eocd);
  const entries: ZipEntry[] = [], regions: { start: number; end: number }[] = [], paths = new Map<string, boolean>();
  let cursor = cdOffset, total = 0;
  for (let index = 0; index < count; index += 1) {
    bounds(buffer, cursor, 46, eocd);
    if (buffer.readUInt32LE(cursor) !== CD_SIG) throw new Error('Corrupt ZIP central directory.');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    if (flags & 0x41 || flags & ~0x080e) throw new Error('Encrypted or unsupported ZIP flags.');
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method.');
    const compressedSize = buffer.readUInt32LE(cursor + 20), uncompressedSize = buffer.readUInt32LE(cursor + 24), offset = buffer.readUInt32LE(cursor + 42);
    const nameSize = buffer.readUInt16LE(cursor + 28), extraSize = buffer.readUInt16LE(cursor + 30), commentSize = buffer.readUInt16LE(cursor + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || offset === 0xffffffff) throw new Error('Zip64 archives are not supported by the built-in extractor.');
    if (buffer.readUInt16LE(cursor + 34)) throw new Error('Split ZIP archives are not supported.');
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES || compressedSize > MAX_ZIP_SOURCE_BYTES || total + uncompressedSize > MAX_ZIP_TOTAL_BYTES) throw new Error('ZIP expanded byte limit exceeded.');
    if (method === 0 && compressedSize !== uncompressedSize) throw new Error('Stored ZIP entry sizes disagree.');
    bounds(buffer, cursor + 46, nameSize + extraSize + commentSize, eocd);
    const name = decodeName(buffer.subarray(cursor + 46, cursor + 46 + nameSize)), attributes = buffer.readUInt32LE(cursor + 38);
    const mode = attributes >>> 16, kind = mode & 0o170000;
    if (kind && kind !== 0o100000 && kind !== 0o040000 || attributes & 0x400) throw new Error('Linked or special ZIP entries are not supported.');
    const isDirectory = name.endsWith('/') || name.endsWith('\\') || Boolean(attributes & 0x10) || kind === 0o040000;
    if (isDirectory && (uncompressedSize !== 0 || kind === 0o100000)) throw new Error('Conflicting ZIP directory metadata.');
    const normalized = normalizedName(name, isDirectory), key = pathKey(normalized);
    if (paths.has(key)) throw new Error('Duplicate or case-colliding ZIP paths.');
    paths.set(key, isDirectory);
    extraFields(buffer, cursor + 46 + nameSize, extraSize);
    const entry: ZipEntry = { name, isDirectory, compressedSize, uncompressedSize, method, offset, crc32: buffer.readUInt32LE(cursor + 16), flags, externalAttributes: attributes };
    const local = localDetails(buffer, entry, cdOffset);
    entries.push(entry); regions.push({ start: offset, end: local.end }); total += uncompressedSize;
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== cdOffset + cdSize) throw new Error('ZIP central directory length disagrees.');
  regions.sort((a, b) => a.start - b.start);
  for (let index = 1; index < regions.length; index += 1) if (regions[index]!.start < regions[index - 1]!.end) throw new Error('Overlapping ZIP entries.');
  noFileAncestors(paths);
  return entries;
}
function decodeEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const { start } = localDetails(buffer, entry, buffer.length);
  const raw = buffer.subarray(start, start + entry.compressedSize);
  let output: Buffer;
  if (entry.method === 0) output = Buffer.from(raw);
  else {
    try { output = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(entry.uncompressedSize + 1, MAX_ZIP_ENTRY_BYTES)) }); }
    catch { throw new Error('ZIP decompression exceeded its limit or the entry is corrupt.'); }
  }
  if (output.length !== entry.uncompressedSize) throw new Error('ZIP expanded size disagrees with its declaration.');
  if (zlib.crc32(output) !== entry.crc32) throw new Error('ZIP CRC mismatch.');
  return output;
}
export function readEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  const actual = readZipEntries(buffer).find((candidate) => candidate.offset === entry.offset && candidate.name === entry.name);
  if (!actual || ['compressedSize', 'uncompressedSize', 'method', 'crc32'].some((key) => actual[key as keyof ZipEntry] !== entry[key as keyof ZipEntry])) throw new Error('ZIP entry does not match its central directory.');
  return decodeEntry(buffer, actual);
}

/** Root lookup may use an empty relative path; archive file entries may not. */
export function safeJoin(root: string, relative: string): string {
  const resolved = path.resolve(root);
  if (relative === '') return resolved;
  const normalized = normalizedName(relative);
  const target = path.resolve(resolved, normalized);
  const relation = path.relative(resolved, target);
  if (relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) throw new Error('Refusing to extract outside the target folder.');
  return target;
}
export interface ExtractOptions { stripComponents?: number; filterPrefix?: string; dryRun?: boolean; expectedSha256?: string }
export interface ExtractResult { files: string[]; skipped: string[] }
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
async function ordinaryDirectory(target: string, create = false): Promise<boolean> {
  if (target.includes('\0') || /^\\\\[?.]\\/.test(target)) throw new Error('Unsafe ZIP filesystem path.');
  const resolved = path.resolve(target), root = path.parse(resolved).root;
  let current = root;
  const parts = [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean).map((part) => { current = path.join(current, part); return current; })];
  for (const part of parts) {
    let stat: Stats;
    try { stat = await fsp.lstat(part); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fsp.mkdir(part); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await fsp.lstat(part);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked ZIP filesystem paths are not accepted.');
  }
  return true;
}
async function ordinaryFile(file: string): Promise<Stats | undefined> {
  if (!await ordinaryDirectory(path.dirname(file))) return undefined;
  let stat: Stats;
  try { stat = await fsp.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Linked or non-file ZIP targets are not accepted.');
  return stat;
}
async function archiveBuffer(file: string): Promise<Buffer> {
  const before = await ordinaryFile(file);
  if (!before || before.size > MAX_ZIP_SOURCE_BYTES) throw new Error('ZIP source byte limit exceeded or source is missing.');
  const handle = await fsp.open(file, 'r'), buffer = Buffer.alloc(before.size + 1);
  let size = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, before)) throw new Error('ZIP source changed before reading.');
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
      if (size > MAX_ZIP_SOURCE_BYTES) throw new Error('ZIP source byte limit exceeded.');
    }
  } finally { await handle.close(); }
  const after = await ordinaryFile(file);
  if (!after || !sameFile(before, after) || size !== after.size) throw new Error('ZIP source changed while reading.');
  return buffer.subarray(0, size);
}
async function checkedStage(file: string, bytes: number, expectedSha256: string): Promise<Stats> {
  const before = await ordinaryFile(file);
  if (!before || before.size !== bytes) throw new Error('ZIP staged output changed.');
  const handle = await fsp.open(file, 'r'), hash = crypto.createHash('sha256'), block = Buffer.alloc(1024 * 1024);
  let received = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) throw new Error('ZIP staged output changed.');
    for (;;) {
      const result = await handle.read(block, 0, Math.min(block.length, bytes - received + 1), null);
      if (!result.bytesRead) break;
      received += result.bytesRead;
      if (received > bytes) throw new Error('ZIP staged output changed.');
      hash.update(block.subarray(0, result.bytesRead));
    }
  } finally { await handle.close(); }
  const after = await ordinaryFile(file);
  if (!after || !sameFile(before, after) || received !== bytes || hash.digest('hex') !== expectedSha256) throw new Error('ZIP staged output differs from decoded bytes.');
  return after;
}
export async function extractZip(archivePath: string, destDir: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  if (options.stripComponents !== undefined && (!Number.isSafeInteger(options.stripComponents) || options.stripComponents < 0 || options.stripComponents > 1000)) throw new Error('Invalid ZIP strip count.');
  if (options.filterPrefix !== undefined) normalizedName(options.filterPrefix, true);
  const buffer = await archiveBuffer(archivePath);
  if (options.expectedSha256 !== undefined && (!/^[0-9a-f]{64}$/i.test(options.expectedSha256) ||
    crypto.createHash('sha256').update(buffer).digest('hex') !== options.expectedSha256.toLowerCase())) throw new Error('ZIP archive checksum mismatch.');
  const entries = readZipEntries(buffer), files: string[] = [], skipped: string[] = [], paths = new Map<string, boolean>();
  const plan: { entry: ZipEntry; target: string; stat?: Stats }[] = [];
  await ordinaryDirectory(destDir);
  // Every payload is decoded and CRC-checked before directories or files change.
  for (const entry of entries) decodeEntry(buffer, entry);
  for (const entry of entries) {
    let name = normalizedName(entry.name, entry.isDirectory);
    if (options.filterPrefix && !name.startsWith(normalizedName(options.filterPrefix, true))) { skipped.push(name); continue; }
    if (options.stripComponents) name = name.split('/').slice(options.stripComponents).join('/');
    if (!name) continue;
    const target = safeJoin(destDir, name), key = pathKey(name);
    if (paths.has(key)) throw new Error('Duplicate ZIP output paths after stripping.');
    paths.set(key, entry.isDirectory);
    if (entry.isDirectory) { await ordinaryDirectory(target); continue; }
    if (pathKey(path.resolve(target)) === pathKey(path.resolve(archivePath))) throw new Error('ZIP output cannot replace its source archive.');
    const stat = await ordinaryFile(target);
    plan.push({ entry, target, ...(stat ? { stat } : {}) }); files.push(path.relative(destDir, target));
  }
  noFileAncestors(paths);
  if (options.dryRun) return { files, skipped };
  for (const item of plan) {
    await ordinaryDirectory(path.dirname(item.target), true);
    const temporary = path.join(path.dirname(item.target), '.indiedeck-unzip-' + crypto.randomUUID() + '.tmp');
    try {
      const decoded = decodeEntry(buffer, item.entry), digest = crypto.createHash('sha256').update(decoded).digest('hex');
      const handle = await fsp.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(decoded); await handle.sync(); } finally { await handle.close(); }
      const staged = await checkedStage(temporary, decoded.length, digest);
      await ordinaryDirectory(path.dirname(item.target));
      const current = await ordinaryFile(item.target);
      if (item.stat ? !current || !sameFile(item.stat, current) : current !== undefined) throw new Error('ZIP destination changed during extraction.');
      const stagedAfter = await ordinaryFile(temporary);
      if (!stagedAfter || !sameFile(staged, stagedAfter)) throw new Error('ZIP staged output changed before publication.');
      await fsp.rename(temporary, item.target);
    } finally {
      try { if (await ordinaryDirectory(path.dirname(item.target))) await fsp.rm(temporary, { force: true }); } catch {}
    }
  }
  return { files, skipped };
}

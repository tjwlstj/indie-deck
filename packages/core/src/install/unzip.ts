import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureDir } from '../util/fsx.ts';

/**
 * A dependency-free ZIP reader.
 *
 * Everything IndieDeck downloads is a GitHub release archive or a BepInEx CI
 * artifact - all plain deflate/stored ZIPs - so a full archive library would be
 * dead weight and one more thing to keep patched. Zip64 archives are rejected
 * with a clear error rather than silently mis-parsed.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  offset: number;
  crc32: number;
}

function findEocd(buf: Buffer): number {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = 22; i <= max; i++) {
    const pos = buf.length - i;
    if (pos < 0) break;
    if (buf.readUInt32LE(pos) === EOCD_SIG) return pos;
  }
  return -1;
}

export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a ZIP archive (end-of-central-directory record not found).');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    throw new Error('Zip64 archives are not supported by the built-in extractor.');
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error(`Corrupt central directory at entry ${i}.`);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({
      name,
      isDirectory: name.endsWith('/') || name.endsWith('\\'),
      compressedSize,
      uncompressedSize,
      method,
      offset,
      crc32,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readEntryData(buf: Buffer, entry: ZipEntry): Buffer {
  if (buf.readUInt32LE(entry.offset) !== LFH_SIG) throw new Error(`Corrupt local header for ${entry.name}.`);
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}.`);
}

/** Rejects absolute paths and `..` traversal before anything touches disk. */
export function safeJoin(root: string, relative: string): string {
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(cleaned)) throw new Error(`Refusing to extract absolute path: ${relative}`);
  const target = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error(`Refusing to extract outside the target folder: ${relative}`);
  }
  return target;
}

export interface ExtractOptions {
  /** Drop this many leading path components (used for archives with a wrapper folder). */
  stripComponents?: number;
  /** Only extract entries whose path starts with this prefix. */
  filterPrefix?: string;
  dryRun?: boolean;
}

export interface ExtractResult {
  files: string[];
  skipped: string[];
}

export async function extractZip(
  archivePath: string,
  destDir: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const buf = await fsp.readFile(archivePath);
  const entries = readZipEntries(buf);
  const files: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    let name = entry.name.replace(/\\/g, '/');
    if (options.filterPrefix && !name.startsWith(options.filterPrefix)) {
      skipped.push(name);
      continue;
    }
    if (options.stripComponents) {
      const parts = name.split('/').slice(options.stripComponents);
      if (parts.length === 0) continue;
      name = parts.join('/');
    }
    if (!name || entry.isDirectory) continue;

    const target = safeJoin(destDir, name);
    if (options.dryRun) {
      files.push(path.relative(destDir, target));
      continue;
    }
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, readEntryData(buf, entry));
    files.push(path.relative(destDir, target));
  }

  return { files, skipped };
}


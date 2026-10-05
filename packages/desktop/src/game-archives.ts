import crypto from 'node:crypto';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { detectGame, type Registry, type GameProfile } from '@indiedeck/core';

export type GameArchiveFormat = 'zip' | '7z' | 'rar' | 'unknown';
export interface GameArchiveInspection {
  format: GameArchiveFormat;
  status: 'ready' | 'recognized' | 'invalid';
  canImport: boolean;
  archiveName: string;
  sizeBytes: number;
  sha256?: string;
  reasonKey?: string;
  fileCount?: number;
  unpackedBytes?: number;
  /** A filename guess, never a measured game or Unity engine version. */
  versionHint?: string;
  versionHintIsGuess: true;
}
export interface GameArchiveRecord {
  id: string;
  format: 'zip';
  archiveName: string;
  sourceSha256: string;
  label?: string;
  versionHint?: string;
  versionHintIsGuess: true;
  importedAt: string;
  root: string;
  gameRoot: string;
  engineId: string;
  title: string;
  gameName: string;
  executable?: string;
}
export interface GameArchiveProgress {
  phase: 'verify' | 'extract' | 'detect' | 'publish';
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}
export interface ImportGameArchiveOptions {
  dataDir: string;
  registry: Registry;
  label?: string;
  /** Bind an OS-picker candidate to its inspected content, not just its name. */
  expectedSha256?: string;
  onProgress?: (progress: GameArchiveProgress) => void;
}

// Classic ZIP only: ZIP64, split/encrypted archives and legacy name encodings
// are intentionally not accepted. This is bounded import, not a universal ZIP
// implementation. These limits also apply when central-directory claims lie.
const LIMITS = { archive: 0xffffffff, entries: 50000, unpacked: 32 * 1024 ** 3, entry: 0xfffffffe, central: 64 * 1024 ** 2 };
const RECORD = '.indiedeck-game-version.json';
const STAGE = '.indiedeck-stage.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
type Entry = { name: string; nameBytes: Buffer; directory: boolean; flags: number; method: number; crc: number; compressed: number; size: number; offset: number; start: number; end: number };
type ZipIndex = { entries: Entry[]; files: number; unpacked: number };
class ArchiveError extends Error {
  constructor(reason: string) { super(`ui.archives.reason.${reason}`); }
}
function fail(reason: string): never { throw new ArchiveError(reason); }
function displayName(input: string, max = 240): string { return input.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max); }
function versionHint(name: string): string | undefined {
  return /(?:^|[\s_\-[(])v?(\d+\.\d+(?:\.\d+){0,2}(?:[-_](?:alpha|beta|rc)\d*)?)(?=$|[\s_\-)\].])/i.exec(name)?.[1];
}
function relativeName(name: string, directory = false): string {
  if (name.length === 0 || name.length > 1024 || name.includes('\\') || /[\u0000-\u001f\u007f-\u009f:]/.test(name) || name.startsWith('/')) fail('unsafePath');
  const normal = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = normal.split('/');
  if (parts.length > 16) fail('limits');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part) ||
    /[<>"|?*]/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) fail('unsafePath');
  if (parts.some((part) => part.toLowerCase().startsWith('.indiedeck'))) fail('reservedMetadata');
  return normal;
}
function pathKey(name: string): string { return name.normalize('NFC').toUpperCase().toLowerCase(); }
async function ordinaryPath(target: string, kind: 'file' | 'directory', create = false): Promise<void> {
  if (!path.isAbsolute(target) || /^\\\\[?.]\\/.test(target) || target.includes('\0')) fail('unsafeSource');
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  const all = [root, ...absolute.slice(root.length).split(path.sep).filter(Boolean).map((part) => { current = path.join(current, part); return current; })];
  for (let i = 0; i < all.length; i += 1) {
    const final = i === all.length - 1;
    let stat;
    try { stat = await fsp.lstat(all[i]!); }
    catch (error) {
      if (create && (error as NodeJS.ErrnoException).code === 'ENOENT') { await fsp.mkdir(all[i]!); stat = await fsp.lstat(all[i]!); }
      else fail('unsafeSource');
    }
    if (stat.isSymbolicLink() || (final && kind === 'file' ? !stat.isFile() : !stat.isDirectory())) fail('unsafeSource');
  }
}
async function read(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const result = await handle.read(buffer, done, length - done, position + done);
    if (!result.bytesRead) fail('invalidZip');
    done += result.bytesRead;
  }
  return buffer;
}
function extraFields(bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) fail('invalidZip');
    const id = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2);
    if (id === 1) fail('zip64');
    if (offset + 4 + length > bytes.length) fail('invalidZip');
    // PKWARE UNIX variable data and ASi Unix link names must not disguise a
    // link as a regular file when external attributes omitted its file type.
    if (id === 0x000d && length > 12 || id === 0x756e && (length > 14 || length >= 6 &&
      ((bytes.readUInt16LE(offset + 8) & 0xf000) === 0xa000))) fail('linkedEntry');
    offset += 4 + length;
  }
}
function fileName(bytes: Buffer, flags: number, directory: boolean): string {
  if (!(flags & 0x800) && bytes.some((value) => value > 127)) fail('unsupportedEncoding');
  let name: string;
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('unsafePath'); }
  return relativeName(name, directory);
}
async function zipIndex(handle: FileHandle, archiveSize: number): Promise<ZipIndex> {
  if (archiveSize < 22) fail('invalidZip');
  const tailStart = Math.max(0, archiveSize - 65557);
  const tail = await read(handle, tailStart, archiveSize - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) fail('invalidZip');
  if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) || tail.readUInt16LE(eocd + 8) !== tail.readUInt16LE(eocd + 10)) fail('multipart');
  const count = tail.readUInt16LE(eocd + 10), centralSize = tail.readUInt32LE(eocd + 12), centralOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('zip64');
  if (count > LIMITS.entries || centralSize > LIMITS.central) fail('limits');
  if (centralOffset + centralSize !== tailStart + eocd) fail('invalidZip');
  const entries: Entry[] = [], names = new Map<string, { directory: boolean; name: string }>();
  let at = centralOffset, total = 0, files = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > centralOffset + centralSize) fail('invalidZip');
    const header = await read(handle, at, 46);
    if (header.readUInt32LE(0) !== 0x02014b50) fail('invalidZip');
    const flags = header.readUInt16LE(8), method = header.readUInt16LE(10);
    if (flags & (1 | 0x40 | 0x2000)) fail('encrypted');
    if (flags & ~0x80e || ![0, 8].includes(method) || (method === 0 && (flags & 6))) fail('unsupportedCompression');
    const compressed = header.readUInt32LE(20), size = header.readUInt32LE(24), offset = header.readUInt32LE(42);
    if ([compressed, size, offset].includes(0xffffffff)) fail('zip64');
    if (header.readUInt16LE(34)) fail('multipart');
    if (method === 8 && !compressed) fail('invalidZip');
    const nameLength = header.readUInt16LE(28), extraLength = header.readUInt16LE(30), commentLength = header.readUInt16LE(32);
    if (!nameLength || nameLength > 4096 || at + 46 + nameLength + extraLength + commentLength > centralOffset + centralSize) fail('invalidZip');
    const rawName = await read(handle, at + 46, nameLength);
    const directory = rawName[rawName.length - 1] === 47;
    const attributes = header.readUInt32LE(38), unixKind = (attributes >>> 16) & 0xf000;
    if (unixKind && unixKind !== (directory ? 0x4000 : 0x8000)) fail('linkedEntry');
    if (attributes & 0x400 || Boolean(attributes & 0x10) !== directory && (attributes & 0x10)) fail('linkedEntry');
    const name = fileName(rawName, flags, directory), key = pathKey(name);
    if (names.has(key)) fail('pathCollision');
    names.set(key, { directory, name });
    extraFields(await read(handle, at + 46 + nameLength, extraLength));
    if (size > LIMITS.entry || total + size > LIMITS.unpacked || (directory && (size || compressed)) || (method === 0 && compressed !== size)) fail('limits');
    const local = await read(handle, offset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method ||
      local.readUInt16LE(26) !== nameLength) fail('invalidZip');
    if (!(flags & 8) && (local.readUInt32LE(14) !== header.readUInt32LE(16) || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== size)) fail('invalidZip');
    const localExtraLength = local.readUInt16LE(28);
    if (offset + 30 + nameLength + localExtraLength + compressed > centralOffset) fail('invalidZip');
    if (!(await read(handle, offset + 30, nameLength)).equals(rawName)) fail('invalidZip');
    extraFields(await read(handle, offset + 30 + nameLength, localExtraLength));
    const start = offset + 30 + nameLength + localExtraLength;
    entries.push({ name, nameBytes: rawName, directory, flags, method, crc: header.readUInt32LE(16), compressed, size, offset, start, end: start + compressed });
    total += size;
    if (!directory) files += 1;
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== centralOffset + centralSize) fail('invalidZip');
  // Reject differently cased parents and file-versus-directory collisions,
  // including implicit directories that have no central-directory record.
  const parents = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join('/'), key = pathKey(parent);
      const explicit = names.get(key);
      if (explicit && (!explicit.directory || explicit.name !== parent) || parents.has(key) && parents.get(key) !== parent) fail('pathCollision');
      parents.set(key, parent);
    }
    if (parents.has(pathKey(entry.name)) && parents.get(pathKey(entry.name)) !== entry.name) fail('pathCollision');
  }
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i += 1) if (ordered[i]!.offset < ordered[i - 1]!.end) fail('invalidZip');
  return { entries, files, unpacked: total };
}
async function contentHash(handle: FileHandle, size: number): Promise<string> {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let at = 0;
  while (at < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - at), at);
    if (!bytesRead) fail('changedArchive');
    hash.update(buffer.subarray(0, bytesRead)); at += bytesRead;
  }
  if ((await handle.stat()).size !== size) fail('changedArchive');
  return hash.digest('hex');
}
function archiveFormat(signature: Buffer): GameArchiveFormat {
  if (signature.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  if (signature.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])) ||
    signature.subarray(0, 8).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))) return 'rar';
  if (signature.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(signature.readUInt32LE(0))) return 'zip';
  return 'unknown';
}
export async function inspectGameArchive(archivePath: string): Promise<GameArchiveInspection> {
  const name = displayName(path.basename(archivePath)), hint = versionHint(name);
  const result: GameArchiveInspection = { format: 'unknown', status: 'invalid', canImport: false, archiveName: name, sizeBytes: 0, versionHintIsGuess: true, ...(hint ? { versionHint: hint } : {}) };
  let handle: FileHandle | undefined;
  try {
    await ordinaryPath(archivePath, 'file');
    handle = await fsp.open(archivePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) fail('unsafeSource');
    result.sizeBytes = stat.size;
    if (stat.size > LIMITS.archive) fail('limits');
    const signature = await read(handle, 0, Math.min(8, stat.size));
    result.format = archiveFormat(signature);
    if (result.format === 'unknown') fail('unknownFormat');
    if (result.format !== 'zip') return { ...result, status: 'recognized', reasonKey: 'ui.archives.reason.extractionUnsupported' };
    const index = await zipIndex(handle, stat.size);
    result.fileCount = index.files; result.unpackedBytes = index.unpacked;
    result.sha256 = await contentHash(handle, stat.size);
    await ordinaryPath(archivePath, 'file');
    return { ...result, status: 'ready', canImport: true };
  } catch (error) {
    return { ...result, reasonKey: error instanceof ArchiveError ? error.message : 'ui.archives.reason.invalidZip' };
  } finally { await handle?.close(); }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
async function extractEntry(handle: FileHandle, entry: Entry, stage: string, onBytes: (count: number) => void): Promise<void> {
  const target = path.join(stage, ...entry.name.split('/'));
  await ordinaryPath(path.dirname(target), 'directory', true);
  if (entry.directory) { await ordinaryPath(target, 'directory', true); return; }
  const output = await fsp.open(target, 'wx');
  let written = 0, crc = 0xffffffff;
  const check = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    written += chunk.length;
    if (written > entry.size || written > LIMITS.entry) { callback(new ArchiveError('sizeMismatch')); return; }
    for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    onBytes(chunk.length); callback(null, chunk);
  } });
  try {
    if (entry.compressed) {
      // Own the handles separately from stream destruction: native fd streams
      // may close shared descriptors during pipeline error cleanup even when
      // autoClose:false. Reads and writes here are bounded and backpressured.
      const chunks = async function* (): AsyncGenerator<Buffer> {
        let at = entry.start;
        while (at < entry.end) {
          const chunk = await read(handle, at, Math.min(65536, entry.end - at));
          at += chunk.length; yield chunk;
        }
      };
      const input = Readable.from(chunks());
      const destination = new Writable({ write(chunk: Buffer, _encoding, callback) {
        const writeChunk = async (): Promise<void> => {
          let done = 0;
          while (done < chunk.length) {
            const { bytesWritten } = await output.write(chunk, done, chunk.length - done, null);
            if (!bytesWritten) fail('invalidZip');
            done += bytesWritten;
          }
        };
        void writeChunk().then(() => callback(), callback);
      } });
      if (entry.method === 8) await pipeline(input, createInflateRaw(), check, destination);
      else await pipeline(input, check, destination);
    }
    if (written !== entry.size) fail('sizeMismatch');
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('crcMismatch');
    await output.sync();
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    fail('invalidZip');
  } finally { await output.close(); }
}
function storage(dataDir: string): string { return path.join(path.resolve(dataDir), 'game-versions'); }
type StoredRecord = Omit<GameArchiveRecord, 'root' | 'gameRoot'> & { gameRelativePath: string; schemaVersion: 1 };
function validateStored(input: unknown, id: string, root: string): GameArchiveRecord | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as StoredRecord;
  if (value.schemaVersion !== 1 || value.id !== id || value.format !== 'zip' || !SHA256.test(value.sourceSha256) ||
    typeof value.archiveName !== 'string' || typeof value.importedAt !== 'string' || !Number.isFinite(Date.parse(value.importedAt)) ||
    typeof value.gameRelativePath !== 'string' || typeof value.engineId !== 'string' || typeof value.title !== 'string' || typeof value.gameName !== 'string' ||
    value.label !== undefined && (typeof value.label !== 'string' || value.label.length > 80)) return;
  let relative: string;
  try { relative = value.gameRelativePath === '' ? '' : relativeName(value.gameRelativePath); } catch { return; }
  return { id, format: 'zip', archiveName: displayName(value.archiveName), sourceSha256: value.sourceSha256,
    ...(value.label ? { label: displayName(value.label, 80) } : {}), ...(typeof value.versionHint === 'string' ? { versionHint: displayName(value.versionHint, 80) } : {}),
    versionHintIsGuess: true, importedAt: value.importedAt, root, gameRoot: path.join(root, ...relative.split('/').filter(Boolean)),
    engineId: displayName(value.engineId, 100), title: displayName(value.title), gameName: displayName(value.gameName),
    ...(typeof value.executable === 'string' ? { executable: displayName(value.executable, 1024) } : {}) };
}
/** Record paths are derived from UUID-owned folders, never trusted from JSON. */
export async function listGameArchives(dataDir: string): Promise<GameArchiveRecord[]> {
  const base = storage(dataDir);
  try { await ordinaryPath(base, 'directory'); } catch { return []; }
  const result: GameArchiveRecord[] = [];
  for (const id of await fsp.readdir(base)) {
    if (!UUID.test(id)) continue;
    const root = path.join(base, id), recordFile = path.join(root, RECORD);
    try {
      await ordinaryPath(root, 'directory'); await ordinaryPath(recordFile, 'file');
      if ((await fsp.stat(recordFile)).size > 65536) continue;
      const record = validateStored(JSON.parse(await fsp.readFile(recordFile, 'utf8')), id, root);
      if (!record) continue;
      await ordinaryPath(record.gameRoot, 'directory');
      if (!record.executable) continue;
      await ordinaryPath(path.join(record.gameRoot, ...relativeName(record.executable).split('/')), 'file');
      result.push(record);
    } catch { /* Invalid/unavailable local records do not become targets. */ }
  }
  return result.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}
async function removeOwnedStage(stage: string, base: string, nonce: string): Promise<void> {
  if (path.dirname(stage) !== base || path.basename(stage) !== `.staging-${nonce}`) return;
  try {
    await ordinaryPath(stage, 'directory'); await ordinaryPath(path.join(stage, STAGE), 'file');
    if (await fsp.readFile(path.join(stage, STAGE), 'utf8') !== nonce) return;
    // Never recursively remove a staged folder whose ancestry or contents were
    // replaced by a link after creation. Such tampering leaves a safe orphan.
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name), stat = await fsp.lstat(target);
        if (stat.isSymbolicLink()) fail('unsafeSource');
        if (stat.isDirectory()) await walk(target);
      }
    };
    await walk(stage); await fsp.rm(stage, { recursive: true, force: true });
  } catch { /* Cleanup does not broaden ownership when the stage is tampered. */ }
}
async function findImportedGames(registry: Registry, stage: string): Promise<GameProfile[]> {
  const games: GameProfile[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16) fail('limits');
    await ordinaryPath(directory, 'directory');
    const children = await fsp.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const stat = await fsp.lstat(path.join(directory, child.name));
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail('unsafeSource');
    }
    if (children.some((child) => child.isFile() && /\.exe$/i.test(child.name))) {
      const game = detectGame(registry, directory);
      if (game?.executable) games.push(game);
    }
    // Unlike library scanning, do not stop below a detected game: an archive
    // containing another game nested within it is still ambiguous.
    for (const child of children) if (child.isDirectory()) await walk(path.join(directory, child.name), depth + 1);
  };
  await walk(stage, 0); return games;
}
/** Extracts only into a fresh managed directory. Never executes, overwrites,
 * upgrades or deletes an existing game, source archive or imported version. */
export async function importGameArchive(archivePath: string, options: ImportGameArchiveOptions): Promise<{ record: GameArchiveRecord; duplicate: boolean }> {
  if (options.label !== undefined && (typeof options.label !== 'string' || options.label.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(options.label))) fail('invalidLabel');
  if (options.expectedSha256 !== undefined && !SHA256.test(options.expectedSha256)) fail('changedArchive');
  await ordinaryPath(archivePath, 'file');
  const handle = await fsp.open(archivePath, 'r');
  const base = storage(options.dataDir), nonce = crypto.randomUUID(), stage = path.join(base, `.staging-${nonce}`);
  let stageCreated = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMITS.archive) fail('limits');
    const format = archiveFormat(await read(handle, 0, Math.min(8, stat.size)));
    if (format !== 'zip') fail(format === 'unknown' ? 'unknownFormat' : 'extractionUnsupported');
    const index = await zipIndex(handle, stat.size);
    const progress: GameArchiveProgress = { phase: 'verify', filesDone: 0, filesTotal: index.files, bytesDone: 0, bytesTotal: index.unpacked };
    options.onProgress?.({ ...progress });
    const hash = await contentHash(handle, stat.size);
    if (options.expectedSha256 && hash !== options.expectedSha256) fail('changedArchive');
    const existing = (await listGameArchives(options.dataDir)).find((record) => record.sourceSha256 === hash);
    if (existing) return { record: existing, duplicate: true };
    await ordinaryPath(base, 'directory', true);
    await fsp.mkdir(stage); stageCreated = true;
    await fsp.writeFile(path.join(stage, STAGE), nonce, { flag: 'wx' });
    progress.phase = 'extract'; options.onProgress?.({ ...progress });
    for (const entry of index.entries) {
      await extractEntry(handle, entry, stage, (count) => { progress.bytesDone += count; options.onProgress?.({ ...progress }); });
      if (!entry.directory) progress.filesDone += 1;
      options.onProgress?.({ ...progress });
    }
    // Detect on static files only. A single real engine match is required;
    // multiple games and unknown/empty archives are not silently imported.
    progress.phase = 'detect'; options.onProgress?.({ ...progress });
    const games = await findImportedGames(options.registry, stage);
    if (games.length !== 1 || !games[0]?.executable) fail(games.length > 1 ? 'multipleGames' : 'noGame');
    // Rehash the same file handle after reading all entry data. A source changed
    // during extraction must never publish a partial or different version.
    if (await contentHash(handle, stat.size) !== hash) fail('changedArchive');
    await ordinaryPath(archivePath, 'file');
    const game = games[0], archiveName = displayName(path.basename(archivePath)), hint = versionHint(archiveName);
    const gameRelativePath = path.relative(stage, game.path).split(path.sep).join('/');
    const stored: StoredRecord = { schemaVersion: 1, id: nonce, format: 'zip', archiveName, sourceSha256: hash,
      ...(options.label?.trim() ? { label: options.label.trim() } : {}), ...(hint ? { versionHint: hint } : {}), versionHintIsGuess: true,
      importedAt: new Date().toISOString(), gameRelativePath, engineId: game.engineId,
      title: displayName(game.title ?? (gameRelativePath ? game.name : path.basename(archiveName, path.extname(archiveName)))),
      gameName: displayName(gameRelativePath ? game.name : path.basename(archiveName, path.extname(archiveName))), executable: game.executable };
    await fsp.writeFile(path.join(stage, RECORD), JSON.stringify(stored, null, 2), { flag: 'wx' });
    const destination = path.join(base, nonce);
    await ordinaryPath(base, 'directory'); await ordinaryPath(stage, 'directory');
    // UUID destination must be absent, even on the extremely unlikely collision.
    try { await fsp.lstat(destination); fail('pathCollision'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    progress.phase = 'publish'; options.onProgress?.({ ...progress });
    await fsp.rename(stage, destination); stageCreated = false;
    // The staging owner marker stays with the published folder; no post-publish
    // deletion/rollback can accidentally remove a now-visible game version.
    return { record: validateStored(stored, nonce, destination)!, duplicate: false };
  } finally {
    await handle.close();
    if (stageCreated) await removeOwnedStage(stage, base, nonce);
  }
}

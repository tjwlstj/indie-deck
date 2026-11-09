import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { imageMime, type Thumbnail } from './thumbnails.ts';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const writes = new Map<string, Promise<unknown>>();
type Stamp = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number };
const same = (a: Stamp, b: Stamp): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const sameDirectory = (a: Stamp, b: Stamp): boolean => a.dev === b.dev && a.ino === b.ino;

function locations(dataDir: string, gameId: string) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof gameId !== 'string' || !/^[0-9a-f]{16}$/.test(gameId)) throw new Error('Invalid manual thumbnail target.');
  const directory = path.join(path.resolve(dataDir), 'manual-thumbnails');
  return { directory, target: path.join(directory, `${gameId}.image`) };
}

/** Do not follow a linked source parent or a linked launcher-owned directory. */
async function ordinaryDirectory(directory: string, create = false): Promise<Stamp> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await fsp.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await fsp.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid manual thumbnail directory.');
  }
  const stat = await fsp.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid manual thumbnail directory.');
  return stat;
}

async function readImage(file: string): Promise<Buffer> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Invalid manual thumbnail file.');
  const parent = path.dirname(file), directory = await ordinaryDirectory(parent);
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > MAX_IMAGE_BYTES) throw new Error('Invalid manual thumbnail file.');
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !same(before, opened)) throw new Error('Manual thumbnail changed while reading.');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Manual thumbnail changed while reading.');
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1), end = await handle.read(extra, 0, 1, offset);
    const after = await handle.stat(), named = await fsp.lstat(file);
    if (end.bytesRead || !same(opened, after) || !same(after, named) || !named.isFile() || named.isSymbolicLink() ||
        !sameDirectory(directory, await ordinaryDirectory(parent))) throw new Error('Manual thumbnail changed while reading.');
    if (!imageMime(bytes)) throw new Error('Unsupported manual thumbnail image.');
    return bytes;
  } finally { await handle.close(); }
}

function result(bytes: Buffer): Thumbnail {
  const mime = imageMime(bytes);
  if (!mime) throw new Error('Unsupported manual thumbnail image.');
  return { source: 'manual', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
}

async function ordinaryTarget(target: string): Promise<void> {
  try {
    const stat = await fsp.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Invalid stored manual thumbnail.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function serial<T>(target: string, task: () => Promise<T>): Promise<T> {
  const previous = writes.get(target) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(task);
  writes.set(target, pending);
  void pending.finally(() => { if (writes.get(target) === pending) writes.delete(target); }).catch(() => {});
  return pending;
}

/** Copy validated image bytes to a fixed launcher-owned filename. No selected
 * source path or original filename is retained, and game files are never edited. */
export function importManualThumbnail(dataDir: string, gameId: string, sourcePath: string): Promise<Thumbnail> {
  const { directory, target } = locations(dataDir, gameId);
  return serial(target, async () => {
    const bytes = await readImage(sourcePath), thumbnail = result(bytes);
    const parent = await ordinaryDirectory(directory, true);
    await ordinaryTarget(target);
    const temporary = path.join(directory, `.${gameId}.${crypto.randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      created = true;
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      if (!sameDirectory(parent, await ordinaryDirectory(directory)) || !(await readImage(temporary)).equals(bytes)) throw new Error('Stored manual thumbnail changed.');
      await ordinaryTarget(target);
      await fsp.rename(temporary, target);
      created = false;
      return thumbnail;
    } finally {
      if (created && sameDirectory(parent, await ordinaryDirectory(directory))) await fsp.unlink(temporary).catch(() => {});
    }
  });
}

/** Missing or invalid saved images fall back to the game's other image sources.
 * Corrupt files are preserved so a read cannot silently alter user data. */
export async function readManualThumbnail(dataDir: string, gameId: string): Promise<Thumbnail | null> {
  const { target } = locations(dataDir, gameId);
  try { return result(await readImage(target)); }
  catch { return null; }
}

/** Clears only this game's ordinary, launcher-owned image; never the source. */
export function clearManualThumbnail(dataDir: string, gameId: string): Promise<void> {
  const { directory, target } = locations(dataDir, gameId);
  return serial(target, async () => {
    try { await ordinaryDirectory(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await ordinaryTarget(target);
    try { await fsp.unlink(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  });
}

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { defaultDataDir } from '@indiedeck/core';

export type LibrarySort = 'name-asc' | 'name-desc' | 'engine' | 'translated' | 'favorites' | 'duplicates';
export interface LibraryPreferences { sort: LibrarySort; favoritesOnly: boolean; duplicatesOnly: boolean; favorites: string[] }
const SORTS = new Set<LibrarySort>(['name-asc', 'name-desc', 'engine', 'translated', 'favorites', 'duplicates']);
const FILE = 'library-preferences.json';
const MAX_BYTES = 256 * 1024;
const MAX_FAVORITES = 10_000;
const queues = new Map<string, Promise<void>>();
const defaults = (): LibraryPreferences => ({ sort: 'name-asc', favoritesOnly: false, duplicatesOnly: false, favorites: [] });

/** Only bounded, non-authoritative presentation data is accepted from IPC. */
function validate(value: unknown): LibraryPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid library preferences.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !['sort', 'favoritesOnly', 'duplicatesOnly', 'favorites'].includes(key)) ||
    typeof v.sort !== 'string' || !SORTS.has(v.sort as LibrarySort) || typeof v.favoritesOnly !== 'boolean' ||
    typeof v.duplicatesOnly !== 'boolean' || !Array.isArray(v.favorites) || v.favorites.length > MAX_FAVORITES ||
    v.favorites.some((id) => typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) || new Set(v.favorites).size !== v.favorites.length) {
    throw new Error('Invalid library preferences.');
  }
  return { sort: v.sort as LibrarySort, favoritesOnly: v.favoritesOnly, duplicatesOnly: v.duplicatesOnly, favorites: [...v.favorites] as string[] };
}

async function ordinaryDirectory(directory: string, create: boolean): Promise<boolean> {
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  let current = root;
  const parts = [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean).map((part) => { current = path.join(current, part); return current; })];
  for (const part of parts) {
    let stat;
    try { stat = await fs.lstat(part); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fs.mkdir(part); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(part);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe library preferences directory.');
  }
  return true;
}
async function readFile(directory: string): Promise<LibraryPreferences> {
  if (!await ordinaryDirectory(directory, false)) return defaults();
  const file = path.join(directory, FILE);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults(); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Unsafe library preferences file.');
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !same(stat, opened)) throw new Error('Unsafe library preferences file.');
    const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || !same(opened, await handle.stat()) || !same(opened, await fs.lstat(file))) throw new Error('Unsafe library preferences file.');
    try { return validate(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))); }
    catch { throw new Error('Invalid library preferences file.'); }
  } finally { await handle.close(); }
}
function serialized<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory), previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(task);
  const done = result.then(() => {}, () => {});
  queues.set(key, done);
  void done.then(() => { if (queues.get(key) === done) queues.delete(key); });
  return result;
}

export function readLibraryPreferences(dataDir = defaultDataDir()): Promise<LibraryPreferences> {
  return serialized(dataDir, () => readFile(dataDir));
}
export function saveLibraryPreferences(input: unknown, dataDir = defaultDataDir()): Promise<LibraryPreferences> {
  const value = validate(input);
  return serialized(dataDir, async () => {
    await ordinaryDirectory(dataDir, true);
    // Never overwrite a damaged or linked existing preference file silently.
    await readFile(dataDir);
    const file = path.join(dataDir, FILE), temp = path.join(dataDir, `${FILE}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await ordinaryDirectory(dataDir, false);
      await readFile(dataDir);
      await fs.rename(temp, file);
    } finally {
      try { if (await ordinaryDirectory(dataDir, false)) await fs.rm(temp, { force: true }); } catch { /* Preserve unsafe paths. */ }
    }
    return value;
  });
}

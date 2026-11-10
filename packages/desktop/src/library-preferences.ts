import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { defaultDataDir } from '@indiedeck/core';

export type LibrarySort = 'name-asc' | 'name-desc' | 'engine' | 'translated' | 'favorites' | 'duplicates';
export type LibraryPreviewMode = 'off' | 'hover' | 'context';
export type LibraryAdultFilter = 'all' | 'exclude' | 'only' | 'unclassified';
export type LibraryPurchaseStore = 'steam' | 'epic' | 'gog' | 'itch' | 'booth' | 'dlsite' | 'dmm' | 'fanza' | 'other';
export type LibraryPurchaseFilter = 'all' | 'unassigned' | LibraryPurchaseStore;
export interface GameLibrarySettings { hideThumbnail: boolean; adult: 'unclassified' | 'general' | 'adult'; purchaseStores: LibraryPurchaseStore[] }
export interface LibraryPreferences {
  sort: LibrarySort; favoritesOnly: boolean; duplicatesOnly: boolean; favorites: string[];
  previewMode: LibraryPreviewMode; adultFilter: LibraryAdultFilter; purchaseFilter: LibraryPurchaseFilter;
  gameSettings: Record<string, GameLibrarySettings>;
}
const SORTS = new Set<LibrarySort>(['name-asc', 'name-desc', 'engine', 'translated', 'favorites', 'duplicates']);
const PREVIEW_MODES = new Set<LibraryPreviewMode>(['off', 'hover', 'context']);
const ADULT_FILTERS = new Set<LibraryAdultFilter>(['all', 'exclude', 'only', 'unclassified']);
const PURCHASE_STORES = new Set<LibraryPurchaseStore>(['steam', 'epic', 'gog', 'itch', 'booth', 'dlsite', 'dmm', 'fanza', 'other']);
const PURCHASE_FILTERS = new Set<string>(['all', 'unassigned', ...PURCHASE_STORES]);
const FILE = 'library-preferences.json';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FAVORITES = 10_000;
const MAX_GAME_SETTINGS = 5000;
const GAME_ID = /^[0-9a-f]{16}$/;
const queues = new Map<string, Promise<void>>();
export const defaultGameLibrarySettings = (): GameLibrarySettings => ({ hideThumbnail: false, adult: 'unclassified', purchaseStores: [] });
export const defaultLibraryPreferences = (): LibraryPreferences => ({
  sort: 'name-asc', favoritesOnly: false, duplicatesOnly: false, favorites: [],
  previewMode: 'hover', adultFilter: 'all', purchaseFilter: 'all', gameSettings: {},
});

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function invalid(): never { throw new Error('Invalid library preferences.'); }
function gameSettings(value: unknown): Record<string, GameLibrarySettings> {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).length > MAX_GAME_SETTINGS) invalid();
  const result: Record<string, GameLibrarySettings> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!GAME_ID.test(id) || !record(entry) || Object.keys(entry).some(key => !['hideThumbnail', 'adult', 'purchaseStores'].includes(key)) ||
      entry.hideThumbnail !== undefined && typeof entry.hideThumbnail !== 'boolean' ||
      entry.adult !== undefined && !['unclassified', 'general', 'adult'].includes(entry.adult as string) ||
      entry.purchaseStores !== undefined && (!Array.isArray(entry.purchaseStores) || entry.purchaseStores.length > PURCHASE_STORES.size ||
        entry.purchaseStores.some(store => typeof store !== 'string' || !PURCHASE_STORES.has(store as LibraryPurchaseStore)) ||
        new Set(entry.purchaseStores).size !== entry.purchaseStores.length)) invalid();
    result[id] = { hideThumbnail: entry.hideThumbnail === true,
      adult: (entry.adult ?? 'unclassified') as GameLibrarySettings['adult'],
      purchaseStores: [...(entry.purchaseStores ?? []) as LibraryPurchaseStore[]] };
  }
  return result;
}

/** Only bounded, non-authoritative presentation data is accepted from IPC. */
function validate(value: unknown): LibraryPreferences {
  if (!record(value)) invalid();
  const v = value;
  if (Object.keys(v).some((key) => !['sort', 'favoritesOnly', 'duplicatesOnly', 'favorites', 'previewMode', 'adultFilter', 'purchaseFilter', 'gameSettings'].includes(key)) ||
    typeof v.sort !== 'string' || !SORTS.has(v.sort as LibrarySort) || typeof v.favoritesOnly !== 'boolean' ||
    typeof v.duplicatesOnly !== 'boolean' || !Array.isArray(v.favorites) || v.favorites.length > MAX_FAVORITES ||
    v.favorites.some((id) => typeof id !== 'string' || !GAME_ID.test(id)) || new Set(v.favorites).size !== v.favorites.length ||
    v.previewMode !== undefined && !PREVIEW_MODES.has(v.previewMode as LibraryPreviewMode) ||
    v.adultFilter !== undefined && !ADULT_FILTERS.has(v.adultFilter as LibraryAdultFilter) ||
    v.purchaseFilter !== undefined && !PURCHASE_FILTERS.has(v.purchaseFilter as string)) {
    invalid();
  }
  return { sort: v.sort as LibrarySort, favoritesOnly: v.favoritesOnly, duplicatesOnly: v.duplicatesOnly, favorites: [...v.favorites] as string[],
    previewMode: (v.previewMode ?? 'hover') as LibraryPreviewMode,
    adultFilter: (v.adultFilter ?? 'all') as LibraryAdultFilter,
    purchaseFilter: (v.purchaseFilter ?? 'all') as LibraryPurchaseFilter,
    gameSettings: gameSettings(v.gameSettings) };
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
  if (!await ordinaryDirectory(directory, false)) return defaultLibraryPreferences();
  const file = path.join(directory, FILE);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultLibraryPreferences(); throw error; }
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
  const text = JSON.stringify(value, null, 2);
  // Check the bytes before mkdir, temporary writes or replacing an existing
  // preference file. Large presentation payloads cannot damage saved settings.
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) invalid();
  return serialized(dataDir, async () => {
    await ordinaryDirectory(dataDir, true);
    // Never overwrite a damaged or linked existing preference file silently.
    await readFile(dataDir);
    const file = path.join(dataDir, FILE), temp = path.join(dataDir, `${FILE}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await ordinaryDirectory(dataDir, false);
      await readFile(dataDir);
      await fs.rename(temp, file);
    } finally {
      try { if (await ordinaryDirectory(dataDir, false)) await fs.rm(temp, { force: true }); } catch { /* Preserve unsafe paths. */ }
    }
    return value;
  });
}

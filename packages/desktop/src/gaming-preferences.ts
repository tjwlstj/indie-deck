import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface GamingPreferences { minimizeOnLaunch: boolean; restoreOnExit: boolean }
export const DEFAULT_GAMING_PREFERENCES: GamingPreferences = { minimizeOnLaunch: true, restoreOnExit: false };

export function gamingPreferences(value: unknown): GamingPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid gaming preferences.');
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some(key => !['minimizeOnLaunch', 'restoreOnExit'].includes(key)) ||
      typeof entry.minimizeOnLaunch !== 'boolean' || typeof entry.restoreOnExit !== 'boolean') throw new Error('Invalid gaming preferences.');
  return { minimizeOnLaunch: entry.minimizeOnLaunch, restoreOnExit: entry.restoreOnExit };
}

async function directory(dataDir: string) {
  if (!path.isAbsolute(dataDir)) throw new Error('Invalid gaming preferences directory.');
  let current = path.parse(dataDir).root;
  for (const part of path.resolve(dataDir).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid gaming preferences directory.');
  }
}

export async function readGamingPreferences(dataDir: string): Promise<GamingPreferences> {
  await directory(dataDir);
  const file = path.join(dataDir, 'gaming-preferences.json');
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_GAMING_PREFERENCES }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid gaming preferences file.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 4096) throw new Error('Gaming preferences changed.');
    const bytes = Buffer.alloc(4097); let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (size > 4096 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('Gaming preferences changed.');
    return gamingPreferences(JSON.parse(bytes.subarray(0, size).toString('utf8')));
  } finally { await handle.close(); }
}

export async function saveGamingPreferences(dataDir: string, input: unknown): Promise<GamingPreferences> {
  const value = gamingPreferences(input);
  // A corrupt existing file is preserved for recovery rather than overwritten.
  await readGamingPreferences(dataDir);
  const temporary = path.join(dataDir, `.gaming-preferences.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await directory(dataDir);
    await fs.rename(temporary, path.join(dataDir, 'gaming-preferences.json'));
  } finally { await fs.rm(temporary, { force: true }); }
  return value;
}

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isGameExecutableName } from '@indiedeck/core';
import { inspectLaunchTarget, relativeExecutable } from './launch-target-guard.ts';

export interface GamingPreferences { minimizeOnLaunch: boolean; restoreOnExit: boolean }
export const DEFAULT_GAMING_PREFERENCES: GamingPreferences = { minimizeOnLaunch: true, restoreOnExit: false };

export function gamingPreferences(value: unknown): GamingPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid gaming preferences.');
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some(key => !['minimizeOnLaunch', 'restoreOnExit'].includes(key)) ||
      typeof entry.minimizeOnLaunch !== 'boolean' || typeof entry.restoreOnExit !== 'boolean') throw new Error('Invalid gaming preferences.');
  return { minimizeOnLaunch: entry.minimizeOnLaunch, restoreOnExit: entry.restoreOnExit };
}

async function directory(dataDir: string, create: boolean) {
  if (!path.isAbsolute(dataDir)) throw new Error('Invalid gaming preferences directory.');
  let current = path.parse(dataDir).root;
  for (const part of path.resolve(dataDir).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fs.mkdir(current); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid gaming preferences directory.');
  }
  return true;
}

async function readJson(file: string, limit: number): Promise<unknown> {
  if (!await directory(path.dirname(file), false)) return undefined;
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error('Invalid gaming preferences file.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error('Gaming preferences changed.');
    const bytes = Buffer.alloc(opened.size + 1); let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (size !== opened.size || after.size !== opened.size || after.ctimeMs !== opened.ctimeMs || after.mtimeMs !== opened.mtimeMs) throw new Error('Gaming preferences changed.');
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } finally { await handle.close(); }
}

async function writeJson(file: string, value: unknown) {
  const parent = path.dirname(file);
  await directory(parent, true);
  const temporary = path.join(parent, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    if (!await directory(parent, false)) throw new Error('Gaming preferences directory changed.');
    await fs.rename(temporary, file);
  } finally {
    if (await directory(parent, false)) await fs.rm(temporary, { force: true });
  }
}

export async function readGamingPreferences(dataDir: string): Promise<GamingPreferences> {
  const value = await readJson(path.join(dataDir, 'gaming-preferences.json'), 4096);
  return value === undefined ? { ...DEFAULT_GAMING_PREFERENCES } : gamingPreferences(value);
}

export async function saveGamingPreferences(dataDir: string, input: unknown): Promise<GamingPreferences> {
  const value = gamingPreferences(input);
  // A corrupt existing file is preserved for recovery rather than overwritten.
  await readGamingPreferences(dataDir);
  await writeJson(path.join(dataDir, 'gaming-preferences.json'), value);
  return value;
}

function choiceFile(dataDir: string, gameId: string): string {
  if (!/^[0-9a-f]{16}$/.test(gameId)) throw new Error('ui.gaming.error.invalidArguments');
  return path.join(dataDir, 'launch-choices', gameId + '.json');
}

function checkedExecutable(value: unknown): string {
  const relative = relativeExecutable(value);
  if (!isGameExecutableName(path.basename(relative)) || relative.split(path.sep).some(part => part.toLowerCase() === '.indiedeck')) {
    throw new Error('ui.gaming.error.invalidExecutableChoice');
  }
  return relative;
}

export async function readLaunchChoice(dataDir: string, gameId: string): Promise<string | null> {
  const file = choiceFile(dataDir, gameId);
  try {
    const value = await readJson(file, 256 * 1024);
    return value === undefined ? null : checkedExecutable(value);
  } catch { throw new Error('ui.gaming.error.unreadableExecutableChoice'); }
}

export async function resolveGameLaunchTarget(dataDir: string, gameId: string, gameRoot: string, detected?: string) {
  const choice = await readLaunchChoice(dataDir, gameId);
  const executable = choice ?? detected;
  if (!executable) throw new Error('ui.gaming.error.unsafeLaunchTarget');
  try { return await inspectLaunchTarget(gameRoot, executable); }
  catch (error) {
    if (choice && error instanceof Error && error.message === 'ui.gaming.error.unsafeLaunchTarget') {
      throw new Error('ui.gaming.error.chosenExecutableUnavailable');
    }
    throw error;
  }
}

/** `selected` comes from a main-process native picker. Persist only its admitted relative name. */
export async function saveLaunchChoice(dataDir: string, gameId: string, gameRoot: string, selected: string): Promise<string> {
  if (!path.isAbsolute(selected)) throw new Error('ui.gaming.error.invalidExecutableChoice');
  const relative = checkedExecutable(path.relative(gameRoot, selected));
  await inspectLaunchTarget(gameRoot, relative);
  await readLaunchChoice(dataDir, gameId);
  await writeJson(choiceFile(dataDir, gameId), relative);
  return relative;
}

export async function clearLaunchChoice(dataDir: string, gameId: string): Promise<void> {
  const file = choiceFile(dataDir, gameId);
  if (!await directory(path.dirname(file), false)) return;
  // Explicit reset also recovers a malformed choice without following links.
  const stat = await fs.lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('ui.gaming.error.unreadableExecutableChoice');
  await fs.unlink(file);
}

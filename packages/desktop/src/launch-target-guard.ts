import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

type Identity = { dev: number; ino: number };
type FileIdentity = Identity & { size: number; mtimeMs: number; ctimeMs: number; nlink: number; mode: number };
type DirectoryIdentity = Identity & { path: string };

/** Main-only admission evidence. Do not send local paths or file identities to
 * the renderer. Revalidate after asynchronous scans and immediately before spawn. */
export interface LaunchTargetInspection {
  cwd: string;
  executable: string;
  relativeExecutable: string;
  readonly file: FileIdentity;
  readonly directories: readonly DirectoryIdentity[];
  readonly realRoot: string;
  readonly realExecutable: string;
}

const unsafe = (): never => { throw new Error('ui.gaming.error.unsafeLaunchTarget'); };
const changed = (): never => { throw new Error('ui.gaming.error.launchTargetChanged'); };
const directoryEqual = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const fileEqual = (a: FileIdentity, b: FileIdentity) => directoryEqual(a, b) && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink && a.mode === b.mode;
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

function relativeExecutable(value: unknown): string {
  if (typeof value !== 'string' || value.length < 5 || value.length > 32767 || /[\u0000-\u001f\u007f]/u.test(value)) return unsafe();
  const relative = value.replace(/\\/g, '/');
  const parts = relative.split('/');
  if (!/\.exe$/i.test(relative) || relative.startsWith('/') || /^[a-z]:/i.test(relative) ||
      parts.some(part => !part || part === '.' || part === '..' || /[:]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) unsafe();
  return parts.join(path.sep);
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(key(root), key(target));
  return Boolean(relative) && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function directoriesTo(directory: string): Promise<DirectoryIdentity[]> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  const paths = [root, ...absolute.slice(root.length).split(path.sep).filter(Boolean).map(part => { current = path.join(current, part); return current; })];
  const entries: DirectoryIdentity[] = [];
  for (const directory of paths) {
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
    entries.push({ path: directory, dev: stat.dev, ino: stat.ino });
  }
  return entries;
}

async function snapshot(gameRoot: string, relative: string): Promise<LaunchTargetInspection> {
  const cwd = path.resolve(gameRoot), executable = path.join(cwd, relative);
  if (!contained(cwd, executable)) unsafe();
  const directories = await directoriesTo(path.dirname(executable));
  const before = await fsp.lstat(executable);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0) unsafe();
  const handle = await fsp.open(executable, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !fileEqual(before, opened)) changed();
    const realRoot = await fsp.realpath(cwd), realExecutable = await fsp.realpath(executable);
    if (!contained(realRoot, realExecutable)) unsafe();
    const after = await fsp.lstat(executable), final = await handle.stat();
    if (!after.isFile() || after.isSymbolicLink() || !fileEqual(opened, final) || !fileEqual(final, after)) changed();
    for (const directory of directories) {
      const now = await fsp.lstat(directory.path);
      if (!now.isDirectory() || now.isSymbolicLink() || !directoryEqual(directory, now)) changed();
    }
    const file: FileIdentity = { dev: final.dev, ino: final.ino, size: final.size, mtimeMs: final.mtimeMs,
      ctimeMs: final.ctimeMs, nlink: final.nlink, mode: final.mode };
    return { cwd, executable, relativeExecutable: relative, file, directories, realRoot, realExecutable };
  } finally { await handle.close(); }
}

function validatedRoot(gameRoot: unknown): string {
  if (typeof gameRoot !== 'string' || !path.isAbsolute(gameRoot) || gameRoot.length > 32767 ||
      /[\u0000-\u001f\u007f]/u.test(gameRoot) || /^\\\\[?.]\\/.test(gameRoot)) return unsafe();
  return path.resolve(gameRoot);
}

/** Check directory ancestry before detection reads any markers. Detection must
 * still use rejectLinks:true for files/directories below this admitted root. */
export async function inspectLaunchDirectory(gameRoot: unknown): Promise<void> {
  const root = validatedRoot(gameRoot);
  try { await directoriesTo(root); }
  catch { unsafe(); }
}

/** Admission is independent of the optional antivirus scan. It rejects linked
 * directories/files and confines the detected Windows executable to its game. */
export async function inspectLaunchTarget(gameRoot: unknown, executable: unknown): Promise<LaunchTargetInspection> {
  const root = validatedRoot(gameRoot);
  const relative = relativeExecutable(executable);
  try { return await snapshot(root, relative); }
  catch (error) {
    if (error instanceof Error && /^ui\.gaming\.error\./.test(error.message)) throw error;
    return unsafe();
  }
}

/** Narrows the scan-to-spawn race by comparing the same file and ancestor
 * identities. Node's path-based spawn cannot make the final check and execution
 * atomic against an attacker with concurrent write access to the game folder. */
export async function revalidateLaunchTarget(inspection: LaunchTargetInspection): Promise<void> {
  try {
    const current = await snapshot(inspection.cwd, inspection.relativeExecutable);
    if (key(current.realRoot) !== key(inspection.realRoot) || key(current.realExecutable) !== key(inspection.realExecutable) ||
        !fileEqual(inspection.file, current.file) || current.directories.length !== inspection.directories.length ||
        current.directories.some((directory, index) => key(directory.path) !== key(inspection.directories[index]!.path) ||
          !directoryEqual(directory, inspection.directories[index]!))) changed();
  } catch { changed(); }
}

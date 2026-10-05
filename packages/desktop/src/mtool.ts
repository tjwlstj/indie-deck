import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GameProfile } from '@indiedeck/core';

export interface MToolStatus {
  status: 'ready' | 'missing' | 'disabled' | 'invalid';
  source: 'default' | 'configured' | 'disabled';
  root?: string;
  executable?: string;
  toolDirectory?: string;
  reasonKey?: string;
  reason?: string;
}

export interface MToolProbeOptions {
  /** Test seam only. Production uses the host platform and fixed default. */
  platform?: NodeJS.Platform;
  defaultRoot?: string;
}

type FileKind = 'file' | 'directory';
type ProbeFailure = 'missing' | 'linkedPath' | 'invalidRoot' | 'invalidPackage' | 'invalidExecutable';

class MToolPathError extends Error {
  readonly reason: ProbeFailure;
  constructor(reason: ProbeFailure) {
    super(`ui.mtool.reason.${reason}`);
    this.reason = reason;
  }
}

/** Check the whole ancestry, not just the final path: junctions can redirect
 * an apparently local bundle or a game executable outside its named folder. */
async function ordinaryPath(target: string, kind: FileKind): Promise<void> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  const paths = [root, ...parts.map((part) => { current = path.join(current, part); return current; })];
  for (let index = 0; index < paths.length; index += 1) {
    let stat;
    try { stat = await fsp.lstat(paths[index]!); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MToolPathError('missing');
      throw new MToolPathError('invalidRoot');
    }
    if (stat.isSymbolicLink()) throw new MToolPathError('linkedPath');
    const final = index === paths.length - 1;
    if (final ? !(kind === 'file' ? stat.isFile() : stat.isDirectory()) : !stat.isDirectory()) {
      throw new MToolPathError(kind === 'file' ? 'invalidExecutable' : 'invalidRoot');
    }
  }
}

/** A PE header proves file format only, not publisher authenticity or safety. */
async function ordinaryPE(target: string): Promise<void> {
  await ordinaryPath(target, 'file');
  const handle = await fsp.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new MToolPathError('invalidExecutable');
    const bytes = Buffer.alloc(Math.min(stat.size, 65536));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new MToolPathError('invalidExecutable');
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset + 6 > bytesRead || bytes.readUInt32LE(peOffset) !== 0x4550 ||
      ![0x014c, 0x8664, 0xaa64].includes(bytes.readUInt16LE(peOffset + 4))) {
      throw new MToolPathError('invalidExecutable');
    }
  } finally { await handle.close(); }
  await ordinaryPath(target, 'file');
}

async function verifyPackage(toolDirectory: string): Promise<void> {
  const packageFile = path.join(toolDirectory, 'package.json');
  try {
    await ordinaryPath(packageFile, 'file');
    await ordinaryPath(path.join(toolDirectory, 'www', 'index.html'), 'file');
    const stat = await fsp.stat(packageFile);
    if (stat.size > 65536) throw new MToolPathError('invalidPackage');
    // Read only the public application manifest, never gameLib, configs or keys.
    const manifest: unknown = JSON.parse(await fsp.readFile(packageFile, 'utf8'));
    if (!manifest || typeof manifest !== 'object' ||
      typeof (manifest as { name?: unknown }).name !== 'string' ||
      !/^MToolClient(?:[_-].*)?$/i.test((manifest as { name: string }).name) ||
      (manifest as { main?: unknown }).main !== 'www/index.html') throw new MToolPathError('invalidPackage');
  } catch (error) {
    if (error instanceof MToolPathError && error.reason === 'linkedPath') throw error;
    throw new MToolPathError('invalidPackage');
  }
}

function problem(source: MToolStatus['source'], root: string | undefined, reason: string, status: MToolStatus['status'] = 'invalid'): MToolStatus {
  return { status, source, ...(root ? { root } : {}), reasonKey: `ui.mtool.reason.${reason}` };
}

/** Accept a bundle parent (D:\MTool) or its Tool folder. No recursive search,
 * batch file, shell, NW.js fallback or renderer-supplied executable is used. */
export async function getMToolStatus(root: string | null | undefined, options: MToolProbeOptions = {}): Promise<MToolStatus> {
  if (root === null) return problem('disabled', undefined, 'disabled', 'disabled');
  const source = root === undefined ? 'default' : 'configured';
  if ((options.platform ?? process.platform) !== 'win32') return problem(source, undefined, 'unsupportedPlatform');
  const candidate = root ?? options.defaultRoot ?? 'D:\\MTool';
  if (typeof candidate !== 'string' || !candidate || candidate.length > 32768 || candidate.includes('\0') ||
    !path.isAbsolute(candidate) || /^\\\\[?.]\\/.test(candidate)) return problem(source, undefined, 'invalidRoot');
  const resolved = path.resolve(candidate);
  try { await ordinaryPath(resolved, 'directory'); }
  catch (error) {
    const reason = error instanceof MToolPathError ? error.reason : 'invalidRoot';
    return problem(source, resolved, reason === 'missing' ? 'notFound' : reason, reason === 'missing' ? 'missing' : 'invalid');
  }
  // Prefer the known bundle layout. If a present candidate is invalid, do not
  // silently fall through to a different executable with the same name.
  for (const toolDirectory of [path.join(resolved, 'Tool'), resolved]) {
    const executable = path.join(toolDirectory, 'MTool.exe');
    try { await ordinaryPath(executable, 'file'); }
    catch (error) {
      if (error instanceof MToolPathError && error.reason === 'missing') continue;
      return problem(source, resolved, error instanceof MToolPathError ? error.reason : 'invalidExecutable');
    }
    try {
      await verifyPackage(toolDirectory);
      await ordinaryPE(executable);
      return { status: 'ready', source, root: resolved, executable, toolDirectory };
    } catch (error) {
      return problem(source, resolved, error instanceof MToolPathError ? error.reason : 'invalidExecutable');
    }
  }
  return problem(source, resolved, 'notFound', 'missing');
}

export function isMToolGame(profile: Pick<GameProfile, 'engineId'>): boolean {
  return ['rpgmaker-mv', 'rpgmaker-mz', 'rpgmaker-rgss'].includes(profile.engineId);
}

/** Profile paths must be main-owned detection results, never renderer input. */
export async function getMToolGameExecutable(profile: GameProfile): Promise<string> {
  if (!isMToolGame(profile)) throw new Error('ui.mtool.reason.unsupportedGame');
  const executable = profile.executable;
  if (!path.isAbsolute(profile.path) || !executable || path.isAbsolute(executable) ||
    !/\.exe$/i.test(executable) || /[\0:]/.test(executable) ||
    executable.replace(/\\/g, '/').split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('ui.mtool.reason.invalidGameExecutable');
  }
  const root = path.resolve(profile.path);
  const target = path.resolve(root, executable);
  if (!target.toLowerCase().startsWith((root + path.sep).toLowerCase())) throw new Error('ui.mtool.reason.invalidGameExecutable');
  try {
    await ordinaryPath(root, 'directory');
    await ordinaryPE(target);
    return target;
  } catch (error) {
    if (error instanceof MToolPathError && error.reason === 'linkedPath') throw new Error('ui.mtool.reason.linkedPath');
    throw new Error('ui.mtool.reason.invalidGameExecutable');
  }
}

export async function mtoolLaunchSpec(status: MToolStatus, profile?: GameProfile): Promise<{ executable: string; args: string[]; cwd: string }> {
  if (status.status !== 'ready' || !status.root || !status.executable || !status.toolDirectory) {
    throw new Error(status.reasonKey ?? 'ui.mtool.reason.notFound');
  }
  const fresh = await getMToolStatus(status.root);
  if (fresh.status !== 'ready' || !fresh.executable || !fresh.toolDirectory ||
    fresh.executable !== status.executable || fresh.toolDirectory !== status.toolDirectory) {
    throw new Error(fresh.reasonKey ?? 'ui.mtool.reason.invalidExecutable');
  }
  // An argument-array handoff is documented upstream. It is not proof that a
  // particular game is translated, and IndieDeck never claims auto-application.
  const args = profile ? [await getMToolGameExecutable(profile)] : [];
  return { executable: fresh.executable, args, cwd: fresh.toolDirectory };
}

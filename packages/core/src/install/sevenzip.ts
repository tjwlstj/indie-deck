import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, pathExists } from '../util/fsx.ts';

/**
 * 7-Zip support without shipping a 7z decoder.
 *
 * The TMP font bundles are published as a .7z, so the built-in ZIP reader
 * cannot touch them. Rather than add a native dependency, IndieDeck borrows an
 * extractor that is already on the machine - in practice Windows 10+ always has
 * bsdtar at System32\tar.exe, which reads 7-Zip through libarchive.
 */

export interface Extractor {
  kind: '7z' | 'bsdtar';
  command: string;
  args: (archive: string, dest: string) => string[];
}

function run(command: string, args: string[], cwd?: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
  });
}

async function works(command: string, args: string[]): Promise<boolean> {
  const { code } = await run(command, args);
  return code === 0;
}

let cached: Extractor | null | undefined;

/** Finds a usable 7z extractor once per process. */
export async function find7zExtractor(): Promise<Extractor | undefined> {
  if (cached !== undefined) return cached ?? undefined;

  const candidates: Extractor[] = [
    { kind: '7z', command: '7z', args: (a, d) => ['x', '-y', `-o${d}`, a] },
    { kind: '7z', command: '7za', args: (a, d) => ['x', '-y', `-o${d}`, a] },
  ];
  if (process.platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
    candidates.push({
      kind: 'bsdtar',
      command: path.join(systemRoot, 'System32', 'tar.exe'),
      args: (a, d) => ['-x', '-f', a, '-C', d],
    });
  }
  candidates.push({ kind: 'bsdtar', command: 'bsdtar', args: (a, d) => ['-x', '-f', a, '-C', d] });

  for (const candidate of candidates) {
    // GNU tar is also called `tar` and cannot read 7z, so the probe checks for
    // the libarchive banner rather than merely for a working binary.
    if (candidate.kind === 'bsdtar') {
      const { code, stderr } = await run(candidate.command, ['--version']);
      if (code !== 0) continue;
      const version = await new Promise<string>((resolve) => {
        const child = spawn(candidate.command, ['--version'], { windowsHide: true });
        let outText = '';
        child.stdout?.on('data', (c) => {
          outText += String(c);
        });
        child.on('close', () => resolve(outText || stderr));
        child.on('error', () => resolve(''));
      });
      if (!/bsdtar|libarchive/i.test(version)) continue;
      cached = candidate;
      return candidate;
    }
    if (await works(candidate.command, ['--help'])) {
      cached = candidate;
      return candidate;
    }
  }

  cached = null;
  return undefined;
}

export interface SevenZipResult {
  dir: string;
  extractor: Extractor['kind'];
  fromCache: boolean;
}

/**
 * Extracts a .7z into a cache directory keyed by the archive name, so the
 * 128 MB font archive is unpacked once and reused by every later install.
 */
export async function extract7z(archivePath: string, cacheDir: string): Promise<SevenZipResult> {
  const dest = path.join(cacheDir, 'extracted', path.basename(archivePath).replace(/\.[^.]+$/, ''));
  const marker = path.join(dest, '.indiedeck-extracted');

  if (await pathExists(marker)) {
    const extractor = (await fsp.readFile(marker, 'utf8')).trim();
    return { dir: dest, extractor: (extractor as Extractor['kind']) || '7z', fromCache: true };
  }

  const extractor = await find7zExtractor();
  if (!extractor) {
    throw new Error(
      `No 7-Zip capable extractor found. Install 7-Zip (or use Windows' built-in tar), then re-run. Archive: ${archivePath}`,
    );
  }

  await ensureDir(dest);
  const { code, stderr } = await run(extractor.command, extractor.args(archivePath, dest), os.tmpdir());
  if (code !== 0) throw new Error(`${extractor.command} failed to extract ${path.basename(archivePath)}: ${stderr.trim() || `exit ${code}`}`);

  await fsp.writeFile(marker, extractor.kind, 'utf8');
  return { dir: dest, extractor: extractor.kind, fromCache: false };
}

/** Case-insensitive lookup of one entry inside an extracted archive. */
export async function findExtractedEntry(dir: string, name: string): Promise<string | undefined> {
  const wanted = name.toLowerCase();
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.name.toLowerCase() === wanted) return full;
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return undefined;
}

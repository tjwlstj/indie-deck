import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { MAX_ASSET_BYTES } from './network-policy.ts';

export const MAX_SEVENZIP_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_ENTRIES = 5000;
const MARKER = '.indiedeck-extracted.json';
export interface Extractor {
  kind: '7z' | 'bsdtar';
  command: string;
  /** Selected entry is emitted to stdout, never extracted to archive paths. */
  args: (archive: string, selectedEntry: string) => string[];
}
export interface SevenZipResult { dir: string; extractor: Extractor['kind']; fromCache: boolean; sha256: string; bytes: number }
interface Seal { archiveSha256: string; entry: string; fileSha256: string; bytes: number; extractor: Extractor['kind'] }
const seals = new Map<string, Seal>();
const queues = new Map<string, Promise<unknown>>();

async function ordinaryDirectory(target: string, create = false): Promise<boolean> {
  if (target.includes('\0') || /^\\\\[?.]\\/.test(target)) throw new Error('Unsafe font extraction path.');
  const resolved = path.resolve(target), root = path.parse(resolved).root;
  let current = root;
  const parts = [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean).map((part) => { current = path.join(current, part); return current; })];
  for (const part of parts) {
    let stat: Stats;
    try { stat = await fsp.lstat(part); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fsp.mkdir(part); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await fsp.lstat(part);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked font extraction paths are not accepted.');
  }
  return true;
}
async function ordinaryFile(file: string, maximum: number): Promise<Stats | undefined> {
  if (!await ordinaryDirectory(path.dirname(file))) return undefined;
  let stat: Stats;
  try { stat = await fsp.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw new Error('Unsafe font extraction file.');
  return stat;
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function fingerprint(file: string, maximum: number): Promise<{ sha256: string; bytes: number; stat: Stats }> {
  const before = await ordinaryFile(file, maximum);
  if (!before) throw new Error('Font extraction input is missing.');
  const handle = await fsp.open(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  let bytes = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, before)) throw new Error('Font extraction input changed.');
    for (;;) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, maximum - bytes + 1), null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > maximum) throw new Error('Font extraction byte limit exceeded.');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
  } finally { await handle.close(); }
  const after = await ordinaryFile(file, maximum);
  if (!after || !sameFile(before, after) || bytes !== after.size) throw new Error('Font extraction input changed.');
  return { sha256: hash.digest('hex'), bytes, stat: after };
}
function safeName(name: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(name) || /[.]$/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(name)) throw new Error('Select a safe font entry basename.');
  return name;
}
function safeEntry(value: string): string | undefined {
  if (/^(?:\.\/)+$/.test(value) || value === '.') return undefined;
  const original = value.replace(/\/$/, ''), normalized = original.replace(/^(?:\.\/)+/, '');
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f\\:*?[\]<>|]/.test(normalized) ||
    path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('-'))) {
    throw new Error('Unsafe archive entry path.');
  }
  return original;
}
function protectedCandidates(): Extractor[] {
  if (process.platform === 'win32') return [{
    kind: 'bsdtar', command: 'C:\\Windows\\System32\\tar.exe',
    args: (archive, entry) => ['-xOf', archive, '--', entry],
  }];
  return [
    { kind: 'bsdtar', command: '/usr/bin/bsdtar', args: (archive, entry) => ['-xOf', archive, '--', entry] },
    { kind: '7z', command: '/usr/bin/7z', args: (archive, entry) => ['x', '-so', '-y', '-bd', '-bb0', '--', archive, entry] },
    { kind: '7z', command: '/usr/bin/7za', args: (archive, entry) => ['x', '-so', '-y', '-bd', '-bb0', '--', archive, entry] },
  ];
}
async function protectedExecutable(command: string): Promise<boolean> {
  if (!protectedCandidates().some((candidate) => candidate.command === command)) return false;
  if (!await ordinaryDirectory(path.dirname(command))) return false;
  let stat: Stats;
  try { stat = await fsp.lstat(command); } catch { return false; }
  return stat.isFile() && !stat.isSymbolicLink() &&
    (process.platform === 'win32' || stat.uid === 0 && (stat.mode & 0o022) === 0);
}
async function runProtected(command: string, args: string[], options: {
  maxBytes: number; timeoutMs: number; tempDir?: string; consume?: (chunk: Buffer) => Promise<void>;
}): Promise<{ stdout: Buffer; stderr: string; bytes: number; sha256: string }> {
  if (!await protectedExecutable(command)) throw new Error('A protected archive extractor is unavailable.');
  const env: Record<string, string> = process.platform === 'win32'
    ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32' }
    : { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  if (options.tempDir) { env['TEMP'] = options.tempDir; env['TMP'] = options.tempDir; env['TMPDIR'] = options.tempDir; }
  let child: ReturnType<typeof childProcess.spawn>;
  try { child = childProcess.spawn(command, args, { cwd: path.dirname(command), env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('Archive extractor could not be started.'); }
  let closed = false, bytes = 0, stderrBytes = 0, stderr = '';
  const hash = crypto.createHash('sha256'), chunks: Buffer[] = [];
  let rejectLimit!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectLimit = reject; });
  const stop = (message: string) => { try { child.kill(); } catch {} rejectLimit(new Error(message)); };
  const timeout = setTimeout(() => stop('Archive extractor timed out.'), options.timeoutMs);
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES) stop('Archive extractor diagnostic limit exceeded.');
    else stderr += chunk.toString('utf8');
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Archive extractor could not be started.')));
    child.once('close', (code) => { closed = true; if (code === 0) resolve(); else reject(new Error('Archive extractor failed.')); });
  });
  const output = (async () => {
    if (!child.stdout) throw new Error('Archive extractor has no output stream.');
    for await (const chunk of child.stdout) {
      const buffer = Buffer.from(chunk);
      if (buffer.length > options.maxBytes - bytes) throw new Error('Archive extractor output limit exceeded.');
      bytes += buffer.length; hash.update(buffer);
      if (options.consume) await options.consume(buffer); else chunks.push(buffer);
    }
  })();
  try {
    await Promise.race([Promise.all([exit, output]), failure]);
    return { stdout: Buffer.concat(chunks), stderr, bytes, sha256: hash.digest('hex') };
  } finally {
    clearTimeout(timeout);
    if (!closed) try { child.kill(); } catch {}
    child.stdout?.destroy(); child.stderr?.destroy();
  }
}

/** Never probes PATH or executable locations controlled by environment variables.
 * Each use rechecks the fixed protected binary; no executable cache is trusted. */
export async function find7zExtractor(): Promise<Extractor | undefined> {
  for (const candidate of protectedCandidates()) {
    try {
      const probe = await runProtected(candidate.command, candidate.kind === 'bsdtar' ? ['--version'] : ['--help'], { maxBytes: 16 * 1024, timeoutMs: 5000 });
      if (candidate.kind === 'bsdtar' ? /bsdtar|libarchive/i.test(probe.stdout.toString('utf8') + probe.stderr) : /7-Zip|7z/i.test(probe.stdout.toString('utf8') + probe.stderr)) return candidate;
    } catch { /* Try only the remaining fixed system paths. */ }
  }
  return undefined;
}
async function selectEntry(extractor: Extractor, archive: string, selectedName: string): Promise<string> {
  const listed = await runProtected(extractor.command,
    extractor.kind === 'bsdtar' ? ['-tf', archive] : ['l', '-slt', '-ba', '--', archive],
    { maxBytes: MAX_LIST_BYTES, timeoutMs: 60_000 });
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(listed.stdout); } catch { throw new Error('Archive listing is not valid text.'); }
  let names = extractor.kind === 'bsdtar' ? text.split(/\r?\n/).filter(Boolean)
    : text.split(/\r?\n/).filter((line) => line.startsWith('Path = ')).map((line) => line.slice(7)).filter((value) => value !== archive);
  if (!names.length || names.length > MAX_ENTRIES) throw new Error('Archive entry count limit exceeded.');
  names = names.map(safeEntry).filter((name): name is string => name !== undefined);
  const matches = names.filter((name) => path.posix.basename(name).toLowerCase() === selectedName.toLowerCase());
  if (matches.length !== 1) throw new Error('The selected font entry is missing or ambiguous.');
  return matches[0]!;
}
function queue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve(), next = prior.then(work, work);
  const settled = next.then(() => {}, () => {}); queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return next;
}

/** Only one explicitly selected entry is decoded to stdout. Archive-controlled
 * names never become output paths. Disk markers alone cannot authorize reuse:
 * a process-local seal exists only after this process verified extractor output. */
export async function extract7z(archivePath: string, cacheDir: string, selectedEntry?: string, expectedSha256?: string): Promise<SevenZipResult> {
  const selected = safeName(selectedEntry ?? ''), root = path.resolve(cacheDir), archive = path.resolve(archivePath);
  const relative = path.relative(root, archive);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Archive must be in the download cache.');
  return queue(root.toLowerCase(), async () => {
    const input = await fingerprint(archive, MAX_ASSET_BYTES);
    if (expectedSha256 !== undefined && (!/^[0-9a-f]{64}$/i.test(expectedSha256) || input.sha256 !== expectedSha256.toLowerCase())) throw new Error('Archive checksum mismatch before extraction.');
    const key = crypto.createHash('sha256').update(input.sha256 + '\n' + selected).digest('hex').slice(0, 32);
    const dir = path.join(root, 'extracted', key), output = path.join(dir, selected), marker = path.join(dir, MARKER);
    await ordinaryDirectory(dir, true);
    const existing = await ordinaryFile(output, MAX_SEVENZIP_ENTRY_BYTES);
    await ordinaryFile(marker, 4096);
    const sealed = seals.get(dir);
    if (sealed && sealed.archiveSha256 === input.sha256 && existing) {
      const actual = await fingerprint(output, MAX_SEVENZIP_ENTRY_BYTES);
      if (actual.sha256 === sealed.fileSha256 && actual.bytes === sealed.bytes) return { dir, extractor: sealed.extractor, fromCache: true, sha256: actual.sha256, bytes: actual.bytes };
    }
    const extractor = await find7zExtractor();
    if (!extractor) throw new Error('No protected 7-Zip capable system extractor is available.');
    const entry = await selectEntry(extractor, archive, selected);
    const temporary = path.join(dir, '.' + selected + '.' + crypto.randomUUID() + '.part');
    const temporaryMarker = path.join(dir, '.marker.' + crypto.randomUUID() + '.part');
    try {
      await ordinaryDirectory(dir);
      const handle = await fsp.open(temporary, 'wx', 0o600);
      let decoded: { bytes: number; sha256: string };
      try {
        decoded = await runProtected(extractor.command, extractor.args(archive, entry), {
          maxBytes: MAX_SEVENZIP_ENTRY_BYTES, timeoutMs: 120_000, tempDir: dir,
          consume: async (chunk) => { await handle.writeFile(chunk); },
        });
        await handle.sync();
      } finally { await handle.close(); }
      if (!decoded.bytes) throw new Error('Selected font entry has no regular file data.');
      const staged = await fingerprint(temporary, MAX_SEVENZIP_ENTRY_BYTES);
      const inputAfter = await fingerprint(archive, MAX_ASSET_BYTES);
      if (staged.sha256 !== decoded.sha256 || staged.bytes !== decoded.bytes ||
        inputAfter.sha256 !== input.sha256 || !sameFile(input.stat, inputAfter.stat)) throw new Error('Archive or selected output changed during extraction.');
      const seal: Seal = { archiveSha256: input.sha256, entry, fileSha256: staged.sha256, bytes: staged.bytes, extractor: extractor.kind };
      await ordinaryFile(output, MAX_SEVENZIP_ENTRY_BYTES); await ordinaryFile(marker, 4096); await ordinaryDirectory(dir);
      await fsp.rename(temporary, output);
      const markerHandle = await fsp.open(temporaryMarker, 'wx', 0o600);
      try { await markerHandle.writeFile(JSON.stringify({ schemaVersion: 1, ...seal }), 'utf8'); await markerHandle.sync(); }
      finally { await markerHandle.close(); }
      await ordinaryDirectory(dir); await ordinaryFile(marker, 4096);
      await fsp.rename(temporaryMarker, marker);
      seals.delete(dir); while (seals.size >= 100) seals.delete(seals.keys().next().value!); seals.set(dir, seal);
      return { dir, extractor: extractor.kind, fromCache: false, sha256: staged.sha256, bytes: staged.bytes };
    } finally {
      try {
        if (await ordinaryDirectory(dir)) {
          await fsp.rm(temporary, { force: true }); await fsp.rm(temporaryMarker, { force: true });
        }
      } catch { /* Unsafe paths are preserved rather than followed for cleanup. */ }
    }
  });
}

/** The selected-entry cache is flat. Linked, ambiguous or non-file entries
 * never become a source for copying into a game. */
export async function findExtractedEntry(dir: string, name: string): Promise<string | undefined> {
  const selected = safeName(name);
  if (!await ordinaryDirectory(dir)) return undefined;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (entries.length > 5000) throw new Error('Font extraction directory is too large.');
  const matches = entries.filter((entry) => entry.name.toLowerCase() === selected.toLowerCase());
  if (matches.length > 1) throw new Error('Font extraction entry is ambiguous.');
  if (!matches.length) return undefined;
  const file = path.join(dir, matches[0]!.name), stat = await ordinaryFile(file, MAX_SEVENZIP_ENTRY_BYTES);
  return stat && stat.size > 0 ? file : undefined;
}

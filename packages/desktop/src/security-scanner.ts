import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PROVIDER = 'microsoft-defender' as const;
const WINDOWS = 'C:\\Windows';
const POWERSHELL = path.win32.join(WINDOWS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PLATFORM = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform';
const INBOX = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe';
const OUTPUT_LIMIT = 64 * 1024;
const VERSION = /^\d+(?:\.\d+){1,3}$/;

export type SecurityScannerReason = 'unsupported-platform' | 'engine-missing' | 'engine-untrusted' | 'engine-unavailable' |
  'stale-signatures' | 'status-error' | 'unsafe-target' | 'target-changed' | 'engine-changed' | 'scan-limit' |
  'timed-out' | 'cancelled' | 'busy' | 'engine-attention' | 'permission-denied' | 'engine-error' | 'output-limit';
export interface SecurityScannerStatus {
  provider: typeof PROVIDER;
  state: 'ready' | 'unavailable' | 'stale';
  reason?: SecurityScannerReason;
  engineVersion?: string;
  signatureVersion?: string;
  signatureAgeDays?: number;
  realTimeProtectionEnabled?: boolean;
  /** Defender continues using the machine's existing cloud/protection policy. */
  policy: 'existing-defender-policy';
}
export interface SecurityTargetFingerprint {
  scope: 'file' | 'directory';
  sha256: string;
  files: number;
  bytes: number;
}
export interface SecurityScanResult {
  provider: typeof PROVIDER;
  verdict: 'clean' | 'attention' | 'not-checked';
  reason?: SecurityScannerReason;
  startedAt: string;
  completedAt: string;
  fingerprint?: SecurityTargetFingerprint;
  engineVersion?: string;
  signatureVersion?: string;
}
export interface SecurityUpdateResult {
  provider: typeof PROVIDER;
  state: 'updated' | 'not-updated';
  reason?: SecurityScannerReason;
  status: SecurityScannerStatus;
  changed?: boolean;
}
export interface SecurityProcessRequest {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}
export interface SecurityProcessResult {
  code: number | null;
  stdout: string;
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
}
export interface SecurityScannerOptions {
  /** Test seams only; the renderer must never provide provider options. */
  platform?: NodeJS.Platform;
  run?: (request: SecurityProcessRequest) => Promise<SecurityProcessResult>;
  discoverCandidates?: () => Promise<string[]>;
  maxSignatureAgeDays?: number;
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
}
interface Limits { maxFiles: number; maxBytes: number; timeoutMs: number }
class ScannerFailure extends Error {
  readonly reason: SecurityScannerReason;
  constructor(reason: SecurityScannerReason) { super(reason); this.reason = reason; }
}
function fail(reason: SecurityScannerReason): never { throw new ScannerFailure(reason); }
function reason(error: unknown): SecurityScannerReason { return error instanceof ScannerFailure ? error.reason : 'status-error'; }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isSafeInteger(value) && value! >= min && value! <= max ? value! : fallback;
}
function checked(signal?: AbortSignal): void { if (signal?.aborted) fail('cancelled'); }
function release(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && VERSION.test(value) ? value : undefined;
}

/** Fixed script and environment data keep paths out of PowerShell source. No
 * preferences, exclusions, credentials or remediation commands are queried. */
const STATUS_SCRIPT = `$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath $env:INDIEDECK_DEFENDER_ENGINE
$trusted = $sig.Status -eq 'Valid' -and $null -ne $sig.SignerCertificate -and $sig.SignerCertificate.Subject -match '(?:^|,\\s*)O=Microsoft Corporation(?:,|$)'
if (-not $trusted) { @{ BinaryTrusted = $false } | ConvertTo-Json -Compress; exit 0 }
$s = Get-MpComputerStatus
@{ BinaryTrusted = $true; AMServiceEnabled = [bool]$s.AMServiceEnabled; AntivirusEnabled = [bool]$s.AntivirusEnabled; AMRunningMode = [string]$s.AMRunningMode; AMEngineVersion = [string]$s.AMEngineVersion; AntivirusSignatureVersion = [string]$s.AntivirusSignatureVersion; AntivirusSignatureAge = $s.AntivirusSignatureAge; RealTimeProtectionEnabled = [bool]$s.RealTimeProtectionEnabled } | ConvertTo-Json -Compress`;

/** Only the spawned client process is terminated. No global Defender cancel,
 * service stop or process-tree kill can interrupt somebody else's scan. */
export function runSecurityProcess(request: SecurityProcessRequest): Promise<SecurityProcessResult> {
  return new Promise((resolve) => {
    if (request.signal?.aborted) { resolve({ code: null, stdout: '', aborted: true }); return; }
    let child;
    try {
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'OS', 'PROCESSOR_ARCHITECTURE']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      Object.assign(env, request.env, {
        SystemRoot: WINDOWS, windir: WINDOWS, SystemDrive: 'C:', ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files',
        PATH: `${WINDOWS}\\System32;${WINDOWS};${path.win32.dirname(POWERSHELL)}`,
        PSModulePath: path.win32.join(WINDOWS, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      });
      child = spawn(request.executable, [...request.args], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.dirname(request.executable), env,
      });
    } catch { resolve({ code: null, stdout: '' }); return; }
    let output = Buffer.alloc(0), outputBytes = 0, timedOut = false, aborted = false, truncated = false, done = false;
    const stop = () => { try { child.kill(); } catch {} };
    const onAbort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT) { truncated = true; stop(); return; }
      output = Buffer.concat([output, chunk]);
    };
    child.stdout?.on('data', collect);
    // Drain stderr without exposing provider text, which can contain filenames.
    child.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT) { truncated = true; stop(); }
    });
    const finish = (code: number | null) => {
      if (done) return;
      done = true; clearTimeout(timer); request.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: output.toString('utf8'), timedOut, aborted, truncated });
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    child.once('error', () => finish(null));
    child.once('close', finish);
  });
}

async function ordinary(target: string, kind?: 'file' | 'directory'): Promise<import('node:fs').Stats> {
  if (!path.isAbsolute(target) || /[\u0000-\u001f]/.test(target) || /^\\\\/.test(target)) fail('unsafe-target');
  const resolved = path.resolve(target), root = path.parse(resolved).root;
  let cursor = root;
  const ancestors = [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean).map((part) => { cursor = path.join(cursor, part); return cursor; })];
  for (let index = 0; index < ancestors.length; index += 1) {
    const stat = await fs.lstat(ancestors[index]!);
    if (stat.isSymbolicLink() || (index < ancestors.length - 1 && !stat.isDirectory())) fail('unsafe-target');
    if (index === ancestors.length - 1) {
      if (!stat.isFile() && !stat.isDirectory() || kind === 'file' && !stat.isFile() || kind === 'directory' && !stat.isDirectory() || stat.isFile() && stat.nlink !== 1) fail('unsafe-target');
      return stat;
    }
  }
  fail('unsafe-target');
}
function sameFile(a: import('node:fs').Stats, b: import('node:fs').Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
}
async function digest(file: string, maxBytes: number, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  checked(signal);
  const before = await ordinary(file, 'file');
  if (before.size > maxBytes) fail('scan-limit');
  const handle = await fs.open(file, 'r');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    if (!sameFile(before, await handle.stat())) fail('target-changed');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      checked(signal);
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) fail('scan-limit');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (!sameFile(before, await handle.stat())) fail('target-changed');
  } finally { await handle.close(); }
  if (bytes !== before.size || !sameFile(before, await ordinary(file, 'file'))) fail('target-changed');
  return { sha256: hash.digest('hex'), bytes };
}

/** A bounded full-content fingerprint, never a trusted verdict on its own.
 * Main may recompute it before launch/install to invalidate a previous scan. */
export async function fingerprintSecurityTarget(target: string, options: Pick<SecurityScannerOptions, 'maxFiles' | 'maxBytes'> & { signal?: AbortSignal } = {}): Promise<SecurityTargetFingerprint> {
  const maxFiles = bounded(options.maxFiles, 20_000, 1, 100_000), maxBytes = bounded(options.maxBytes, 20 * 1024 ** 3, 1, 100 * 1024 ** 3);
  const root = path.resolve(target);
  if (!path.isAbsolute(target) || root === path.parse(root).root) fail('unsafe-target');
  const stat = await ordinary(root);
  if (stat.isFile()) return { scope: 'file', ...(await digest(root, maxBytes, options.signal)), files: 1 };
  const hash = crypto.createHash('sha256');
  let files = 0, bytes = 0, directories = 0;
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    checked(options.signal);
    if (depth > 64 || ++directories > maxFiles) fail('scan-limit');
    const before = await ordinary(directory, 'directory');
    const names = (await fs.readdir(directory)).sort();
    if (names.length > maxFiles || names.some((name) => !name || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name))) fail('scan-limit');
    hash.update(`d\0${relative}\0`);
    for (const name of names) {
      const child = path.join(directory, name), childRelative = relative ? `${relative}/${name}` : name;
      const entry = await ordinary(child);
      if (entry.isDirectory()) await visit(child, childRelative, depth + 1);
      else {
        if (++files > maxFiles) fail('scan-limit');
        const content = await digest(child, maxBytes - bytes, options.signal);
        bytes += content.bytes;
        hash.update(`f\0${childRelative}\0${content.bytes}\0${content.sha256}\0`);
      }
    }
    const after = await ordinary(directory, 'directory');
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('target-changed');
  };
  await visit(root, '', 0);
  return { scope: 'directory', sha256: hash.digest('hex'), files, bytes };
}

async function discoverCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  try {
    await ordinary(PLATFORM, 'directory');
    const names = (await fs.readdir(PLATFORM)).filter((name) => /^\d+(?:\.\d+){1,3}(?:-\d+)?$/.test(name)).slice(0, 64);
    names.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const name of names) candidates.push(path.win32.join(PLATFORM, name, 'MpCmdRun.exe'));
  } catch {}
  candidates.push(INBOX);
  return candidates;
}
function processFailure(result: SecurityProcessResult): SecurityScannerReason | undefined {
  if (result.timedOut) return 'timed-out';
  if (result.aborted) return 'cancelled';
  if (result.truncated || Buffer.byteLength(result.stdout) > OUTPUT_LIMIT) return 'output-limit';
  if ([5, 2147942405, -2147024891].includes(result.code ?? 0)) return 'permission-denied';
  return undefined;
}
function health(result: SecurityProcessResult, maxAge: number): SecurityScannerStatus {
  const base = { provider: PROVIDER, policy: 'existing-defender-policy' as const };
  const failed = processFailure(result);
  if (failed || result.code !== 0) return { ...base, state: 'unavailable', reason: failed ?? 'status-error' };
  let data: Record<string, unknown>;
  try { data = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as Record<string, unknown>; }
  catch { return { ...base, state: 'unavailable', reason: 'status-error' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.BinaryTrusted !== true) return { ...base, state: 'unavailable', reason: 'engine-untrusted' };
  const engineVersion = release(data.AMEngineVersion), signatureVersion = release(data.AntivirusSignatureVersion);
  const signatureAgeDays = data.AntivirusSignatureAge;
  if (data.AMServiceEnabled !== true || data.AntivirusEnabled !== true || data.AMRunningMode !== 'Normal') return { ...base, state: 'unavailable', reason: 'engine-unavailable' };
  if (!engineVersion || !signatureVersion || !Number.isSafeInteger(signatureAgeDays) || (signatureAgeDays as number) < 0 || (signatureAgeDays as number) > 36500) return { ...base, state: 'unavailable', reason: 'status-error' };
  const metadata = { ...base, engineVersion, signatureVersion, signatureAgeDays: signatureAgeDays as number,
    ...(typeof data.RealTimeProtectionEnabled === 'boolean' ? { realTimeProtectionEnabled: data.RealTimeProtectionEnabled } : {}) };
  return (signatureAgeDays as number) > maxAge ? { ...metadata, state: 'stale', reason: 'stale-signatures' } : { ...metadata, state: 'ready' };
}

export function createSecurityScanner(options: SecurityScannerOptions = {}) {
  const platform = options.platform ?? process.platform, run = options.run ?? runSecurityProcess;
  const limits: Limits = { maxFiles: bounded(options.maxFiles, 20_000, 1, 100_000), maxBytes: bounded(options.maxBytes, 20 * 1024 ** 3, 1, 100 * 1024 ** 3), timeoutMs: bounded(options.timeoutMs, 15 * 60_000, 1, 15 * 60_000) };
  const maxAge = bounded(options.maxSignatureAgeDays, 7, 0, 30);
  let busy = false;
  const unavailable = (why: SecurityScannerReason): SecurityScannerStatus => ({ provider: PROVIDER, state: 'unavailable', reason: why, policy: 'existing-defender-policy' });
  const resolve = async (signal?: AbortSignal): Promise<{ status: SecurityScannerStatus; executable?: string; sha256?: string }> => {
    if (platform !== 'win32') return { status: unavailable('unsupported-platform') };
    checked(signal);
    let candidates: string[];
    try { candidates = (await (options.discoverCandidates ?? discoverCandidates)()).slice(0, 65); }
    catch { return { status: unavailable('engine-missing') }; }
    for (const candidate of candidates) {
      let identity;
      try { identity = await digest(candidate, 64 * 1024 * 1024, signal); }
      catch (error) {
        if (signal?.aborted) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return { status: unavailable('engine-untrusted') };
      }
      const inspection = await run({ executable: POWERSHELL, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(STATUS_SCRIPT, 'utf16le').toString('base64')], timeoutMs: 15_000, signal, env: { INDIEDECK_DEFENDER_ENGINE: candidate } });
      const status = health(inspection, maxAge);
      // A present but untrusted engine cannot silently fall through to another.
      if (status.state === 'unavailable') return { status };
      try { if ((await digest(candidate, 64 * 1024 * 1024, signal)).sha256 !== identity.sha256) return { status: unavailable('engine-changed') }; }
      catch { return { status: unavailable('engine-changed') }; }
      return { status, executable: candidate, sha256: identity.sha256 };
    }
    return { status: unavailable('engine-missing') };
  };
  const status = async (): Promise<SecurityScannerStatus> => {
    try { return (await resolve()).status; } catch (error) { return unavailable(reason(error)); }
  };
  const scanTarget = async (target: string, request: { signal?: AbortSignal } = {}): Promise<SecurityScanResult> => {
    const startedAt = new Date().toISOString();
    const result = (verdict: SecurityScanResult['verdict'], why?: SecurityScannerReason, fingerprint?: SecurityTargetFingerprint, state?: SecurityScannerStatus): SecurityScanResult => ({
      provider: PROVIDER, verdict, ...(why ? { reason: why } : {}), startedAt, completedAt: new Date().toISOString(),
      ...(fingerprint ? { fingerprint } : {}), ...(state?.engineVersion ? { engineVersion: state.engineVersion } : {}), ...(state?.signatureVersion ? { signatureVersion: state.signatureVersion } : {}),
    });
    if (busy) return result('not-checked', 'busy');
    busy = true;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    try {
      const engine = await resolve(signal);
      if (engine.status.state !== 'ready' || !engine.executable) return result('not-checked', engine.status.reason ?? 'engine-unavailable', undefined, engine.status);
      const before = await fingerprintSecurityTarget(target, { ...limits, signal });
      checked(signal);
      const native = await run({ executable: engine.executable, args: ['-Scan', '-ScanType', '3', '-File', path.resolve(target), '-DisableRemediation'], timeoutMs: limits.timeoutMs, signal });
      checked(signal);
      const failed = processFailure(native);
      if (failed) return result('not-checked', failed, undefined, engine.status);
      if (native.code === 2) return result('attention', 'engine-attention', undefined, engine.status);
      if (native.code !== 0) return result('not-checked', 'engine-error', undefined, engine.status);
      const after = await fingerprintSecurityTarget(target, { ...limits, signal });
      if (JSON.stringify(before) !== JSON.stringify(after)) return result('not-checked', 'target-changed', undefined, engine.status);
      const final = await resolve(signal);
      if (final.status.state !== 'ready' || final.executable !== engine.executable || final.sha256 !== engine.sha256 || final.status.engineVersion !== engine.status.engineVersion || final.status.signatureVersion !== engine.status.signatureVersion) return result('not-checked', 'engine-changed', undefined, engine.status);
      return result('clean', undefined, after, final.status);
    } catch (error) {
      return result('not-checked', timedOut ? 'timed-out' : signal.aborted ? 'cancelled' : error instanceof ScannerFailure ? error.reason : 'unsafe-target');
    } finally { clearTimeout(timer); busy = false; }
  };
  const updateSignatures = async (request: { signal?: AbortSignal } = {}): Promise<SecurityUpdateResult> => {
    if (busy) return { provider: PROVIDER, state: 'not-updated', reason: 'busy', status: unavailable('busy') };
    busy = true;
    try {
      const before = await resolve(request.signal);
      if (!before.executable || before.status.state === 'unavailable') return { provider: PROVIDER, state: 'not-updated', reason: before.status.reason ?? 'engine-unavailable', status: before.status };
      const native = await run({ executable: before.executable, args: ['-SignatureUpdate'], timeoutMs: 5 * 60_000, signal: request.signal });
      const failed = processFailure(native);
      if (failed || native.code !== 0) return { provider: PROVIDER, state: 'not-updated', reason: failed ?? 'engine-error', status: before.status };
      checked(request.signal);
      const after = await resolve(request.signal);
      if (after.status.state !== 'ready') return { provider: PROVIDER, state: 'not-updated', reason: after.status.reason ?? 'status-error', status: after.status };
      return { provider: PROVIDER, state: 'updated', status: after.status, changed: before.status.signatureVersion !== after.status.signatureVersion };
    } catch (error) { const why = reason(error); return { provider: PROVIDER, state: 'not-updated', reason: why, status: unavailable(why) }; }
    finally { busy = false; }
  };
  return { status, scanTarget, updateSignatures };
}

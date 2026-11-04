import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';
import type { AssetSource } from '../types.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import {
  assertAssetUrl, consumeAssetBody, fetchAssetResponse,
  DEFAULT_NETWORK_TIMEOUT_MS, MAX_ASSET_BYTES, MAX_METADATA_BYTES, MAX_NETWORK_TIMEOUT_MS,
} from './network-policy.ts';

export function defaultDataDir(): string {
  return process.env['INDIEDECK_HOME'] ?? path.join(os.homedir(), '.indiedeck');
}
export function defaultCacheDir(): string { return path.join(defaultDataDir(), 'cache'); }
export function defaultToolsDir(): string { return path.join(defaultDataDir(), 'tools'); }

export interface DownloadOptions {
  cacheDir?: string;
  logger?: Logger;
  /** Skip the cache and re-fetch. */
  force?: boolean;
  onProgress?: (received: number, total: number | undefined) => void;
  onDownloadEvent?: (event: DownloadProgressEvent) => void;
  signal?: AbortSignal;
  /** A caller may lower the transfer ceiling, never exceed the fixed 1 GiB cap. */
  maxBytes?: number;
  /** Entire metadata + body deadline, including a response with no byte progress. */
  timeoutMs?: number;
}
export interface DownloadProgressEvent {
  phase: 'download' | 'verify';
  status: 'started' | 'progress' | 'completed' | 'failed';
  assetId: string;
  received?: number;
  total?: number;
  fromCache?: boolean;
  integrity?: DownloadResult['integrity'];
  error?: string;
}
export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  fromCache: boolean;
  url: string;
  /** A matching pinned digest is integrity evidence, not a malware verdict. */
  integrity: 'verified' | 'unverified' | 'mismatch';
}
interface GithubAsset { name: string; browser_download_url: string; size: number }
interface GithubRelease { tag_name: string; assets: GithubAsset[]; published_at?: string }

function sourceAssetId(source: AssetSource): string {
  let value = source.asset ?? source.assetPattern ?? source.repo ?? 'asset';
  if (source.url) {
    try { value = decodeURIComponent(new URL(source.url).pathname.split('/').pop() ?? 'asset'); } catch { value = 'asset'; }
  }
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
}
function emitDownload(options: DownloadOptions, event: DownloadProgressEvent): void {
  try { options.onDownloadEvent?.(event); }
  catch { (options.logger ?? silentLogger).warn('download progress observer failed'); }
}
function limit(options: DownloadOptions): number {
  const value = options.maxBytes ?? MAX_ASSET_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ASSET_BYTES) throw new Error('Invalid download byte limit.');
  return value;
}
function deadline(options: DownloadOptions): { signal: AbortSignal; close: () => void } {
  const milliseconds = options.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > MAX_NETWORK_TIMEOUT_MS) throw new Error('Invalid download deadline.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  return { signal, close: () => clearTimeout(timer) };
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Network request cancelled or timed out.');
}
function assetName(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 180 || value === '.' || value === '..' ||
    /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(value) || /[. ]$/.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('Unsafe asset filename.');
  }
  return value;
}
function repoName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid GitHub repository.');
  return value;
}
function declaredSize(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new Error('Asset size exceeds its byte limit or is invalid.');
  return value as number;
}
async function githubRelease(repo: string, tag: string, signal: AbortSignal): Promise<GithubRelease> {
  if (!tag || tag.length > 200 || /[\u0000-\u0020\u007f]/.test(tag) || tag === '.' || tag === '..') throw new Error('Invalid GitHub release tag.');
  const api = 'https://api.github.com/repos/' + repo + '/releases/' + (tag === 'latest' ? 'latest' : 'tags/' + encodeURIComponent(tag));
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  const response = await fetchAssetResponse(api, { purpose: 'github-api', signal, ...(token ? { githubAuthorization: 'Bearer ' + token } : {}) });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('GitHub API HTTP ' + response.status + '.'); }
  const chunks: Buffer[] = [];
  await consumeAssetBody(response, MAX_METADATA_BYTES, signal, (chunk) => { chunks.push(chunk); });
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new Error('Invalid GitHub release metadata.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid GitHub release metadata.');
  const object = parsed as Record<string, unknown>;
  if (typeof object['tag_name'] !== 'string' || object['tag_name'].length > 200 || !Array.isArray(object['assets']) || object['assets'].length > 5000) throw new Error('Invalid GitHub release metadata.');
  if (tag !== 'latest' && object['tag_name'] !== tag) throw new Error('GitHub release tag does not match the registered tag.');
  return parsed as GithubRelease;
}

/** Only pinned registry origins and GitHub release paths are accepted. Redirect
 * policy is checked again by the transfer, before each request is dispatched. */
export async function resolveAssetUrl(source: AssetSource, options: DownloadOptions = {}): Promise<{ url: string; name: string; size?: number }> {
  const maximum = limit(options), scope = deadline(options);
  try {
    assertActive(scope.signal);
    const size = declaredSize(source.size, maximum);
    if (source.type === 'url') {
      if (!source.url) throw new Error('AssetSource of type url has no URL.');
      const url = assertAssetUrl(source.url);
      let name: string;
      try { name = decodeURIComponent(url.pathname.split('/').pop() ?? ''); } catch { throw new Error('Unsafe asset filename.'); }
      return { url: url.href, name: assetName(name), ...(size !== undefined ? { size } : {}) };
    }
    if (source.type !== 'github-release') throw new Error('Unknown asset source.');
    const repo = repoName(source.repo), tag = source.tag ?? 'latest';
    if (source.asset !== undefined) assetName(source.asset);
    if (source.assetPattern !== undefined && (typeof source.assetPattern !== 'string' || source.assetPattern.length > 256)) throw new Error('Invalid asset pattern.');
    const release = await githubRelease(repo, tag, scope.signal);
    let asset = source.asset ? release.assets.find((item) => item && item.name === source.asset) : undefined;
    if (!asset && source.assetPattern) {
      const expression = new RegExp(source.assetPattern);
      asset = release.assets.find((item) => item && typeof item.name === 'string' && item.name.length <= 180 && expression.test(item.name));
    }
    if (!asset || typeof asset.browser_download_url !== 'string') throw new Error('Registered asset was not found in the release.');
    const name = assetName(asset.name), url = assertAssetUrl(asset.browser_download_url);
    if (url.hostname !== 'github.com' || !url.pathname.toLowerCase().startsWith('/' + repo.toLowerCase() + '/releases/download/')) throw new Error('Release asset URL does not belong to the registered repository.');
    const actualSize = declaredSize(asset.size, maximum);
    if (actualSize === undefined || size !== undefined && actualSize !== size) throw new Error('Release asset size does not match the registered size.');
    return { url: url.href, name, size: actualSize };
  } finally { scope.close(); }
}
function cacheKey(url: string, name: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + '-' + name;
}

/** Refuse linked ancestors before inspecting, creating or publishing cache data. */
async function ordinaryDirectory(directory: string, create = false): Promise<boolean> {
  if (directory.includes('\0') || /^\\\\[?.]\\/.test(directory)) throw new Error('Unsafe download cache directory.');
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  if (/^\\\\[?.]\\/.test(resolved)) throw new Error('Unsafe download cache directory.');
  let cursor = root;
  const ancestors = [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean).map((part) => { cursor = path.join(cursor, part); return cursor; })];
  for (const ancestor of ancestors) {
    let stat: Stats;
    try { stat = await fsp.lstat(ancestor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fsp.mkdir(ancestor); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await fsp.lstat(ancestor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked download cache directories are not accepted.');
  }
  return true;
}
async function cacheStat(cacheDir: string, file: string, maximum: number): Promise<Stats | undefined> {
  if (!await ordinaryDirectory(cacheDir)) return undefined;
  let stat: Stats;
  try { stat = await fsp.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Linked or non-file download cache entries are not accepted.');
  if (stat.size > maximum) throw new Error('Cached asset exceeds its byte limit.');
  return stat;
}
function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
async function hashFile(cacheDir: string, file: string, maximum: number, signal: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const before = await cacheStat(cacheDir, file, maximum);
  if (!before) throw new Error('Cached asset disappeared.');
  const hash = crypto.createHash('sha256'), handle = await fsp.open(file, 'r');
  let bytes = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) throw new Error('Cached asset changed before verification.');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      assertActive(signal);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maximum - bytes + 1), null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maximum) throw new Error('Cached asset exceeds its byte limit.');
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  const after = await cacheStat(cacheDir, file, maximum);
  if (!after || !sameFile(before, after) || bytes !== after.size) throw new Error('Cached asset changed during verification.');
  return { sha256: hash.digest('hex'), bytes };
}
function checkIntegrity(expected: string | undefined, actual: string): DownloadResult['integrity'] {
  return expected ? expected.toLowerCase() === actual.toLowerCase() ? 'verified' : 'mismatch' : 'unverified';
}

/** Stream bounded bytes into a unique, exclusive temporary file. A digest is
 * verified before publication; it makes no claim that the payload is benign. */
export async function downloadAsset(source: AssetSource, options: DownloadOptions = {}): Promise<DownloadResult> {
  const log = options.logger ?? silentLogger, assetId = sourceAssetId(source), maximum = limit(options), scope = deadline(options);
  let partial: string | undefined, received = 0, total: number | undefined, phase: DownloadProgressEvent['phase'] = 'download';
  let failureIntegrity: DownloadResult['integrity'] | undefined;
  const cacheDir = path.resolve(options.cacheDir ?? defaultCacheDir());
  emitDownload(options, { phase, status: 'started', assetId, received: 0 });
  try {
    if (source.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(source.sha256)) throw new Error('Invalid pinned asset checksum.');
    const resolved = await resolveAssetUrl(source, { ...options, signal: scope.signal });
    const { url, name, size } = resolved, target = path.join(cacheDir, cacheKey(url, name));
    total = size;
    assertActive(scope.signal);
    const existing = await cacheStat(cacheDir, target, maximum);
    if (!options.force && existing) {
      phase = 'verify';
      emitDownload(options, { phase, status: 'started', assetId, fromCache: true });
      const cached = await hashFile(cacheDir, target, maximum, scope.signal), integrity = checkIntegrity(source.sha256, cached.sha256);
      emitDownload(options, { phase, status: 'completed', assetId, received: cached.bytes, total: cached.bytes, fromCache: true, integrity });
      if (integrity !== 'mismatch' && (size === undefined || cached.bytes === size)) {
        emitDownload(options, { phase: 'download', status: 'completed', assetId, received: cached.bytes, total: cached.bytes, fromCache: true });
        return { path: target, bytes: cached.bytes, sha256: cached.sha256, fromCache: true, url, integrity };
      }
      const current = await cacheStat(cacheDir, target, maximum);
      if (!current || !sameFile(existing, current)) throw new Error('Cached asset changed before replacement.');
      log.warn('Cached asset failed its integrity or size check; downloading again.');
      await fsp.rm(target);
    }
    phase = 'download';
    await ordinaryDirectory(cacheDir, true);
    log.info('Downloading ' + name);
    const response = await fetchAssetResponse(url, { purpose: 'asset', signal: scope.signal });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Asset download HTTP ' + response.status + '.'); }
    const header = response.headers.get('content-length');
    const length = header === null ? undefined : declaredSize(/^\d+$/.test(header) ? Number(header) : NaN, maximum);
    if (length !== undefined && size !== undefined && length !== size) { void response.body?.cancel().catch(() => {}); throw new Error('Asset response size differs from release metadata.'); }
    total = length ?? size;
    emitDownload(options, { phase, status: 'progress', assetId, received: 0, ...(total !== undefined ? { total } : {}), fromCache: false });
    partial = target + '.' + crypto.randomUUID() + '.part';
    await ordinaryDirectory(cacheDir);
    const handle = await fsp.open(partial, 'wx', 0o600), hash = crypto.createHash('sha256');
    try {
      received = await consumeAssetBody(response, maximum, scope.signal, async (chunk) => {
        assertActive(scope.signal);
        hash.update(chunk);
        await handle.writeFile(chunk);
        received += chunk.length;
        options.onProgress?.(received, total);
        emitDownload(options, { phase: 'download', status: 'progress', assetId, received, ...(total !== undefined ? { total } : {}), fromCache: false });
      });
      await handle.sync();
    } finally { await handle.close(); }
    emitDownload(options, { phase: 'download', status: 'completed', assetId, received, ...(total !== undefined ? { total } : {}), fromCache: false });
    phase = 'verify';
    emitDownload(options, { phase, status: 'started', assetId, received, ...(total !== undefined ? { total } : {}), fromCache: false });
    const digest = hash.digest('hex'), integrity = checkIntegrity(source.sha256, digest);
    if (integrity === 'mismatch') { failureIntegrity = integrity; throw new Error('Checksum mismatch; the download was discarded.'); }
    if (total !== undefined && received !== total) throw new Error('Truncated asset download.');
    assertActive(scope.signal);
    await ordinaryDirectory(cacheDir);
    await cacheStat(cacheDir, target, maximum);
    const staged = await cacheStat(cacheDir, partial, maximum);
    if (!staged || staged.size !== received) throw new Error('Staged asset changed before publication.');
    const actual = await hashFile(cacheDir, partial, maximum, scope.signal);
    const stagedAfter = await cacheStat(cacheDir, partial, maximum);
    if (!stagedAfter || !sameFile(staged, stagedAfter) || actual.sha256 !== digest || actual.bytes !== received) throw new Error('Staged asset differs from transferred bytes.');
    await fsp.rename(partial, target);
    partial = undefined;
    emitDownload(options, { phase, status: 'completed', assetId, received, ...(total !== undefined ? { total } : {}), fromCache: false, integrity });
    return { path: target, bytes: received, sha256: digest, fromCache: false, url, integrity };
  } catch (error) {
    emitDownload(options, { phase, status: 'failed', assetId, received, ...(total !== undefined ? { total } : {}), fromCache: false,
      ...(failureIntegrity ? { integrity: failureIntegrity } : {}), error: error instanceof Error ? error.message : 'Asset download failed.' });
    throw error;
  } finally {
    scope.close();
    if (partial) {
      try { if (await ordinaryDirectory(cacheDir)) await fsp.rm(partial, { force: true }); } catch { /* Preserve unsafe paths instead of following them for cleanup. */ }
    }
  }
}
export function sha256(buffer: Buffer): string { return crypto.createHash('sha256').update(buffer).digest('hex'); }

/** Advisory registry check shares the same bounded API and credential policy. */
export async function latestReleaseTag(repo: string): Promise<{ tag: string; assets: string[]; published?: string }> {
  const scope = deadline({});
  try {
    const release = await githubRelease(repoName(repo), 'latest', scope.signal);
    const result: { tag: string; assets: string[]; published?: string } = {
      tag: release.tag_name,
      assets: release.assets.filter((asset) => asset && typeof asset.name === 'string' && asset.name.length <= 180).map((asset) => asset.name),
    };
    if (typeof release.published_at === 'string' && release.published_at.length <= 80) result.published = release.published_at;
    return result;
  } finally { scope.close(); }
}

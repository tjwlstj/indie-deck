import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AssetSource } from '../types.ts';
import { ensureDir, pathExists } from '../util/fsx.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';

export function defaultDataDir(): string {
  const base = process.env['INDIEDECK_HOME'] ?? path.join(os.homedir(), '.indiedeck');
  return base;
}

export function defaultCacheDir(): string {
  return path.join(defaultDataDir(), 'cache');
}

export function defaultToolsDir(): string {
  return path.join(defaultDataDir(), 'tools');
}

export interface DownloadOptions {
  cacheDir?: string;
  logger?: Logger;
  /** Skip the cache and re-fetch. */
  force?: boolean;
  /** Legacy byte callback retained for CLI and desktop compatibility. */
  onProgress?: (received: number, total: number | undefined) => void;
  /** Structured download lifecycle used by applyPlan's progress contract. */
  onDownloadEvent?: (event: DownloadProgressEvent) => void;
  signal?: AbortSignal;
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
  /**
   * `verified` - matched the checksum pinned in the registry.
   * `mismatch` - did not (the download is discarded and this never returns).
   * `unverified` - no checksum is published upstream, so there is nothing to
   * compare against; the hash is still reported and recorded in the receipt.
   */
  integrity: 'verified' | 'unverified' | 'mismatch';
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

function sourceAssetId(source: AssetSource): string {
  if (source.asset) return source.asset;
  if (source.assetPattern) return source.assetPattern;
  if (source.url) {
    try {
      return decodeURIComponent(new URL(source.url).pathname.split('/').pop() ?? 'download');
    } catch {
      return source.url.split('/').pop() ?? 'download';
    }
  }
  return `${source.repo ?? 'asset'}@${source.tag ?? 'latest'}`;
}

function emitDownload(options: DownloadOptions, event: DownloadProgressEvent): void {
  try {
    options.onDownloadEvent?.(event);
  } catch (err) {
    (options.logger ?? silentLogger).warn(`download progress observer failed: ${(err as Error).message}`);
  }
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'IndieDeck',
  };
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  if (token) headers['authorization'] = `Bearer ${token}`;
  return headers;
}

/** Resolves a registry AssetSource to a concrete download URL. */
export async function resolveAssetUrl(source: AssetSource): Promise<{ url: string; name: string; size?: number }> {
  if (source.type === 'url') {
    if (!source.url) throw new Error('AssetSource of type "url" has no url.');
    const name = decodeURIComponent(source.url.split('/').pop() ?? 'download.bin');
    const result: { url: string; name: string; size?: number } = { url: source.url, name };
    if (source.size !== undefined) result.size = source.size;
    return result;
  }

  if (!source.repo) throw new Error('AssetSource of type "github-release" has no repo.');
  const tag = source.tag ?? 'latest';
  const api =
    tag === 'latest'
      ? `https://api.github.com/repos/${source.repo}/releases/latest`
      : `https://api.github.com/repos/${source.repo}/releases/tags/${tag}`;

  const response = await fetch(api, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${source.repo}@${tag}${response.status === 403 ? ' (rate limited - set GITHUB_TOKEN)' : ''}`);
  }
  const release = (await response.json()) as GithubRelease;

  let asset: GithubAsset | undefined;
  if (source.asset) asset = release.assets.find((a) => a.name === source.asset);
  if (!asset && source.assetPattern) {
    const re = new RegExp(source.assetPattern);
    asset = release.assets.find((a) => re.test(a.name));
  }
  if (!asset) {
    const available = release.assets.map((a) => a.name).join(', ');
    throw new Error(
      `Asset ${source.asset ?? source.assetPattern} not found in ${source.repo}@${release.tag_name}. Available: ${available}`,
    );
  }
  return { url: asset.browser_download_url, name: asset.name, size: asset.size };
}

function cacheKey(url: string, name: string): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  return `${hash}-${name}`;
}

/** Hashes a file without holding it in memory. */
async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

function checkIntegrity(expected: string | undefined, actual: string): DownloadResult['integrity'] {
  if (!expected) return 'unverified';
  return expected.toLowerCase() === actual.toLowerCase() ? 'verified' : 'mismatch';
}

/**
 * Downloads an asset into the content cache.
 *
 * The body is streamed to a `.part` file and hashed as it arrives, so a 128 MB
 * archive never sits in memory, and a partial or corrupted transfer can never
 * be mistaken for a finished one: the file is only renamed into place after the
 * hash is known and, when the registry pins a checksum, only if it matches.
 */
export async function downloadAsset(source: AssetSource, options: DownloadOptions = {}): Promise<DownloadResult> {
  const log = options.logger ?? silentLogger;
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const assetId = sourceAssetId(source);
  emitDownload(options, {
    phase: 'download',
    status: 'started',
    assetId,
    received: 0,
    ...(source.size !== undefined ? { total: source.size } : {}),
  });
  const { url, name, size } = await resolveAssetUrl(source);
  const target = path.join(cacheDir, cacheKey(url, name));

  if (!options.force && (await pathExists(target))) {
    emitDownload(options, { phase: 'verify', status: 'started', assetId, fromCache: true });
    const { sha256: digest, bytes } = await hashFile(target);
    const integrity = checkIntegrity(source.sha256, digest);
    if (integrity === 'mismatch') {
      emitDownload(options, {
        phase: 'verify',
        status: 'completed',
        assetId,
        received: bytes,
        total: bytes,
        fromCache: true,
        integrity,
      });
      // A cached file that no longer matches the pinned checksum is not usable.
      log.warn(`cached ${name} failed its checksum - re-downloading`);
      await fsp.rm(target, { force: true });
    } else {
      log.debug(`cache hit: ${name}`);
      emitDownload(options, {
        phase: 'download',
        status: 'completed',
        assetId,
        received: bytes,
        total: bytes,
        fromCache: true,
      });
      emitDownload(options, {
        phase: 'verify',
        status: 'completed',
        assetId,
        received: bytes,
        total: bytes,
        fromCache: true,
        integrity,
      });
      return { path: target, bytes, sha256: digest, fromCache: true, url, integrity };
    }
  }

  await ensureDir(cacheDir);
  log.info(`Downloading ${name}${size ? ` (${(size / 1048576).toFixed(1)} MB)` : ''}`);

  const init: RequestInit = { headers: { 'user-agent': 'IndieDeck' } };
  if (options.signal) init.signal = options.signal;
  const response = await fetch(url, init);
  if (!response.ok) {
    const error = `Download failed: HTTP ${response.status} for ${url}`;
    emitDownload(options, { phase: 'download', status: 'failed', assetId, fromCache: false, error });
    throw new Error(error);
  }

  const total = Number(response.headers.get('content-length')) || size;
  emitDownload(options, {
    phase: 'download',
    status: 'progress',
    assetId,
    received: 0,
    ...(total !== undefined ? { total } : {}),
    fromCache: false,
  });
  const partial = `${target}.part`;
  const hash = crypto.createHash('sha256');
  let received = 0;

  const handle = await fsp.open(partial, 'w');
  try {
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        await handle.write(buf);
        received += buf.length;
        options.onProgress?.(received, total);
        emitDownload(options, {
          phase: 'download',
          status: 'progress',
          assetId,
          received,
          ...(total !== undefined ? { total } : {}),
          fromCache: false,
        });
      }
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      hash.update(buf);
      await handle.write(buf);
      received = buf.length;
      options.onProgress?.(received, total);
      emitDownload(options, {
        phase: 'download',
        status: 'progress',
        assetId,
        received,
        ...(total !== undefined ? { total } : {}),
        fromCache: false,
      });
    }
  } catch (err) {
    await handle.close();
    await fsp.rm(partial, { force: true });
    emitDownload(options, {
      phase: 'download',
      status: 'failed',
      assetId,
      received,
      ...(total !== undefined ? { total } : {}),
      fromCache: false,
      error: (err as Error).message,
    });
    throw err;
  }
  await handle.close();

  emitDownload(options, {
    phase: 'download',
    status: 'completed',
    assetId,
    received,
    ...(total !== undefined ? { total } : {}),
    fromCache: false,
  });
  emitDownload(options, {
    phase: 'verify',
    status: 'started',
    assetId,
    received,
    ...(total !== undefined ? { total } : {}),
    fromCache: false,
  });

  const digest = hash.digest('hex');
  const integrity = checkIntegrity(source.sha256, digest);
  if (integrity === 'mismatch') {
    await fsp.rm(partial, { force: true });
    const error = `Checksum mismatch for ${name}: expected ${source.sha256}, got ${digest}. The download was discarded.`;
    emitDownload(options, {
      phase: 'verify',
      status: 'failed',
      assetId,
      received,
      ...(total !== undefined ? { total } : {}),
      fromCache: false,
      integrity,
      error,
    });
    throw new Error(error);
  }
  if (total && received !== total) {
    await fsp.rm(partial, { force: true });
    const error = `Truncated download for ${name}: expected ${total} bytes, got ${received}.`;
    emitDownload(options, {
      phase: 'verify',
      status: 'failed',
      assetId,
      received,
      total,
      fromCache: false,
      integrity,
      error,
    });
    throw new Error(error);
  }

  emitDownload(options, {
    phase: 'verify',
    status: 'completed',
    assetId,
    received,
    ...(total !== undefined ? { total } : {}),
    fromCache: false,
    integrity,
  });

  await fsp.rename(partial, target);
  return { path: target, bytes: received, sha256: digest, fromCache: false, url, integrity };
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Latest release tag for a repo - used by the registry sync check. */
export async function latestReleaseTag(repo: string): Promise<{ tag: string; assets: string[]; published?: string }> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: githubHeaders() });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${repo}`);
  const release = (await response.json()) as GithubRelease & { published_at?: string };
  const result: { tag: string; assets: string[]; published?: string } = {
    tag: release.tag_name,
    assets: release.assets.map((a) => a.name),
  };
  if (release.published_at) result.published = release.published_at;
  return result;
}

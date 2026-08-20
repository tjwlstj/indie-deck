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
  onProgress?: (received: number, total: number | undefined) => void;
  signal?: AbortSignal;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  fromCache: boolean;
  url: string;
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

export async function downloadAsset(source: AssetSource, options: DownloadOptions = {}): Promise<DownloadResult> {
  const log = options.logger ?? silentLogger;
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const { url, name, size } = await resolveAssetUrl(source);
  const target = path.join(cacheDir, cacheKey(url, name));

  if (!options.force && (await pathExists(target))) {
    const buf = await fsp.readFile(target);
    log.debug(`cache hit: ${name}`);
    return { path: target, bytes: buf.length, sha256: sha256(buf), fromCache: true, url };
  }

  await ensureDir(cacheDir);
  log.info(`Downloading ${name}${size ? ` (${(size / 1048576).toFixed(1)} MB)` : ''}`);

  const init: RequestInit = { headers: { 'user-agent': 'IndieDeck' } };
  if (options.signal) init.signal = options.signal;
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);

  const total = Number(response.headers.get('content-length')) || size;
  const chunks: Buffer[] = [];
  let received = 0;

  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      received += buf.length;
      options.onProgress?.(received, total);
    }
  } else {
    chunks.push(Buffer.from(await response.arrayBuffer()));
  }

  const data = Buffer.concat(chunks);
  const tmp = `${target}.part`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, target);

  return { path: target, bytes: data.length, sha256: sha256(data), fromCache: false, url };
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

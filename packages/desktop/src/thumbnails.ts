import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface Thumbnail { source: 'local' | 'steam'; dataUrl: string; steamAppId?: string }
export interface SteamCoverCandidate { appId: string; name: string }
export interface ThumbnailOptions { fetch?: typeof fetch }

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_PIXELS = 24_000_000;
const LOCAL_NAMES = ['cover.png', 'cover.jpg', 'cover.jpeg', 'cover.webp', 'folder.png', 'folder.jpg',
  'poster.png', 'poster.jpg', 'thumbnail.png', 'thumbnail.jpg'];
const steamCache = new Map<string, Thumbnail>();
const manifestsCache = new Map<string, { expires: number; result: Promise<Map<string, string | null>> }>();
let activeRequests = 0;
const queue: (() => void)[] = [];

async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (activeRequests >= 4) await new Promise<void>((resolve) => queue.push(resolve));
  else activeRequests += 1;
  try { return await run(); }
  finally {
    const next = queue.shift();
    if (next) next(); else activeRequests -= 1;
  }
}

function validAppId(value: string): boolean { return /^[1-9]\d{0,9}$/.test(value); }

/** Check the byte signature and dimensions before exposing data to Chromium. */
export function imageMime(bytes: Buffer): string | null {
  let width = 0, height = 0, mime = '';
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mime = 'image/png';
  } else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) break;
      while (bytes[at] === 0xff) at += 1;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda || marker === undefined) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const len = bytes.readUInt16BE(at);
      if (len < 2 || at + len > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && len >= 7) {
        height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); mime = 'image/jpeg'; break;
      }
      at += len;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    }
    mime = 'image/webp';
  }
  return mime && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= MAX_PIXELS ? mime : null;
}

function thumbnail(bytes: Buffer, source: 'local' | 'steam', appId?: string): Thumbnail | null {
  const mime = imageMime(bytes);
  if (!mime) return null;
  return { source, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, ...(appId ? { steamAppId: appId } : {}) };
}

/** Refuse symlinks in both the game directory and its ancestor chain. */
async function ordinaryDirectory(root: string): Promise<boolean> {
  const absolute = path.resolve(root); const parsed = path.parse(absolute);
  let current = parsed.root;
  try {
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await fsp.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return true;
  } catch { return false; }
}

async function readRegular(file: string, max: number): Promise<Buffer | null> {
  try {
    const before = await fsp.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > max) return null;
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size <= 0 || current.size > max) return null;
      const data = Buffer.alloc(current.size);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      return bytesRead === data.length ? data : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function installedSteamManifests(steamapps: string): Promise<Map<string, string | null>> {
  const key = steamapps.toLowerCase(), previous = manifestsCache.get(key);
  if (previous && previous.expires > Date.now()) return previous.result;
  const result = (async () => {
    const installed = new Map<string, string | null>();
    let names: string[];
    try { names = await fsp.readdir(steamapps); } catch { return installed; }
    if (names.length > 5000) return installed;
    for (const name of names) {
      const match = /^appmanifest_([1-9]\d{0,9})\.acf$/i.exec(name);
      if (!match) continue;
      const body = await readRegular(path.join(steamapps, name), 256 * 1024);
      if (!body) continue;
      const text = body.toString('utf8');
      const ids = [...text.matchAll(/"appid"\s*"([1-9]\d{0,9})"/gi)];
      const dirs = [...text.matchAll(/"installdir"\s*"([^"\\/]+)"/gi)];
      if (ids.length !== 1 || dirs.length !== 1 || ids[0]?.[1] !== match[1] || !dirs[0]?.[1]) continue;
      const folder = dirs[0][1].toLowerCase();
      installed.set(folder, installed.has(folder) ? null : match[1]!);
    }
    return installed;
  })();
  while (manifestsCache.size >= 24 && !manifestsCache.has(key)) manifestsCache.delete(manifestsCache.keys().next().value!);
  manifestsCache.set(key, { expires: Date.now() + 30_000, result });
  return result;
}

async function steamAppId(root: string): Promise<string | null> {
  const resolved = path.resolve(root), components = resolved.split(path.sep);
  // A game's nested executable may be below steamapps/common/InstallName.
  for (let index = components.length - 3; index >= 0; index -= 1) {
    if (components[index]?.toLowerCase() !== 'steamapps' || components[index + 1]?.toLowerCase() !== 'common') continue;
    const installName = components[index + 2];
    if (!installName) continue;
    const steamapps = components.slice(0, index + 1).join(path.sep) || path.parse(resolved).root;
    const matches = await installedSteamManifests(steamapps);
    const match = matches.get(installName.toLowerCase());
    if (match) return match;
    if (match === null) return null;
    // An ambiguous or absent matching manifest must not be guessed.
    break;
  }
  const hint = await readRegular(path.join(resolved, 'steam_appid.txt'), 32);
  const id = hint?.toString('utf8').trim() ?? '';
  return validAppId(id) ? id : null;
}

async function download(url: string, max: number, request: typeof fetch): Promise<Buffer | null> {
  try {
    const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'image/*, application/json' } });
    if (!response.ok || !response.body) return null;
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > max)) { await response.body.cancel(); return null; }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.length;
        if (total > max) { await reader.cancel(); return null; }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, total);
  } catch { return null; }
}

export async function fetchSteamCover(appId: string, options: ThumbnailOptions = {}): Promise<Thumbnail | null> {
  if (typeof appId !== 'string' || !validAppId(appId)) return null;
  const cached = !options.fetch && steamCache.get(appId);
  if (cached) return cached;
  return limited(async () => {
    const bytes = await download(`https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`, MAX_IMAGE_BYTES, options.fetch ?? fetch);
    const result = bytes && thumbnail(bytes, 'steam', appId);
    if (result && !options.fetch) {
      while (steamCache.size >= 24) steamCache.delete(steamCache.keys().next().value!);
      steamCache.set(appId, result);
    }
    return result;
  });
}

export async function searchSteamCovers(query: string, options: ThumbnailOptions = {}): Promise<SteamCoverCandidate[]> {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 120 || /[\u0000-\u001f\u007f]/u.test(query)) return [];
  return limited(async () => {
    const params = new URLSearchParams({ term: query.trim(), l: 'koreana', cc: 'KR' });
    const bytes = await download(`https://store.steampowered.com/api/storesearch/?${params}`, MAX_JSON_BYTES, options.fetch ?? fetch);
    if (!bytes) throw new Error('Steam search unavailable.');
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) throw new Error('Invalid Steam search response.');
      const found: SteamCoverCandidate[] = [], seen = new Set<string>();
      for (const item of (parsed as { items: unknown[] }).items.slice(0, 30)) {
        if (!item || typeof item !== 'object') continue;
        const { id, name } = item as { id?: unknown; name?: unknown };
        const appId = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : typeof id === 'string' ? id : '';
        if (!validAppId(appId) || typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name) || seen.has(appId)) continue;
        found.push({ appId, name }); seen.add(appId);
        if (found.length === 10) break;
      }
      return found;
    } catch { throw new Error('Steam search returned an invalid response.'); }
  });
}

export async function getGameThumbnail(gamePath: string, options: ThumbnailOptions = {}): Promise<Thumbnail | null> {
  if (!(await ordinaryDirectory(gamePath))) return null;
  let names: string[];
  try { names = await fsp.readdir(gamePath); } catch { return null; }
  for (const expected of LOCAL_NAMES) {
    const name = names.find((entry) => entry.toLowerCase() === expected);
    if (!name) continue;
    const bytes = await readRegular(path.join(gamePath, name), MAX_IMAGE_BYTES);
    const result = bytes && thumbnail(bytes, 'local');
    if (result) return result;
  }
  const appId = await steamAppId(gamePath);
  return appId ? fetchSteamCover(appId, options) : null;
}

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type StoreProviderId = 'steam' | 'epic' | 'gog' | 'itch' | 'booth' | 'dlsite' | 'dmm' | 'fanza';
export type StoreHandoffAction = 'site' | 'library' | 'login' | 'client' | 'downloadClient';
export interface StoreProvider {
  id: StoreProviderId; name: string; authMode: 'external-browser'; site: string;
  library?: string; login?: string; downloadClient?: string;
}
/** Fixed public entry points. No browser session, password or account state is
 * read by this module; opening an endpoint is not proof of authentication. */
export const STORE_PROVIDERS: readonly StoreProvider[] = Object.freeze([
  { id: 'steam', name: 'Steam', authMode: 'external-browser', site: 'https://store.steampowered.com/',
    login: 'https://store.steampowered.com/login/', downloadClient: 'https://store.steampowered.com/about/' },
  { id: 'epic', name: 'Epic Games Store', authMode: 'external-browser', site: 'https://store.epicgames.com/',
    downloadClient: 'https://store.epicgames.com/download' },
  { id: 'gog', name: 'GOG', authMode: 'external-browser', site: 'https://www.gog.com/',
    library: 'https://www.gog.com/en/account', downloadClient: 'https://www.gog.com/galaxy' },
  { id: 'itch', name: 'itch.io', authMode: 'external-browser', site: 'https://itch.io/',
    login: 'https://itch.io/login', downloadClient: 'https://itch.io/app' },
  { id: 'booth', name: 'BOOTH', authMode: 'external-browser', site: 'https://booth.pm/',
    login: 'https://accounts.booth.pm/users/sign_in', library: 'https://accounts.booth.pm/library' },
  { id: 'dlsite', name: 'DLsite', authMode: 'external-browser', site: 'https://www.dlsite.com/' },
  { id: 'dmm', name: 'DMM GAMES', authMode: 'external-browser', site: 'https://dlsoft.dmm.com/',
    downloadClient: 'https://player.games.dmm.com/' },
  { id: 'fanza', name: 'FANZA', authMode: 'external-browser', site: 'https://www.dmm.co.jp/dc/doujin/' },
]);

export interface StoreLinkCandidate {
  schemaVersion: 1; kind: 'indiedeck-store-link'; provider: StoreProviderId; productId: string; title?: string;
}
export interface StoreConnection {
  id: string; provider: StoreProviderId; productId: string; title: string; managedProductId?: string; gameId?: string; createdAt: string;
}
export interface StoreConnectionsSnapshot { schemaVersion: 1; revision: number; links: StoreConnection[] }
export interface StoreHandoff { url: string; kind: 'browser' | 'official-client'; authentication: 'unverified' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,159}$/;
const CREATOR = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_CREATORS = new Set(['www', 'api', 'static', 'uploads', 'download', 'downloads', 'assets', 'cdn', 'support', 'help', 'status']);
const RESERVED_PATHS = new Set(['download', 'downloads', 'purchase', 'purchases', 'my-purchases', 'orders', 'order', 'login', 'logout', 'register', 'oauth', 'api', 'settings', 'profile', 'edit', 'admin', 'dashboard']);
const LINK_LIMIT = 8192;
const STORE_LIMIT = 2 * 1024 * 1024;
const STORE_FILE = 'store-connections.json';
function fail(reason: string): never { throw new Error(`ui.stores.error.${reason}`); }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function displayTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function provider(value: unknown): StoreProvider {
  const found = STORE_PROVIDERS.find((item) => item.id === value);
  if (!found) fail('invalidProvider');
  return found;
}
function productId(providerId: StoreProviderId, value: unknown): string {
  if (typeof value !== 'string' || value.length > 240) fail('invalidLink');
  if (providerId === 'steam' && /^[1-9][0-9]{0,9}$/.test(value)) return value;
  if (providerId === 'booth' && /^[1-9][0-9]{0,11}$/.test(value)) return value;
  if ((providerId === 'epic' || providerId === 'gog') && SLUG.test(value)) return value;
  if (providerId === 'itch') {
    const parts = value.split('/');
    if (parts.length === 2 && CREATOR.test(parts[0]!) && SLUG.test(parts[1]!) &&
      !RESERVED_CREATORS.has(parts[0]!) && !RESERVED_PATHS.has(parts[1]!)) return value;
  }
  if (providerId === 'dlsite' && /^(?:home|maniax|pro|soft|books):(?:RJ|VJ|BJ)[0-9]{6,12}$/.test(value)) return value;
  fail('invalidLink');
}
/** Declarative page identity only. Reject extra fields rather than accidentally
 * accepting download URLs, auth data, executable paths or installation plans. */
export function parseStoreLink(input: unknown): StoreLinkCandidate {
  if (!object(input) || !keys(input, ['schemaVersion', 'kind', 'provider', 'productId', 'title']) ||
    !['schemaVersion', 'kind', 'provider', 'productId'].every((key) => Object.hasOwn(input, key)) ||
    input.schemaVersion !== 1 || input.kind !== 'indiedeck-store-link' ||
    input.title !== undefined && !displayTitle(input.title)) fail('invalidLink');
  const p = provider(input.provider), id = productId(p.id, input.productId);
  return { schemaVersion: 1, kind: 'indiedeck-store-link', provider: p.id, productId: id,
    ...(typeof input.title === 'string' ? { title: input.title.trim() } : {}) };
}

/** Explicit paste only. Strip URL query/fragment by returning provider identity,
 * and accept exactly the same public product routes as the companion. */
export function parseStoreLinkText(input: unknown): StoreLinkCandidate {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > LINK_LIMIT) fail('linkFileTooLarge');
  const text = input.trim();
  if (text.startsWith('{')) {
    try { return parseStoreLink(JSON.parse(text)); }
    catch { fail('invalidLink'); }
  }
  if (!text || /[\\\u0000-\u0020\u007f]/.test(text)) fail('invalidLink');
  let url: URL;
  try { url = new URL(text); } catch { fail('invalidLink'); }
  const authority = /^https:\/\/([^/?#]*)/i.exec(text)?.[1];
  if (url.protocol !== 'https:' || !authority || /[:@]/.test(authority) || url.username || url.password || url.port ||
      /%(?:2f|5c|00|2e)/i.test(url.pathname)) fail('invalidLink');
  let match: RegExpExecArray | null = null, p: StoreProviderId | undefined, id: string | undefined;
  if (url.hostname === 'store.steampowered.com') {
    match = /^\/app\/([1-9][0-9]{0,9})(?:\/[^/]+)?\/?$/.exec(url.pathname); p = 'steam'; id = match?.[1];
  } else if (url.hostname === 'store.epicgames.com') {
    match = /^\/(?:([^/]+)\/)?p\/([a-z0-9][a-z0-9_-]{0,159})\/?$/.exec(url.pathname);
    if (match && (!match[1] || ['en-us', 'ar', 'de', 'es-es', 'es-mx', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'th', 'tr', 'zh-cn', 'zh-hant'].includes(match[1].toLowerCase()))) { p = 'epic'; id = match[2]; }
  } else if (url.hostname === 'gog.com' || url.hostname === 'www.gog.com') {
    match = /^\/(?:([^/]+)\/)?game\/([a-z0-9][a-z0-9_-]{0,159})\/?$/.exec(url.pathname);
    if (match && (!match[1] || ['en', 'de', 'fr', 'pl', 'ru'].includes(match[1].toLowerCase()))) { p = 'gog'; id = match[2]; }
  } else {
    const itch = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.itch\.io$/.exec(url.hostname);
    if (itch) {
      match = /^\/([a-z0-9][a-z0-9_-]{0,159})\/?$/.exec(url.pathname); p = 'itch'; if (match) id = `${itch[1]}/${match[1]}`;
    } else if (url.hostname === 'booth.pm' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.booth\.pm$/.test(url.hostname)) {
      match = /^\/(?:([a-z]{2})\/)?items\/([1-9][0-9]{0,11})\/?$/.exec(url.pathname);
      if (match && (!match[1] || ['ja', 'en'].includes(match[1]))) { p = 'booth'; id = match[2]; }
    } else if (url.hostname === 'www.dlsite.com' || url.hostname === 'dlsite.com') {
      match = /^\/(home|maniax|pro|soft|books)\/work\/=\/product_id\/((?:RJ|VJ|BJ)[0-9]{6,12})\.html\/?$/.exec(url.pathname);
      if (match) { p = 'dlsite'; id = `${match[1]}:${match[2]}`; }
    }
  }
  if (!p || !id) fail('invalidLink');
  return parseStoreLink({ schemaVersion: 1, kind: 'indiedeck-store-link', provider: p, productId: id });
}
export function canonicalStoreProductUrl(input: Pick<StoreLinkCandidate, 'provider' | 'productId'>): string {
  const p = provider(input.provider), id = productId(p.id, input.productId);
  switch (p.id) {
    case 'steam': return `https://store.steampowered.com/app/${id}/`;
    case 'epic': return `https://store.epicgames.com/en-US/p/${id}`;
    case 'gog': return `https://www.gog.com/en/game/${id}`;
    case 'itch': { const [creator, game] = id.split('/'); return `https://${creator}.itch.io/${game}`; }
    case 'booth': return `https://booth.pm/ja/items/${id}`;
    case 'dlsite': { const [section, work] = id.split(':'); return `https://www.dlsite.com/${section}/work/=/product_id/${work}.html`; }
    default: return fail('invalidLink');
  }
}
export function resolveStoreHandoff(providerId: unknown, action: StoreHandoffAction, link?: Pick<StoreConnection, 'provider' | 'productId'>): StoreHandoff {
  const p = provider(providerId);
  if (link && link.provider !== p.id) fail('invalidLink');
  if (link) productId(p.id, link.productId);
  let url: string | undefined, kind: StoreHandoff['kind'] = 'browser';
  switch (action) {
    case 'site': url = link ? canonicalStoreProductUrl(link) : p.site; break;
    case 'library': url = p.library; break;
    case 'login': url = p.login; break;
    case 'downloadClient': url = p.downloadClient; break;
    case 'client':
      kind = 'official-client';
      if (p.id === 'steam' && link) url = `steam://install/${link.productId}`;
      if (p.id === 'epic' && link) url = `com.epicgames.launcher://store/product/${link.productId}`;
      if (p.id === 'itch') url = 'itch://library';
      break;
  }
  if (!url) fail('invalidAction');
  return { url, kind, authentication: 'unverified' };
}

async function ordinaryDirectory(directory: string, create = false): Promise<void> {
  if (!path.isAbsolute(directory) || /^\\\\[?.]\\/.test(directory) || directory.includes('\0')) fail('linkFileUnsafe');
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  let current = root;
  const paths = [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean).map((part) => { current = path.join(current, part); return current; })];
  for (const target of paths) {
    let stat;
    try { stat = await fsp.lstat(target); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fsp.mkdir(target); stat = await fsp.lstat(target);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('linkFileUnsafe');
  }
}
async function readBounded(file: string, limit: number, tooLarge: string, invalid: string): Promise<unknown> {
  try {
    if (!path.isAbsolute(file) || /^\\\\[?.]\\/.test(file) || file.includes('\0')) fail('linkFileUnsafe');
    await ordinaryDirectory(path.dirname(file));
    const before = await fsp.lstat(file);
    if (before.isSymbolicLink() || !before.isFile()) fail('linkFileUnsafe');
    if (before.size > limit) fail(tooLarge);
    const handle = await fsp.open(file, 'r');
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail('linkFileUnsafe');
      const buffer = Buffer.alloc(limit + 1); let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > limit) fail(tooLarge);
      bytes = buffer.subarray(0, size);
    } finally { await handle.close(); }
    await ordinaryDirectory(path.dirname(file));
    const after = await fsp.lstat(file);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino) fail('linkFileUnsafe');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof Error && /^ui\.stores\.error\./.test(error.message)) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    fail(invalid);
  }
}
export async function readStoreLinkFile(file: string): Promise<StoreLinkCandidate> {
  try { return parseStoreLink(await readBounded(file, LINK_LIMIT, 'linkFileTooLarge', 'linkFileInvalid')); }
  catch (error) {
    if (error instanceof Error && /^ui\.stores\.error\./.test(error.message)) throw error;
    fail('linkFileInvalid');
  }
}
function empty(): StoreConnectionsSnapshot { return { schemaVersion: 1, revision: 0, links: [] }; }
function validate(input: unknown): StoreConnectionsSnapshot {
  if (!object(input) || !keys(input, ['schemaVersion', 'revision', 'links']) || input.schemaVersion !== 1 ||
    !Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || !Array.isArray(input.links) || input.links.length > 5000) fail('connectionsCorrupt');
  const ids = new Set<string>(), products = new Set<string>();
  const links: StoreConnection[] = [];
  for (const value of input.links) {
    if (!object(value) || !keys(value, ['id', 'provider', 'productId', 'title', 'managedProductId', 'gameId', 'createdAt']) ||
      typeof value.id !== 'string' || !UUID.test(value.id) || ids.has(value.id) || !displayTitle(value.title) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      value.managedProductId !== undefined && (typeof value.managedProductId !== 'string' || !UUID.test(value.managedProductId)) ||
      value.gameId !== undefined && (typeof value.gameId !== 'string' || !/^[0-9a-f]{16}$/.test(value.gameId)) ||
      value.gameId !== undefined && value.managedProductId !== undefined) fail('connectionsCorrupt');
    let parsed: StoreLinkCandidate;
    try { parsed = parseStoreLink({ schemaVersion: 1, kind: 'indiedeck-store-link', provider: value.provider, productId: value.productId, title: value.title }); }
    catch { fail('connectionsCorrupt'); }
    const key = `${parsed.provider}:${parsed.productId}`;
    if (products.has(key)) fail('connectionsCorrupt');
    ids.add(value.id); products.add(key);
    links.push({ id: value.id, provider: parsed.provider, productId: parsed.productId, title: parsed.title!, createdAt: value.createdAt,
      ...(typeof value.managedProductId === 'string' ? { managedProductId: value.managedProductId } : {}),
      ...(typeof value.gameId === 'string' ? { gameId: value.gameId } : {}) });
  }
  return { schemaVersion: 1, revision: input.revision as number, links };
}
export async function readStoreConnections(dataDir: string): Promise<StoreConnectionsSnapshot> {
  const directory = path.resolve(dataDir);
  try {
    await ordinaryDirectory(directory, true);
    // Only absence at the initial lookup means an empty store. Disappearance
    // during a bounded read must not reset a previously existing catalog.
    try { await fsp.lstat(path.join(directory, STORE_FILE)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; }
    try { return validate(await readBounded(path.join(directory, STORE_FILE), STORE_LIMIT, 'connectionsCorrupt', 'connectionsCorrupt')); }
    catch { fail('connectionsCorrupt'); }
  } catch (error) {
    fail('connectionsCorrupt');
  }
}
/** Desktop main serialises writers. Separate storage never changes an installed
 * game's payload owner, release, active version or purchase entitlement. */
async function save(dataDir: string, snapshot: StoreConnectionsSnapshot): Promise<StoreConnectionsSnapshot> {
  const next = validate(snapshot), directory = path.resolve(dataDir);
  await ordinaryDirectory(directory, true);
  const existing = await readStoreConnections(directory);
  next.revision = Math.max(existing.revision, next.revision) + 1;
  if (!Number.isSafeInteger(next.revision)) fail('connectionsCorrupt');
  const text = JSON.stringify(next, null, 2);
  if (Buffer.byteLength(text) > STORE_LIMIT) fail('connectionsCorrupt');
  const file = path.join(directory, STORE_FILE), temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temporary, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await ordinaryDirectory(directory);
    await fsp.rename(temporary, file);
    return next;
  } finally { await fsp.rm(temporary, { force: true }); }
}
export async function saveStoreConnection(dataDir: string, input: StoreLinkCandidate, managedProductId?: string, gameId?: string): Promise<StoreConnectionsSnapshot> {
  const candidate = parseStoreLink(input);
  if (managedProductId !== undefined && (typeof managedProductId !== 'string' || !UUID.test(managedProductId))) fail('invalidManagedProduct');
  if (gameId !== undefined && (typeof gameId !== 'string' || !/^[0-9a-f]{16}$/.test(gameId)) || gameId !== undefined && managedProductId !== undefined) fail('invalidManagedProduct');
  const snapshot = await readStoreConnections(dataDir);
  const existing = snapshot.links.find((link) => link.provider === candidate.provider && link.productId === candidate.productId);
  const title = candidate.title ?? existing?.title ?? candidate.productId;
  if (existing) {
    existing.title = title;
    if (managedProductId) existing.managedProductId = managedProductId; else delete existing.managedProductId;
    if (gameId) existing.gameId = gameId; else delete existing.gameId;
  } else {
    snapshot.links.push({ id: crypto.randomUUID(), provider: candidate.provider, productId: candidate.productId, title,
      ...(managedProductId ? { managedProductId } : {}), ...(gameId ? { gameId } : {}), createdAt: new Date().toISOString() });
  }
  return save(dataDir, snapshot);
}
export async function removeStoreConnection(dataDir: string, connectionId: string): Promise<StoreConnectionsSnapshot> {
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) fail('invalidConnection');
  const snapshot = await readStoreConnections(dataDir);
  if (!snapshot.links.some((link) => link.id === connectionId)) fail('invalidConnection');
  snapshot.links = snapshot.links.filter((link) => link.id !== connectionId);
  return save(dataDir, snapshot);
}

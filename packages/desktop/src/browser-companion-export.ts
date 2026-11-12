import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

const COMMON = ['store-link.js', 'artwork.js', 'popup-controller.js', 'popup.js', 'popup.html', 'popup.css',
  'browser-api.js', 'auto-panel-settings.js', 'background.js', 'panel-loader.js', 'page-panel.js'];
const SOURCE = ['manifest.json', 'manifest.firefox.json', ...COMMON, 'README.md'];
const OPTIONAL_HOSTS = ['https://store.steampowered.com/*', 'https://store.epicgames.com/*', 'https://www.gog.com/*', 'https://gog.com/*',
  'https://*.itch.io/*', 'https://booth.pm/*', 'https://*.booth.pm/*', 'https://www.dlsite.com/*', 'https://dlsite.com/*'];
const WEB_RESOURCES = ['page-panel.js', 'popup-controller.js', 'store-link.js', 'artwork.js', 'auto-panel-settings.js', 'browser-api.js'];
const OWNED_FILES = new Set(['README.md', ...['chromium', 'firefox'].flatMap(browser =>
  ['manifest.json', ...COMMON].map(name => `${browser}/${name}`))]);
const MARKER = '.indiedeck-companion.json', JOURNAL = '.indiedeck-companion-update.json';
const MAX_FILE = 128 * 1024, MAX_RECORD = 32 * 1024, MAX_TOTAL = 4 * 1024 * 1024;
const VERSION = /^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const queues = new Map<string, Promise<void>>();
interface OwnerMarker { schemaVersion: 2; launcherVersion: string; extensionVersion: string; files: Record<string, string> }
interface Transaction { schemaVersion: 1; stage: string; backup: string | null; previous: OwnerMarker | null; next: OwnerMarker }
function fail(): never { throw new Error('ui.stores.error.companionExportFailed'); }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function hash(bytes: Buffer): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function validVersion(value: unknown): value is string { return typeof value === 'string' && VERSION.test(value) && value.split('.').every(part => Number(part) <= 65535); }
function sameStat(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink; }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function compareVersions(a: string, b: string): number {
  const av = a.split('.').map(Number), bv = b.split('.').map(Number);
  for (let at = 0; at < 3; at += 1) if (av[at] !== bv[at]) return av[at]! - bv[at]!;
  return 0;
}
async function exists(file: string): Promise<boolean> {
  try { await fsp.lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function directory(target: string, create = false): Promise<void> {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  const paths = [root, ...absolute.slice(root.length).split(path.sep).filter(Boolean).map(part => { current = path.join(current, part); return current; })];
  for (const item of paths) {
    let stat;
    try { stat = await fsp.lstat(item); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await fsp.mkdir(item); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await fsp.lstat(item);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
}
async function boundedFile(file: string, limit = MAX_FILE, owned = false): Promise<Buffer> {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail();
  const handle = await fsp.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || owned && !sameStat(stat, opened)) fail();
    const buffer = Buffer.alloc(limit + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const part = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!part.bytesRead) break;
      bytes += part.bytesRead;
    }
    if (bytes > limit || bytes !== stat.size || (await handle.stat()).size !== stat.size ||
        owned && (!sameStat(opened, await handle.stat()) || !sameStat(opened, await fsp.lstat(file)))) fail();
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}
function marker(input: unknown): OwnerMarker {
  if (!object(input) || !keys(input, ['schemaVersion', 'launcherVersion', 'extensionVersion', 'files']) || input.schemaVersion !== 2 ||
      !validVersion(input.launcherVersion) || !validVersion(input.extensionVersion) || !object(input.files)) fail();
  const names = Object.keys(input.files).sort();
  if (names.length < 3 || names.length > OWNED_FILES.size || !['README.md', 'chromium/manifest.json', 'firefox/manifest.json'].every(name => names.includes(name))) fail();
  const files: Record<string, string> = {};
  for (const name of names) {
    const digest = input.files[name];
    if (!OWNED_FILES.has(name) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) fail();
    files[name] = digest;
  }
  return { schemaVersion: 2, launcherVersion: input.launcherVersion, extensionVersion: input.extensionVersion, files };
}
async function owner(target: string): Promise<OwnerMarker> { return marker(JSON.parse((await boundedFile(path.join(target, MARKER), MAX_RECORD, true)).toString('utf8'))); }
/** Require an exact owned inventory before replacing current. Unknown files,
 * edits, hardlinks and directory links are preserved rather than adopted. */
async function verifyTree(target: string, expected?: OwnerMarker, allowMissing = false): Promise<OwnerMarker> {
  await directory(target);
  const actual = await exists(path.join(target, MARKER)) ? await owner(target) : null;
  if (!actual && (!expected || !allowMissing) || actual && expected && !equal(actual, expected)) fail();
  const record = actual ?? expected!, unseen = new Set([...Object.keys(record.files), MARKER]);
  let count = 0, total = 0;
  const walk = async (root: string, prefix = ''): Promise<void> => {
    for await (const entry of await fsp.opendir(root)) {
      count += 1; if (count > OWNED_FILES.size + 3) fail();
      const name = prefix + entry.name, file = path.join(root, entry.name), stat = await fsp.lstat(file);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) {
        if (prefix || !['chromium', 'firefox'].includes(name)) fail();
        await walk(file, `${name}/`);
      } else {
        if (!unseen.delete(name) || !stat.isFile() || stat.nlink !== 1) fail();
        const bytes = await boundedFile(file, name === MARKER ? MAX_RECORD : MAX_FILE, true);
        total += bytes.length; if (total > MAX_TOTAL) fail();
        if (name === MARKER ? !equal(marker(JSON.parse(bytes.toString('utf8'))), record) : hash(bytes) !== record.files[name]) fail();
        if (['chromium/manifest.json', 'firefox/manifest.json'].includes(name)) {
          const manifest = JSON.parse(bytes.toString('utf8'));
          if (manifest.version !== record.extensionVersion || manifest.manifest_version !== 3) fail();
        }
      }
    }
  };
  await walk(target);
  if (!allowMissing && unseen.size) fail();
  return record;
}
function transaction(input: unknown): Transaction {
  if (!object(input) || !keys(input, ['schemaVersion', 'stage', 'backup', 'previous', 'next']) || input.schemaVersion !== 1 ||
      typeof input.stage !== 'string' || !new RegExp(`^\\.staging-${UUID}$`).test(input.stage) ||
      !(input.backup === null || typeof input.backup === 'string' && new RegExp(`^\\.backup-${UUID}$`).test(input.backup)) ||
      (input.previous === null) !== (input.backup === null)) fail();
  return { schemaVersion: 1, stage: input.stage, backup: input.backup as string | null,
    previous: input.previous === null ? null : marker(input.previous), next: marker(input.next) };
}
async function readTransaction(base: string): Promise<Transaction | null> {
  const file = path.join(base, JOURNAL); if (!await exists(file)) return null;
  return transaction(JSON.parse((await boundedFile(file, MAX_RECORD, true)).toString('utf8')));
}
async function durableFile(file: string, bytes: Buffer): Promise<void> {
  const handle = await fsp.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
/** Remove only journal-named hash-verified files, then empty directories.
 * Allow missing files here so interruption during cleanup can be resumed. */
async function removeVerifiedTree(base: string, target: string, expected: OwnerMarker): Promise<void> {
  if (path.dirname(path.resolve(target)) !== path.resolve(base) || !new RegExp(`^\\.(?:backup|staging)-${UUID}$`).test(path.basename(target))) fail();
  await verifyTree(target, expected, true);
  for (const name of [...Object.keys(expected.files), MARKER]) {
    const file = path.join(target, ...name.split('/')); if (!await exists(file)) continue;
    await directory(path.dirname(file));
    const bytes = await boundedFile(file, name === MARKER ? MAX_RECORD : MAX_FILE, true);
    if (name === MARKER ? !equal(marker(JSON.parse(bytes.toString('utf8'))), expected) : hash(bytes) !== expected.files[name]) fail();
    await fsp.unlink(file);
  }
  for (const browser of ['chromium', 'firefox']) {
    const child = path.join(target, browser); if (await exists(child)) { await directory(child); await fsp.rmdir(child); }
  }
  await directory(base); await directory(target); await fsp.rmdir(target);
}
async function clearTransaction(base: string, expected: Transaction): Promise<void> {
  if (!equal(await readTransaction(base), expected)) fail();
  await directory(base); await fsp.unlink(path.join(base, JOURNAL));
}
/** Recover only the durable transaction. Orphan stages made before the journal
 * was written are left for inspection, and unrelated version dirs are ignored. */
async function recover(base: string): Promise<void> {
  const tx = await readTransaction(base); if (!tx) return;
  const current = path.join(base, 'current'), stage = path.join(base, tx.stage), backup = tx.backup && path.join(base, tx.backup);
  if (await exists(current)) {
    const present = await verifyTree(current);
    if (equal(present, tx.next)) {
      if (await exists(stage)) fail();
      if (backup && await exists(backup)) await removeVerifiedTree(base, backup, tx.previous!);
    } else if (tx.previous && equal(present, tx.previous)) {
      if (backup && await exists(backup)) fail();
      if (await exists(stage)) await removeVerifiedTree(base, stage, tx.next);
    } else fail();
  } else if (backup && await exists(backup)) {
    await verifyTree(backup, tx.previous!); await directory(base); await fsp.rename(backup, current);
    if (await exists(stage)) await removeVerifiedTree(base, stage, tx.next);
  } else if (!tx.previous && await exists(stage)) {
    await verifyTree(stage, tx.next); await directory(base); await fsp.rename(stage, current);
  } else fail();
  await clearTransaction(base, tx);
}
function validateManifests(source: Map<string, Buffer>): string {
  const sameSet = (value: unknown, expected: string[]) => Array.isArray(value) && value.every(item => typeof item === 'string') &&
    value.length === expected.length && equal([...value].sort(), [...expected].sort());
  let extensionVersion = '';
  for (const name of ['manifest.json', 'manifest.firefox.json']) {
    const value = JSON.parse(source.get(name)!.toString('utf8'));
    if (!validVersion(value.version) || value.manifest_version !== 3 ||
        extensionVersion && extensionVersion !== value.version || !sameSet(value.permissions, ['activeTab', 'scripting', 'storage']) ||
        !sameSet(value.optional_host_permissions, OPTIONAL_HOSTS) || 'host_permissions' in value || 'content_scripts' in value ||
        'externally_connectable' in value || 'optional_permissions' in value || !Array.isArray(value.web_accessible_resources) || value.web_accessible_resources.length !== 1 ||
        !object(value.web_accessible_resources[0]) || !keys(value.web_accessible_resources[0], ['resources', 'matches']) ||
        !sameSet(value.web_accessible_resources[0].resources, WEB_RESOURCES) || !sameSet(value.web_accessible_resources[0].matches, OPTIONAL_HOSTS) ||
        !object(value.background) || !keys(value.background, name === 'manifest.json' ? ['service_worker', 'type'] : ['scripts', 'type']) ||
        value.background.type !== 'module' || (name === 'manifest.json' ? value.background.service_worker !== 'background.js' : !sameSet(value.background.scripts, ['background.js']))) fail();
    extensionVersion = value.version;
  }
  return extensionVersion;
}
async function runExport(appPath: string, dataDir: string, launcherVersion: string): Promise<string> {
  if (!validVersion(launcherVersion) || !path.isAbsolute(dataDir)) fail();
  const source = new Map(await Promise.all(SOURCE.map(async name =>
    [name, await boundedFile(path.join(appPath, 'extensions', 'browser-companion', name))] as const)));
  const extensionVersion = validateManifests(source), files = new Map<string, Buffer>([['README.md', source.get('README.md')!]]);
  for (const browser of ['chromium', 'firefox']) {
    files.set(`${browser}/manifest.json`, source.get(browser === 'chromium' ? 'manifest.json' : 'manifest.firefox.json')!);
    for (const name of COMMON) files.set(`${browser}/${name}`, source.get(name)!);
  }
  if ([...files.values()].reduce((total, bytes) => total + bytes.length, 0) > MAX_TOTAL) fail();
  const next = marker({ schemaVersion: 2, launcherVersion, extensionVersion,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])) });
  files.set(MARKER, Buffer.from(JSON.stringify(next, null, 2)));
  const base = path.join(path.resolve(dataDir), 'browser-companion'), current = path.join(base, 'current');
  await directory(base, true); await recover(base);
  const previous = await exists(current) ? await verifyTree(current) : null;
  if (previous) {
    if (compareVersions(extensionVersion, previous.extensionVersion) < 0) fail();
    // Launcher-only version changes do not rewrite identical extension assets.
    if (previous.extensionVersion === extensionVersion && equal(previous.files, next.files)) return current;
  }
  const stageName = `.staging-${crypto.randomUUID()}`, backupName = previous ? `.backup-${crypto.randomUUID()}` : null;
  const stage = path.join(base, stageName), backup = backupName && path.join(base, backupName);
  await fsp.mkdir(stage);
  for (const browser of ['chromium', 'firefox']) await fsp.mkdir(path.join(stage, browser));
  for (const [name, bytes] of files) await durableFile(path.join(stage, ...name.split('/')), bytes);
  await verifyTree(stage, next); await directory(base);
  if (previous) await verifyTree(current, previous);
  const tx: Transaction = { schemaVersion: 1, stage: stageName, backup: backupName, previous, next };
  await durableFile(path.join(base, JOURNAL), Buffer.from(JSON.stringify(tx)));
  try {
    if (backup) await fsp.rename(current, backup);
    await fsp.rename(stage, current); await verifyTree(current, next);
    if (backup) await removeVerifiedTree(base, backup, previous!);
    await clearTransaction(base, tx);
  } catch {
    await recover(base).catch(() => {}); fail();
  }
  return current;
}

/** Fixed developer-extension path, independent extension version. Browser
 * profiles and old versioned directories are never changed by this exporter. */
export function exportBrowserCompanion(appPath: string, dataDir: string, launcherVersion: string): Promise<string> {
  const key = path.resolve(dataDir), previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(() => runExport(appPath, dataDir, launcherVersion)).catch(() => fail());
  const settled = result.then(() => {}, () => {}); queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return result;
}

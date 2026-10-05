import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  detectGame, downloadAsset, readZipEntries, resolvePlans, type ApplyProgress, type DownloadOptions, type GameProfile,
  type InstallReceipt, type ReceiptEntry, type Registry, type ResolveOptions, type TranslatorPlan,
} from '@indiedeck/core';
import { readSafeRemovalReceipts } from './receipt-guard.ts';

const COMPONENT = 'xunity-autotranslator';
const RECEIPT = `.indiedeck/receipts/translator-${COMPONENT}.json`;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const KEY = 'ui.maintenance.reason.';

export interface TranslatorMaintenanceFile { path: string; size: number; sha256: string; managed: boolean }
export interface TranslatorMaintenancePreview {
  supported: boolean;
  eligible: boolean;
  removeEligible: boolean;
  reinstallEligible: boolean;
  blockReasonKey?: string;
  reinstallBlockReasonKey?: string;
  files: TranslatorMaintenanceFile[];
  currentVersions: string[];
  version?: string;
  variantId?: string;
  preservedPaths: string[];
  fingerprint: string;
  /** Main-process authority only. Never accept or reconstruct this from renderer input. */
  context: { registry: Registry; profile: GameProfile; options: ResolveOptions; receipts: InstallReceipt[]; plan?: TranslatorPlan; fingerprintParts: unknown[] };
}
export interface TranslatorMaintenanceResult {
  mode: 'remove' | 'reinstall';
  removed: string[];
  filesWritten: string[];
  backupDirectory: string;
  manifestPath: string;
  receipts: InstallReceipt[];
  mutationStatus: 'committed' | 'rolled-back' | 'partial';
  rollbackStatus: 'complete' | 'partial' | 'not-run';
  rollbackFailures: { path: string; operation: 'create' | 'modify'; error: string }[];
  receiptStatus: 'complete' | 'failed' | 'not-run';
  pendingUserActions: string[];
  failedStep?: string;
  receiptError?: string;
}
export interface TranslatorMaintenanceOptions extends DownloadOptions { onEvent?: (event: ApplyProgress) => void }

const stems = [
  'XUnity.AutoTranslator.Plugin.Core', 'XUnity.AutoTranslator.Plugin.ExtProtocol',
  'XUnity.AutoTranslator.Plugin.BepInEx', 'XUnity.AutoTranslator.Plugin.BepInEx-IL2CPP',
  'XUnity.AutoTranslator.Plugin.BepInEx_IL2CPP', 'XUnity.AutoTranslator.Plugin.MelonMod',
  'XUnity.Common', 'XUnity.ResourceRedirector', 'ExIni',
];
const endpointStems = [
  'BaiduTranslate', 'BingTranslate', 'BingTranslateLegitimate', 'CustomTranslate', 'DeepLTranslate',
  'GoogleTranslate', 'GoogleTranslateCompat', 'GoogleTranslateLegitimate', 'LecPowerTranslator15',
  'LingoCloudTranslate', 'PapagoTranslate', 'ReverseTranslator', 'WatsonTranslate', 'YandexTranslate', 'ezTransXP',
];
const fullNetStems = [
  'Common.ExtProtocol', 'DeepLTranslate.ExtProtocol', 'GoogleTranslateCompat.ExtProtocol', 'Http.ExtProtocol',
  'Lec.ExtProtocol', 'ezTransXP.ExtProtocol', 'Newtonsoft.Json',
];
const extensions = ['dll', 'xml', 'pdb'];
const key = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
const digest = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');
const fail = (reason: string): never => { throw new Error(KEY + reason); };

function relative(value: string): string {
  const normal = value.replace(/\\/g, '/');
  if (!normal || normal.startsWith('/') || /^[a-z]:/i.test(normal) ||
      normal.split('/').some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f<>:"|?*]/.test(part) || /[ .]$/.test(part))) fail('linkedPath');
  return normal;
}

/** Fixed upstream component names, not a recursive-delete prefix or an arbitrary DLL wildcard. */
function payloadNames(): Map<string, string> {
  const names = new Map<string, string>();
  const add = (name: string) => names.set(key(name), name);
  const addStem = (dir: string, stem: string) => extensions.forEach((ext) => add(`${dir}/${stem}.${ext}`));
  for (const stem of stems) {
    addStem('BepInEx/plugins/XUnity.AutoTranslator', stem);
    addStem('UserLibs', stem);
  }
  for (const stem of ['XUnity.Common']) addStem('BepInEx/core', stem);
  for (const stem of ['XUnity.ResourceRedirector', 'XUnity.ResourceRedirector.BepInEx', 'XUnity.ResourceRedirector.BepInEx-IL2CPP', 'XUnity.ResourceRedirector.BepInEx_IL2CPP']) {
    addStem('BepInEx/plugins/XUnity.ResourceRedirector', stem);
  }
  for (const stem of ['XUnity.AutoTranslator.Plugin.Core', 'XUnity.AutoTranslator.Plugin.BepInEx', 'XUnity.AutoTranslator.Plugin.BepInEx-IL2CPP', 'XUnity.AutoTranslator.Plugin.ExtProtocol']) addStem('BepInEx/plugins', stem);
  addStem('Mods', 'XUnity.AutoTranslator.Plugin.MelonMod');
  for (const dir of ['UnityInjector', 'Plugins']) addStem(dir, 'XUnity.AutoTranslator.Plugin.Core');
  for (const base of ['BepInEx/plugins/XUnity.AutoTranslator/Translators', 'UserLibs/Translators']) {
    endpointStems.forEach((stem) => addStem(base, stem));
    fullNetStems.forEach((stem) => addStem(`${base}/FullNET`, stem));
    add(`${base}/FullNET/Common.ExtProtocol.Executor.exe`);
    add(`${base}/FullNET/Common.ExtProtocol.Executor.exe.config`);
    add(`${base}/FullNET/ezTransXP.ExtProtocol.exe`);
    add(`${base}/FullNET/Lec.ExtProtocol.exe`);
    addStem(`${base}/FullNET`, 'XUnity.AutoTranslator.Plugin.ExtProtocol');
  }
  add('BepInEx/plugins/README (AutoTranslator).md');
  add('Mods/README (AutoTranslator).md');
  return names;
}
const PAYLOAD = payloadNames();
// These runtime libraries are also used by unrelated plugins. An unmanaged
// copy is never cleanup authority; new copies may be installed only if absent.
const SHARED = new Map(['MonoMod.RuntimeDetour', 'MonoMod.Utils', 'Mono.Cecil'].flatMap((stem) =>
  extensions.map((ext) => { const name = `BepInEx/core/${stem}.${ext}`; return [key(name), name] as const; })));
const sharedXUnityComponents = new Set([
  'XUnity.Common', 'XUnity.ResourceRedirector', 'XUnity.ResourceRedirector.BepInEx',
  'XUnity.ResourceRedirector.BepInEx-IL2CPP', 'XUnity.ResourceRedirector.BepInEx_IL2CPP',
]);
// XUnity.Common/ResourceRedirector also ship independently of AutoTranslator.
// A familiar name alone never authorises deleting a standalone/shared install.
for (const [normal, canonical] of PAYLOAD) {
  if (sharedXUnityComponents.has(path.posix.basename(canonical).replace(/\.(?:dll|xml|pdb)$/i, ''))) {
    SHARED.set(normal, canonical);
    PAYLOAD.delete(normal);
  }
}
const STRICT_TREES = ['BepInEx/plugins/XUnity.AutoTranslator', 'BepInEx/plugins/XUnity.ResourceRedirector'];

async function statOrMissing(file: string) {
  try { return await fsp.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Check every ancestor, including ancestors of the game root and Windows junctions. */
async function noLinks(root: string, rel?: string): Promise<void> {
  if (!path.isAbsolute(root) || /^(?:\\\\[?.]\\|\/\/\?\/)/.test(root)) fail('linkedPath');
  const absolute = path.resolve(root);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const pieces = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (rel) pieces.push(...relative(rel).split('/'));
  for (const [index, part] of pieces.entries()) {
    current = path.join(current, part);
    const stat = await statOrMissing(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || (index < pieces.length - 1 && !stat.isDirectory())) fail('linkedPath');
  }
  const rootStat = await statOrMissing(absolute);
  if (!rootStat?.isDirectory()) fail('linkedPath');
}

async function readRegular(root: string, rel: string): Promise<Buffer | undefined> {
  await noLinks(root, rel);
  const file = path.join(root, relative(rel));
  const before = await statOrMissing(file);
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE) fail('unknownFile');
  const handle = await fsp.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail('stale');
    // Read at most the already validated size, plus a one-byte growth probe.
    // readFile() could otherwise allocate an unbounded file grown after stat().
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, null);
      if (!bytesRead) fail('stale');
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0) fail('stale');
    const after = await handle.stat();
    await noLinks(root, rel);
    const final = await fsp.lstat(file);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        final.dev !== after.dev || final.ino !== after.ino || final.size !== after.size || final.mtimeMs !== after.mtimeMs) fail('stale');
    return content;
  } finally { await handle.close(); }
}

async function writeNew(root: string, rel: string, data: Buffer | string, changed: Set<string>): Promise<void> {
  await noLinks(root, rel);
  await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  // A failed exclusive open has not touched the target and must not journal a
  // competitor's newly-created file for rollback deletion.
  const handle = await fsp.open(path.join(root, rel), 'wx');
  changed.add(rel);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}

async function replaceReceipt(root: string, content: string, expected: Buffer | undefined, changed: Set<string>): Promise<void> {
  if (!expected) { await writeNew(root, RECEIPT, content, changed); return; }
  await noLinks(root, RECEIPT);
  const before = await fsp.lstat(path.join(root, RECEIPT));
  if (!before.isFile() || before.isSymbolicLink()) fail('stale');
  const handle = await fsp.open(path.join(root, RECEIPT), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || digest(await handle.readFile()) !== digest(expected)) fail('stale');
    await noLinks(root, RECEIPT);
    changed.add(RECEIPT);
    await handle.truncate(0);
    await handle.write(Buffer.from(content), 0, Buffer.byteLength(content), 0);
  } finally { await handle.close(); }
}

async function pruneEmptyPayloadFolders(root: string): Promise<void> {
  // rmdir is non-recursive and fails if any user-added file remains. Never prune
  // shared host roots (BepInEx, plugins, Mods, UserLibs, Plugins, or game data).
  for (const rel of [
    'BepInEx/plugins/XUnity.AutoTranslator/Translators/FullNET',
    'BepInEx/plugins/XUnity.AutoTranslator/Translators', ...STRICT_TREES,
  ]) {
    try { await noLinks(root, rel); await fsp.rmdir(path.join(root, rel)); }
    catch { /* non-empty or absent folders are preserved */ }
  }
}

async function checkTree(root: string, rel: string): Promise<void> {
  await noLinks(root, rel);
  const stat = await statOrMissing(path.join(root, rel));
  if (!stat) return;
  if (!stat.isDirectory()) fail('unknownFile');
  for (const entry of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) fail('linkedPath');
    if (entry.isDirectory()) await checkTree(root, child);
    else if (!entry.isFile() || (!PAYLOAD.has(key(child)) && !SHARED.has(key(child)))) fail('unknownFile');
  }
}

function allowedForPlan(name: string, plan: TranslatorPlan): boolean {
  const normal = key(name);
  if (!PAYLOAD.has(normal) && !SHARED.has(normal)) return false;
  if (plan.variantId.startsWith('bepinex')) return normal.startsWith('bepinex/');
  if (plan.variantId.startsWith('melonmod')) return normal.startsWith('mods/') || normal.startsWith('userlibs/');
  return false;
}

function preservedNames(registry: Registry, profile: GameProfile): string[] {
  const translator = registry.translators.find((item) => item.id === COMPONENT);
  return [...new Set([
    ...(profile.executable ? [profile.executable] : []),
    ...(translator?.variants.flatMap((variant) => variant.configCandidates ?? []) ?? []),
    ...registry.fonts.bundles.map((font) => font.file),
    'BepInEx/Translation', 'AutoTranslator/Translation', 'Translation', 'UserData/AutoTranslator',
  ])];
}

/** Read-only preview. A failed check never becomes permission to remove a broader folder. */
export async function previewTranslatorMaintenance(
  registry: Registry, profile: GameProfile, options: ResolveOptions = {},
): Promise<TranslatorMaintenancePreview> {
  const preview: TranslatorMaintenancePreview = {
    supported: profile.engineId === 'unity', eligible: false, removeEligible: false, reinstallEligible: false,
    files: [], currentVersions: [], preservedPaths: preservedNames(registry, profile), fingerprint: '',
    context: { registry, profile, options: { ...options, includeFont: false }, receipts: [], fingerprintParts: [] },
  };
  try {
    if (!preview.supported) fail('unsupported');
    const root = path.resolve(profile.path);
    await noLinks(root);
    await noLinks(root, '.indiedeck/backups');
    let receipts: InstallReceipt[];
    try { receipts = await readSafeRemovalReceipts(root, profile.executable ? [profile.executable] : []); }
    catch { fail('receipt'); }
    preview.context.receipts = receipts!;
    const own = receipts!.filter((receipt) => receipt.kind === 'translator' && receipt.componentId === COMPONENT);
    if (own.length > 1) fail('receipt');
    const owned = new Set(own.flatMap((receipt) => receipt.entries.map((entry) => key(entry.path))));
    const preserved = new Set(preview.preservedPaths.map(key));
    const protectedExe = profile.executable ? key(profile.executable) : undefined;
    for (const receipt of own) {
      for (const entry of receipt.entries) {
        if (!PAYLOAD.has(key(entry.path)) && !SHARED.has(key(entry.path)) && !preserved.has(key(entry.path))) fail('ownership');
        if (entry.operation === 'snapshot') fail('ownership');
        if (entry.backup && !(await readRegular(root, entry.backup))) fail('receipt');
      }
    }
    // ReiPatcher rewrites game assemblies. Its setup and patcher are not a removable plugin.
    for (const rel of ['ReiPatcher/ReiPatcher.exe', 'SetupReiPatcherAndAutoTranslator.exe', 'AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll']) {
      if (await statOrMissing(path.join(root, rel))) fail('host');
    }
    for (const tree of STRICT_TREES) await checkTree(root, tree);
    const fingerprintParts: unknown[] = [{ engine: profile.engineId, backend: profile.unity?.backend, arch: profile.arch, unity: profile.unity?.version, loaders: profile.installedLoaders }];
    let observedPayloadBytes = 0;
    for (const canonical of PAYLOAD.values()) {
      const content = await readRegular(root, canonical);
      if (!content) continue;
      observedPayloadBytes += content.length;
      if (observedPayloadBytes > MAX_ARCHIVE) fail('unknownFile');
      if (protectedExe === key(canonical)) fail('ownership');
      if (receipts!.some((receipt) => !(receipt.kind === 'translator' && receipt.componentId === COMPONENT) &&
          receipt.entries.some((entry) => key(entry.path) === key(canonical)))) fail('ownership');
      preview.files.push({ path: canonical, size: content.length, sha256: digest(content), managed: owned.has(key(canonical)) });
      // DLL version resources are evidence only, never used as write authority.
      const version = /ProductVersion\0*([0-9]+(?:\.[0-9]+){1,3})/.exec(content.toString('utf16le'))?.[1];
      if (version) preview.currentVersions.push(version);
      fingerprintParts.push([canonical, digest(content)]);
    }
    const unmanagedShared = new Set<string>();
    for (const canonical of SHARED.values()) {
      const content = await readRegular(root, canonical);
      if (!content) continue;
      observedPayloadBytes += content.length;
      if (observedPayloadBytes > MAX_ARCHIVE) fail('unknownFile');
      fingerprintParts.push([canonical, digest(content)]);
      const entry = own.flatMap((receipt) => receipt.entries).find((item) => key(item.path) === key(canonical));
      if (!entry) {
        unmanagedShared.add(key(canonical));
        preview.preservedPaths.push(canonical);
        continue; // Preserve standalone XUnity components and other shared runtime libraries.
      }
      if (entry.sha256 !== digest(content) || receipts!.some((receipt) => !(receipt.kind === 'translator' && receipt.componentId === COMPONENT) &&
          receipt.entries.some((item) => key(item.path) === key(canonical)))) fail('ownership');
      preview.files.push({ path: canonical, size: content.length, sha256: digest(content), managed: true });
    }
    for (const receipt of receipts!) {
      const rel = `.indiedeck/receipts/${receipt.kind}-${receipt.componentId}.json`;
      fingerprintParts.push([rel, digest((await readRegular(root, rel))!)]);
      for (const entry of receipt.entries) if (entry.backup) {
        const baseline = await readRegular(root, entry.backup);
        fingerprintParts.push([entry.backup, baseline ? digest(baseline) : null]);
      }
    }
    for (const rel of [...preview.preservedPaths, ...profile.installedLoaders.flatMap((loader) => loader.markers)]) {
      await noLinks(root, rel);
      const stat = await statOrMissing(path.join(root, rel));
      if (stat?.isFile()) fingerprintParts.push([rel, digest((await readRegular(root, rel))!)]);
    }
    preview.currentVersions = [...new Set(preview.currentVersions)];
    preview.files.sort((a, b) => a.path.localeCompare(b.path));
    if (!preview.files.length) fail('absent');
    const candidateProfile = { ...profile, installedTranslators: [] };
    const plans = resolvePlans(registry, candidateProfile, { ...options, translatorId: COMPONENT, includeFont: false });
    const plan = plans.find((candidate) => candidate.viable && candidate.loader?.alreadyInstalled &&
      ['bepinex', 'bepinex-il2cpp', 'melonmod', 'melonmod-il2cpp'].includes(candidate.variantId) &&
      candidate.steps.every((step) => (step.action === 'download' || step.action === 'extract' || step.action === 'config' ||
        (step.action === 'manual' && step.details?.['informational'] === true)) && !step.details?.['loaderId']) &&
      candidate.steps.filter((step) => step.action === 'download').length === 1 &&
      candidate.steps.filter((step) => step.action === 'extract').length === 1 &&
      candidate.steps.find((step) => step.action === 'extract')?.dest === '.');
    preview.context.fingerprintParts = fingerprintParts;
    preview.context.plan = plan;
    const guaranteedShared = plan?.variantId.startsWith('bepinex') ? [
      'BepInEx/core/XUnity.Common.dll',
      'BepInEx/plugins/XUnity.ResourceRedirector/XUnity.ResourceRedirector.dll',
      `BepInEx/plugins/XUnity.ResourceRedirector/XUnity.ResourceRedirector.${plan.variantId === 'bepinex-il2cpp' ? 'BepInEx-IL2CPP' : 'BepInEx'}.dll`,
    ] : plan?.variantId.startsWith('melonmod') ? ['UserLibs/XUnity.Common.dll', 'UserLibs/XUnity.ResourceRedirector.dll'] : [];
    const sharedConflict = guaranteedShared.some((name) => unmanagedShared.has(key(name)));
    if (plan) { preview.version = plan.version; preview.variantId = plan.variantId; }
    else preview.reinstallBlockReasonKey = KEY + 'host';
    if (sharedConflict) preview.reinstallBlockReasonKey = KEY + 'ownership';
    preview.fingerprint = digest(JSON.stringify([fingerprintParts, plan?.variantId, plan?.version]));
    preview.eligible = preview.removeEligible = true;
    preview.reinstallEligible = Boolean(plan) && !sharedConflict;
  } catch (error) {
    const message = (error as Error).message;
    preview.blockReasonKey = message.startsWith(KEY) ? message : KEY + 'receipt';
    preview.reinstallBlockReasonKey = preview.blockReasonKey;
  }
  return preview;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate headers/attributes first, then inflate each member with an allocation bound. */
function boundedZipData(buffer: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1;
  for (let position = buffer.length - 22; position >= Math.max(0, buffer.length - 65557); position -= 1) {
    if (buffer.readUInt32LE(position) === 0x06054b50 && position + 22 + buffer.readUInt16LE(position + 20) === buffer.length) { eocd = position; break; }
  }
  if (eocd < 0 || buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0 ||
      buffer.readUInt16LE(eocd + 8) !== buffer.readUInt16LE(eocd + 10)) fail('archive');
  const cdOffset = buffer.readUInt32LE(eocd + 16), cdSize = buffer.readUInt32LE(eocd + 12);
  if (cdOffset + cdSize !== eocd) fail('archive');
  let entries;
  try { entries = readZipEntries(buffer); } catch { fail('archive'); }
  if (entries!.length > 2000) fail('archive');
  const files: { name: string; data: Buffer }[] = [];
  const ranges: [number, number][] = [];
  let central = cdOffset, total = 0;
  for (const entry of entries!) {
    if (central + 46 > eocd || buffer.readUInt32LE(central) !== 0x02014b50) fail('archive');
    const nameLength = buffer.readUInt16LE(central + 28), extraLength = buffer.readUInt16LE(central + 30), commentLength = buffer.readUInt16LE(central + 32);
    const flags = buffer.readUInt16LE(central + 8), attributes = buffer.readUInt32LE(central + 38);
    const unixType = (attributes >>> 16) & 0xf000;
    if (central + 46 + nameLength + extraLength + commentLength > eocd || (flags & ~0x080e) !== 0 ||
        buffer.readUInt16LE(central + 34) !== 0 || (attributes & 0x0400) !== 0 ||
        (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) ||
        (unixType === 0x4000 && !entry.isDirectory) || ((attributes & 0x10) !== 0 && !entry.isDirectory)) fail('archive');
    const name = relative(entry.name.replace(/[\\/]$/, ''));
    if (entry.uncompressedSize > MAX_FILE || (entry.method !== 0 && entry.method !== 8) || entry.offset + 30 > cdOffset ||
        buffer.readUInt32LE(entry.offset) !== 0x04034b50 || buffer.readUInt16LE(entry.offset + 6) !== flags || buffer.readUInt16LE(entry.offset + 8) !== entry.method) fail('archive');
    const localNameLength = buffer.readUInt16LE(entry.offset + 26), localExtraLength = buffer.readUInt16LE(entry.offset + 28);
    const start = entry.offset + 30 + localNameLength + localExtraLength, end = start + entry.compressedSize;
    if (end > cdOffset || buffer.toString('utf8', entry.offset + 30, entry.offset + 30 + localNameLength) !== entry.name ||
        (!(flags & 8) && (buffer.readUInt32LE(entry.offset + 14) !== entry.crc32 || buffer.readUInt32LE(entry.offset + 18) !== entry.compressedSize || buffer.readUInt32LE(entry.offset + 22) !== entry.uncompressedSize))) fail('archive');
    if (ranges.some(([priorStart, priorEnd]) => entry.offset < priorEnd && end > priorStart)) fail('archive');
    ranges.push([entry.offset, end]);
    central += 46 + nameLength + extraLength + commentLength;
    if (entry.isDirectory) {
      if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) fail('archive');
      try {
        const directoryData = entry.method === 0 ? buffer.subarray(start, end) : zlib.inflateRawSync(buffer.subarray(start, end), { maxOutputLength: 1 });
        if (directoryData.length !== 0) fail('archive');
      } catch { fail('archive'); }
      continue;
    }
    let data: Buffer;
    try { data = entry.method === 0 ? Buffer.from(buffer.subarray(start, end)) : zlib.inflateRawSync(buffer.subarray(start, end), { maxOutputLength: MAX_FILE }); }
    catch { fail('archive'); }
    total += data!.length;
    if (data!.length !== entry.uncompressedSize || total > MAX_ARCHIVE || crc32(data!) !== entry.crc32) fail('archive');
    files.push({ name, data: data! });
  }
  if (central !== eocd) fail('archive');
  return files;
}

async function preparePayload(preview: TranslatorMaintenancePreview, options: TranslatorMaintenanceOptions): Promise<Map<string, Buffer>> {
  const plan = preview.context.plan;
  if (!plan) fail('host');
  const source = plan!.steps.find((step) => step.action === 'download')?.source;
  if (!source) fail('archive');
  const download = await downloadAsset(source!, options);
  const stat = await fsp.lstat(download.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE || !download.path.toLowerCase().endsWith('.zip')) fail('archive');
  const buffer = await fsp.readFile(download.path);
  if (digest(buffer) !== download.sha256) fail('archive');
  const payload = new Map<string, Buffer>();
  for (const { name, data } of boundedZipData(buffer)) {
    if (!allowedForPlan(name, plan!) || [...payload.keys()].some((prior) => key(prior) === key(name))) fail('archive');
    // The exact allowlist spelling avoids ambiguous case-colliding writes on Windows.
    payload.set((PAYLOAD.get(key(name)) ?? SHARED.get(key(name)))!, data);
  }
  if (![...payload.keys()].some((name) => /XUnity\.AutoTranslator\.Plugin\.(?:Core|MelonMod)\.dll$/i.test(name))) fail('archive');
  return payload;
}

function inheritEntries(old: InstallReceipt | undefined, written: Map<string, Buffer>): ReceiptEntry[] {
  const prior = new Map((old?.entries ?? []).map((entry) => [key(entry.path), entry]));
  // Retain untouched config/font entries and original install baselines. Old payloads absent
  // from the new package are intentionally not retained, so uninstall cannot resurrect them.
  const entries = (old?.entries ?? []).filter((entry) =>
    (!PAYLOAD.has(key(entry.path)) && !SHARED.has(key(entry.path))) ||
    (entry.operation === 'modify' && ![...written.keys()].some((name) => key(name) === key(entry.path))))
    .map((entry) => ({ ...entry }));
  for (const [name, data] of written) {
    const previous = prior.get(key(name));
    entries.push({
      path: name, operation: previous?.operation === 'modify' ? 'modify' : 'create', sha256: digest(data),
      ...(previous?.operation === 'modify' && previous.backup ? { backup: previous.backup } : {}),
    });
  }
  return entries;
}

/**
 * Exact-file maintenance with a retained pre-operation quarantine. No executable is run,
 * no whole mod directory is deleted, and config/translation/font bytes are never written.
 */
export async function runTranslatorMaintenance(
  authorised: TranslatorMaintenancePreview, mode: 'remove' | 'reinstall', options: TranslatorMaintenanceOptions = {},
): Promise<TranslatorMaintenanceResult> {
  if (mode !== 'remove' && mode !== 'reinstall') fail('unsupported');
  if (!authorised.removeEligible || (mode === 'reinstall' && !authorised.reinstallEligible)) {
    throw new Error(authorised.blockReasonKey ?? authorised.reinstallBlockReasonKey ?? KEY + 'host');
  }
  const { registry, profile } = authorised.context;
  const root = path.resolve(profile.path);
  const revalidate = async () => {
    await noLinks(root);
    const currentProfile = detectGame(registry, root, { deep: true });
    if (!currentProfile || currentProfile.engineId !== profile.engineId || currentProfile.executable !== profile.executable) fail('stale');
    return previewTranslatorMaintenance(registry, currentProfile!, authorised.context.options);
  };
  const fresh = await revalidate();
  if (!fresh.removeEligible || fresh.fingerprint !== authorised.fingerprint || (mode === 'reinstall' && !fresh.reinstallEligible)) fail('stale');
  const result: TranslatorMaintenanceResult = {
    mode, removed: [], filesWritten: [], backupDirectory: '', manifestPath: '', receipts: [],
    mutationStatus: 'rolled-back', rollbackStatus: 'not-run', rollbackFailures: [], receiptStatus: 'not-run', pendingUserActions: [],
  };
  const emit = (phase: ApplyProgress['phase'], status: ApplyProgress['status'], description: string, extra: Partial<ApplyProgress> = {}) => {
    try { options.onEvent?.({ phase, status, description, stepIndex: phase === 'preflight' ? 1 : phase === 'backup' ? 3 : phase === 'receipt' ? 5 : 4, stepCount: 5, ...extra }); }
    catch { /* observers are not transaction authority */ }
  };
  emit('preflight', 'completed', 'Validate exact XUnity.AutoTranslator files');
  let payload = new Map<string, Buffer>();
  // Download and validate the COMPLETE archive before touching any old payload.
  if (mode === 'reinstall') payload = await preparePayload(fresh, {
    ...options,
    onDownloadEvent: (event) => {
      emit(event.phase, event.status, 'Download compatible XUnity.AutoTranslator', { stepIndex: 2, assetId: event.assetId, received: event.received, total: event.total, fromCache: event.fromCache, integrity: event.integrity });
      try { options.onDownloadEvent?.(event); } catch { /* best effort */ }
    },
  });
  const afterDownload = await revalidate();
  if (!afterDownload.removeEligible || afterDownload.fingerprint !== authorised.fingerprint) fail('stale');
  const old = fresh.context.receipts.find((receipt) => receipt.kind === 'translator' && receipt.componentId === COMPONENT);
  const snapshots = new Map<string, Buffer | undefined>();
  let snapshotBytes = 0;
  for (const rel of new Set([...fresh.files.map((file) => file.path), ...payload.keys(), ...(old ? [RECEIPT] : mode === 'reinstall' ? [RECEIPT] : [])])) {
    const content = await readRegular(root, rel);
    if (payload.has(rel) && content && !fresh.files.some((file) => key(file.path) === key(rel))) fail('ownership');
    snapshotBytes += content?.length ?? 0;
    if (snapshotBytes > MAX_ARCHIVE) fail('unknownFile');
    snapshots.set(rel, content);
  }
  const backupRel = `.indiedeck/backups/maintenance-${crypto.randomUUID()}`;
  result.backupDirectory = path.join(root, backupRel);
  result.manifestPath = path.join(result.backupDirectory, 'manifest.json');
  await noLinks(root, backupRel);
  await fsp.mkdir(result.backupDirectory, { recursive: true });
  const manifest = {
    schemaVersion: 1, id: path.basename(backupRel), componentId: COMPONENT, mode,
    createdAt: new Date().toISOString(), gamePath: root, fingerprint: fresh.fingerprint,
    status: 'prepared', preservedPaths: fresh.preservedPaths,
    files: [...snapshots].map(([rel, content]) => ({ path: rel, existed: Boolean(content), sha256: content ? digest(content) : undefined, backup: content ? `files/${rel}` : undefined })),
  };
  emit('backup', 'started', 'Retain exact pre-operation files and install metadata');
  for (const [rel, content] of snapshots) if (content) {
    const backup = `${backupRel}/files/${rel}`;
    await noLinks(root, backup);
    await fsp.mkdir(path.dirname(path.join(root, backup)), { recursive: true });
    await fsp.writeFile(path.join(root, backup), content, { flag: 'wx' });
    if (digest((await readRegular(root, backup))!) !== digest(content)) fail('receipt');
  }
  await fsp.writeFile(result.manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  emit('backup', 'completed', 'Retained backup and manifest');
  const changed = new Set<string>();
  let writingReceipt = false;
  try {
    // Revalidate after backup creation; the new quarantine is not part of the authority hash.
    const beforeRemove = await revalidate();
    if (!beforeRemove.removeEligible || beforeRemove.fingerprint !== authorised.fingerprint) fail('stale');
    emit('extract', 'started', 'Remove only recognised translator payload files');
    for (const file of fresh.files) {
      const current = await readRegular(root, file.path);
      if (!current || digest(current) !== file.sha256) fail('stale');
      changed.add(file.path);
      await fsp.unlink(path.join(root, file.path));
      result.removed.push(file.path);
    }
    for (const [rel, data] of payload) {
      await noLinks(root, rel);
      if (await statOrMissing(path.join(root, rel))) fail('stale');
      await writeNew(root, rel, data, changed);
      if (digest((await readRegular(root, rel))!) !== digest(data)) fail('stale');
      result.filesWritten.push(rel);
    }
    emit('extract', 'completed', mode === 'remove' ? 'Translator payload removed; user data preserved' : 'Compatible payload installed; user settings preserved');
    writingReceipt = true;
    emit('receipt', 'started', 'Record maintenance ownership without replacing the original baseline');
    if (mode === 'reinstall') {
      const plan = fresh.context.plan!;
      const receipt: InstallReceipt = {
        id: crypto.randomUUID(), schemaVersion: 2, gamePath: root, kind: 'translator', componentId: COMPONENT,
        variantId: plan.variantId, version: plan.version,
        // Keep the original installation chronology so unchanged font-overlay receipts
        // remain attributable to the same config baseline after payload-only maintenance.
        installedAt: old?.installedAt ?? new Date().toISOString(), entries: inheritEntries(old, payload), planFindings: plan.findings,
      };
      await noLinks(root, RECEIPT);
      await fsp.mkdir(path.dirname(path.join(root, RECEIPT)), { recursive: true });
      const expected = snapshots.get(RECEIPT);
      const current = await readRegular(root, RECEIPT);
      if ((current && digest(current)) !== (expected && digest(expected))) fail('stale');
      await replaceReceipt(root, JSON.stringify(receipt, null, 2), expected, changed);
      await readSafeRemovalReceipts(root, profile.executable ? [profile.executable] : []);
      result.receipts.push(receipt);
    } else if (old) {
      // Archive, then drop only the canonical translator receipt. Loader/font/mod receipts stay.
      await noLinks(root, RECEIPT);
      const current = await readRegular(root, RECEIPT);
      if (!current || digest(current) !== digest(snapshots.get(RECEIPT)!)) fail('stale');
      changed.add(RECEIPT);
      await fsp.unlink(path.join(root, RECEIPT));
    }
    result.receiptStatus = 'complete';
    result.mutationStatus = 'committed';
    manifest.status = 'committed';
    emit('receipt', 'completed', 'Maintenance complete; retained backup available');
  } catch (error) {
    result.failedStep = writingReceipt ? 'receipt' : 'payload';
    result.receiptStatus = writingReceipt ? 'failed' : 'not-run';
    if (writingReceipt) result.receiptError = (error as Error).message;
    emit('rollback', 'started', 'Restore exact pre-operation files and receipts');
    for (const rel of [...changed].reverse()) {
      try {
        await noLinks(root, rel);
        const original = snapshots.get(rel);
        if (original) {
          const stat = await statOrMissing(path.join(root, rel));
          if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail('linkedPath');
          await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
          await fsp.writeFile(path.join(root, rel), original);
          if (digest((await readRegular(root, rel))!) !== digest(original)) fail('stale');
        } else {
          const stat = await statOrMissing(path.join(root, rel));
          if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail('linkedPath');
          if (stat) await fsp.unlink(path.join(root, rel));
        }
      } catch (restoreError) {
        result.rollbackFailures.push({ path: rel, operation: snapshots.get(rel) ? 'modify' : 'create', error: (restoreError as Error).message });
      }
    }
    result.rollbackStatus = result.rollbackFailures.length ? 'partial' : 'complete';
    result.mutationStatus = result.rollbackStatus === 'complete' ? 'rolled-back' : 'partial';
    if (result.mutationStatus === 'rolled-back') { result.removed = []; result.filesWritten = []; result.receipts = []; }
    manifest.status = result.mutationStatus;
    await fsp.writeFile(result.manifestPath, JSON.stringify({ ...manifest, error: (error as Error).message, rollbackFailures: result.rollbackFailures }, null, 2)).catch(() => undefined);
    emit('rollback', result.rollbackStatus === 'complete' ? 'completed' : 'failed', 'Pre-operation recovery finished');
    throw Object.assign(error as Error, { maintenanceResult: result, applyResult: result });
  }
  // Manifest finalisation cannot turn a committed install into a false rollback claim.
  try { await fsp.writeFile(result.manifestPath, JSON.stringify(manifest, null, 2)); }
  catch (error) { result.pendingUserActions.push(`Maintenance committed but the backup manifest status could not be updated: ${(error as Error).message}`); }
  await pruneEmptyPayloadFolders(root);
  return result;
}

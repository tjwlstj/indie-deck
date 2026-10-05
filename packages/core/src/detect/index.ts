import fs from 'node:fs';
import path from 'node:path';
import type { GameProfile, InstalledLoader, InstalledTranslator, Registry } from '../types.ts';
import { tRegistry } from '../i18n/index.ts';
import { dirSize, FsProbe, matchesGlob } from '../util/fsx.ts';
import { peVersionString } from '../util/pe.ts';
import { rankEngines } from './rules.ts';
import { runProbes, unityDataDir, type ProbeContext } from './probes.ts';

/** Executables that are never the thing a player launches. */
const HELPER_EXE = [
  /^UnityCrashHandler(32|64)?\.exe$/i,
  /^unins\d*\.exe$/i,
  /^(vc_redist|dxwebsetup|DXSETUP|dotnetfx)/i,
  /^notification_helper\.exe$/i,
  /^MTool_Game\.exe$/i,
  /\.console\.exe$/i,
  /^Config\.exe$/i,
  /^crashpad_handler\.exe$/i,
  /^7za?\.exe$/i,
  /^SetupReiPatcherAndAutoTranslator\.exe$/i,
];

// These names cannot be game-library containers. Ordinary names such as
// Windows, Users and Program Files are deliberately not global exclusions:
// archives use Windows for a playable build and Steam often lives in the latter.
const SKIP_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
]);

export interface DetectOptions {
  /** Deep probes read IL2CPP metadata (tens of MB). Off during bulk scans. */
  deep?: boolean;
  /** Include a recursive folder size. Off during bulk scans. */
  measureSize?: boolean;
  /** Optional per-engine listing cap for bulk scans; direct detection is unchanged. */
  probeDirectoryLimit?: number;
  onProbeLimit?: (engineId: string) => void;
}

export function listExecutables(probe: FsProbe): string[] {
  return probe
    .namesIn('')
    .filter((n) => n.toLowerCase().endsWith('.exe') && probe.hasFile(n))
    .filter((n) => !HELPER_EXE.some((re) => re.test(n)));
}

export function pickPrimaryExecutable(probe: FsProbe, exes: string[], folderName: string): string | undefined {
  if (exes.length === 0) return undefined;
  if (exes.length === 1) return exes[0];

  // A Unity game names its payload folder after the executable.
  const dataDir = probe.namesIn('').find((n) => /_Data$/i.test(n) && probe.hasDir(n));
  if (dataDir) {
    const stem = dataDir.replace(/_Data$/i, '').toLowerCase();
    const paired = exes.find((e) => e.replace(/\.exe$/i, '').toLowerCase() === stem);
    if (paired) return paired;
  }

  const byFolder = exes.find((e) => e.replace(/\.exe$/i, '').toLowerCase() === folderName.toLowerCase());
  if (byFolder) return byFolder;

  const gameish = exes.find((e) => /^(game|start|launch|play)/i.test(e));
  if (gameish) return gameish;

  return [...exes].sort((a, b) => (probe.stat(b)?.size ?? 0) - (probe.stat(a)?.size ?? 0))[0];
}

function resolveMarker(marker: string, captures: Record<string, string>, dataDir?: string): string {
  return marker.replace('$dataDir', dataDir ?? captures['dataDir'] ?? '__nodata__');
}

export function detectInstalledLoaders(reg: Registry, probe: FsProbe, dataDir?: string): InstalledLoader[] {
  const found: InstalledLoader[] = [];
  for (const loader of reg.loaders) {
    const markers = loader.installedMarkers?.paths ?? [];
    if (markers.length === 0) continue;
    const hits = markers.map((m) => resolveMarker(m, {}, dataDir)).filter((m) => probe.has(m));
    if (hits.length === 0) continue;

    // Negative markers disambiguate loaders that share filenames - BepInEx 5
    // and 6 both ship BepInEx.dll, but only 6 ships BepInEx.Core.dll.
    const excluded = (loader.installedMarkers.excludeIfPresent ?? []).some((m) => probe.has(resolveMarker(m, {}, dataDir)));
    if (excluded) continue;

    const entry: InstalledLoader = { loaderId: loader.id, markers: hits };
    const from = loader.installedMarkers.versionFrom;
    if (from?.kind === 'peFileVersion') {
      const version = peVersionString(probe, resolveMarker(from.path, {}, dataDir), 3 * 1024 * 1024);
      if (version) entry.version = version;
    }
    const be = /be\.(\d+)/i.exec(entry.version ?? '');
    if (be) entry.build = Number(be[1]);
    found.push(entry);
  }
  return found;
}

export function detectInstalledTranslators(reg: Registry, probe: FsProbe, backend?: string): InstalledTranslator[] {
  const found: InstalledTranslator[] = [];
  for (const translator of reg.translators) {
    // Cleanup intentionally preserves user configuration/translations. Those
    // traces (or an empty plugin folder/shared Common DLL) are not an active
    // XUnity translator payload and must not keep the installed badge alive.
    if (translator.id === 'xunity-autotranslator') {
      const activePayloads = [
        'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll',
        'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.dll',
        'BepInEx/plugins/XUnity.AutoTranslator.Plugin.Core.dll',
        'Mods/XUnity.AutoTranslator.Plugin.MelonMod.dll',
        'UserLibs/XUnity.AutoTranslator.Plugin.Core.dll',
        'UnityInjector/XUnity.AutoTranslator.Plugin.Core.dll',
        'Plugins/XUnity.AutoTranslator.Plugin.Core.dll',
        'AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll',
        'ReiPatcher/ReiPatcher.exe', 'SetupReiPatcherAndAutoTranslator.exe',
      ];
      if (!activePayloads.some((file) => probe.hasFile(file))) continue;
    }
    const markerHits: string[] = [];

    for (const p of translator.installedMarkers?.paths ?? []) if (probe.has(p)) markerHits.push(p);
    for (const g of translator.installedMarkers?.globs ?? []) {
      const hit = probe.namesIn('').find((n) => matchesGlob(n, g));
      if (hit) markerHits.push(hit);
    }

    let variantId: string | undefined;
    let configPath: string | undefined;
    // Some variants are indistinguishable on disk (both MelonMod packages ship
    // the same DLL name), so the game's scripting backend picks the winner.
    const variants = [...translator.variants].sort((a, b) => {
      const fit = (v: typeof a) =>
        backend && v.constraints?.backend ? (v.constraints.backend.includes(backend as never) ? 0 : 1) : 0.5;
      return fit(a) - fit(b);
    });
    for (const variant of variants) {
      const payloadHit = (variant.payloadPaths ?? []).find((p) => probe.has(p));
      const configHit = (variant.configCandidates ?? []).find((p) => probe.hasFile(p));
      if (payloadHit || configHit) {
        variantId ??= variant.id;
        if (payloadHit) markerHits.push(payloadHit);
        if (configHit) {
          markerHits.push(configHit);
          configPath ??= configHit;
        }
      }
    }

    if (markerHits.length === 0) continue;

    const entry: InstalledTranslator = { translatorId: translator.id, markers: [...new Set(markerHits)] };
    if (variantId) entry.variantId = variantId;
    if (configPath) entry.configPath = configPath;

    if (translator.id === 'xunity-autotranslator') {
      const dllCandidates = [
        'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll',
        'BepInEx/plugins/XUnity.AutoTranslator.Plugin.Core.dll',
        'Mods/XUnity.AutoTranslator.Plugin.MelonMod.dll',
        'AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll',
      ];
      for (const dll of dllCandidates) {
        if (!probe.hasFile(dll)) continue;
        const version = peVersionString(probe, dll, 3 * 1024 * 1024);
        if (version) {
          entry.version = version;
          break;
        }
      }
    }

    found.push(entry);
  }
  return found;
}

/**
 * TMP font bundles are loose files dropped in the game root, so a folder can
 * accumulate several of them across attempts. Listing what is already there is
 * how IndieDeck tells "font installed" from "font for the wrong Unity line".
 */
export function detectInstalledFontBundles(reg: Registry, probe: FsProbe): string[] {
  const names = probe.namesIn('');
  return reg.fonts.bundles.filter((b) => names.some((n) => n.toLowerCase() === b.file.toLowerCase())).map((b) => b.id);
}

/**
 * Re-renders the display strings on a stored profile in the active locale.
 *
 * The library index is written once at scan time, so the engine name baked into
 * it is in whatever language was active then. The registry - not the stored
 * profile - is the fallback, so switching back to English recovers the English
 * name rather than keeping the translated one.
 */
export function localiseProfile(reg: Registry, profile: GameProfile): GameProfile {
  const def = reg.engines.find((e) => e.id === profile.engineId);
  return {
    ...profile,
    engineName: tRegistry(`registry.engines.${profile.engineId}.name`, def?.displayName ?? def?.name ?? profile.engineName),
  };
}

/** Full profile for one game folder. Returns undefined when nothing matches. */
export function detectGame(reg: Registry, gamePath: string, options: DetectOptions = {}): GameProfile | undefined {
  const abs = path.resolve(gamePath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(abs);
  } catch {
    return undefined;
  }
  if (!stats.isDirectory()) return undefined;

  const probe = new FsProbe(abs, { rejectLinks: options.probeDirectoryLimit !== undefined });
  const folderName = path.basename(abs);
  const exes = listExecutables(probe);
  const ranked = rankEngines(probe, reg.engines, exes, {
    probeDirectoryLimit: options.probeDirectoryLimit, onProbeLimit: options.onProbeLimit,
  });

  const best = ranked.find((m) => {
    const def = reg.engines.find((e) => e.id === m.engineId);
    return def !== undefined && m.score >= def.minScore;
  });
  if (!best) return undefined;

  const engineDef = reg.engines.find((e) => e.id === best.engineId)!;
  const primaryExe = pickPrimaryExecutable(probe, exes, folderName);

  const ctx: ProbeContext = {
    probe,
    captures: best.captures,
    exeNames: exes,
    deep: options.deep ?? false,
  };
  if (primaryExe) ctx.primaryExe = primaryExe;

  const probed = runProbes(ctx, engineDef.probes);
  const dataDir = probed.unity?.dataDir ?? unityDataDir(ctx);

  const profile: GameProfile = {
    path: abs,
    name: folderName,
    engineId: engineDef.id,
    engineName: tRegistry(`registry.engines.${engineDef.id}.name`, engineDef.displayName ?? engineDef.name),
    confidence: Math.min(100, Math.round((best.score / Math.max(engineDef.minScore, 1)) * 60)),
    alternatives: ranked.filter((m) => m.engineId !== best.engineId).slice(0, 3).map((m) => ({ engineId: m.engineId, score: m.score })),
    arch: probed.arch ?? 'unknown',
    captures: best.captures,
    installedLoaders: detectInstalledLoaders(reg, probe, dataDir),
    installedTranslators: detectInstalledTranslators(reg, probe, probed.unity?.backend),
    installedFontBundles: detectInstalledFontBundles(reg, probe),
    notes: probed.notes ?? [],
    scannedAt: new Date().toISOString(),
  };

  if (primaryExe) profile.executable = primaryExe;
  if (probed.unity) profile.unity = probed.unity;
  if (probed.engineVersion) profile.engineVersion = probed.engineVersion;
  if (probed.title) profile.title = probed.title;
  if (probed.extra && Object.keys(probed.extra).length > 0) {
    Object.assign(profile.captures, Object.fromEntries(Object.entries(probed.extra).map(([k, v]) => [k, String(v)])));
  }
  if (options.measureSize) profile.sizeBytes = dirSize(abs);

  return profile;
}

export const DEFAULT_SCAN_DEPTH = 6;
export const MAX_SCAN_DEPTH = 12;
const DEFAULT_MAX_DIRECTORIES = 20_000;

/** Invalid persisted/IPC values never turn a bounded scan into an unbounded one. */
export function normalizeScanDepth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_SCAN_DEPTH, Math.floor(value)) : DEFAULT_SCAN_DEPTH;
}

export interface ScanProgress {
  /** Unique inspected directories, including the registered roots themselves. */
  visited: number;
  /** Directories with a regular, non-helper root executable. */
  candidates: number;
  found: number;
  skipped: number;
  unreadable: number;
  /** Candidates with inconclusive bounded engine rules (not an access error). */
  probeLimited?: number;
  /** Child directories not visited because the configured depth was reached. */
  depthLimited: number;
  current: string;
  depth: number;
}

export interface ScanOptions extends DetectOptions {
  /** Levels below each root; 0 still inspects an explicitly selected game. */
  depth?: number;
  onProgress?: (current: string, found: number) => void;
  onStatus?: (progress: ScanProgress) => void;
  signal?: AbortSignal;
  /** Unique directories to inspect; defaults to 20,000, capped at 100,000. */
  maxDirectories?: number;
  /** Preserve rows affected by unavailable roots, access errors or limited probes. */
  onUnreadable?: (directory: string) => void;
}

export class ScanCancelledError extends Error {
  constructor() { super('Library scan cancelled.'); this.name = 'ScanCancelledError'; }
}

export class ScanLimitError extends Error {
  readonly maxDirectories: number;
  constructor(maxDirectories: number) {
    super(`Library scan reached its ${maxDirectories} directory limit. Narrow the roots or lower the search depth.`);
    this.name = 'ScanLimitError'; this.maxDirectories = maxDirectories;
  }
}

/** Kept separate so persistence can check again after its asynchronous reads. */
export function throwIfScanCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScanCancelledError();
}

function directoryKey(directory: string): string { return path.resolve(directory).toLowerCase(); }

function missingDirectory(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

/** Only actual OS locations are excluded, not identically named game folders. */
function systemDirectories(): Set<string> {
  return new Set(['SystemRoot', 'WINDIR', 'ProgramData'].map((name) => process.env[name])
    .filter((value): value is string => typeof value === 'string' && value.length > 0 &&
      !value.includes('\0') && path.isAbsolute(value)).map(directoryKey));
}

/**
 * Shared bounded walker. A cheap root listing selects EXE candidates before any
 * engine-specific recursive rules or version/loader probes run. Marker-only
 * folders cannot swallow a playable build farther below them. The public
 * detectGame API intentionally still accepts non-launchable engine evidence.
 */
function* walkLibrary(reg: Registry, roots: string[], options: ScanOptions): Generator<ScanProgress, GameProfile[]> {
  const depth = normalizeScanDepth(options.depth);
  const maxDirectories = typeof options.maxDirectories === 'number' && Number.isFinite(options.maxDirectories) && options.maxDirectories > 0
    ? Math.max(1, Math.min(100_000, Math.floor(options.maxDirectories))) : DEFAULT_MAX_DIRECTORIES;
  const progress: ScanProgress = { visited: 0, candidates: 0, found: 0, skipped: 0, unreadable: 0, probeLimited: 0, depthLimited: 0, current: '', depth };
  const results: GameProfile[] = [];
  const directories = new Map<string, { entries: fs.Dirent[]; terminal: boolean }>();
  const inspected = new Set<string>();
  const walked = new Map<string, number>();
  const unreadable = new Set<string>();
  const system = systemDirectories();

  const reportUnreadable = (directory: string, error: unknown, explicitRoot = false): void => {
    // A missing registered drive/share can be temporarily disconnected. Only
    // missing children of an available root are affirmative deletion evidence.
    if (missingDirectory(error) && !explicitRoot) { progress.skipped += 1; return; }
    const key = directoryKey(directory);
    if (unreadable.has(key)) return;
    unreadable.add(key); progress.unreadable += 1;
    options.onUnreadable?.(directory);
  };
  const publish = (): ScanProgress => {
    const snapshot = { ...progress };
    options.onProgress?.(snapshot.current, snapshot.found);
    options.onStatus?.(snapshot);
    return snapshot;
  };
  const excluded = (directory: string, name: string, explicit: boolean): boolean => {
    const lower = name.toLowerCase();
    return SKIP_DIRS.has(lower) || system.has(directoryKey(directory)) ||
      lower.startsWith('.staging') || lower.startsWith('.indiedeck') || (!explicit && name.startsWith('.'));
  };
  // Do not follow a directly selected junction or one in its ancestors. Child
  // entries are checked again with lstat immediately before reading them.
  const ordinaryRoot = (absolute: string): boolean => {
    const parsed = path.parse(absolute);
    let current = parsed.root;
    const candidates = [current, ...absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
      .map((part) => { current = path.join(current, part); return current; })];
    try {
      return candidates.every((candidate) => {
        const stat = fs.lstatSync(candidate);
        return stat.isDirectory() && !stat.isSymbolicLink();
      });
    } catch (error) { reportUnreadable(absolute, error, true); return false; }
  };

  throwIfScanCancelled(options.signal);
  for (const root of roots) {
    throwIfScanCancelled(options.signal);
    const resolved = path.resolve(root);
    if (excluded(resolved, path.basename(resolved), true) || !ordinaryRoot(resolved)) {
      progress.skipped += 1; progress.current = resolved; yield publish(); continue;
    }
    const stack: { directory: string; level: number }[] = [{ directory: resolved, level: 0 }];
    while (stack.length > 0) {
      throwIfScanCancelled(options.signal);
      const { directory, level } = stack.pop()!;
      const key = directoryKey(directory), remaining = depth - level;
      if ((walked.get(key) ?? -1) >= remaining) continue;
      walked.set(key, remaining);
      progress.current = directory;
      let record = directories.get(key);
      if (!record) {
        if (!inspected.has(key)) {
          if (progress.visited >= maxDirectories) throw new ScanLimitError(maxDirectories);
          inspected.add(key); progress.visited += 1;
        }
        let entries: fs.Dirent[];
        try {
          const stat = fs.lstatSync(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) { progress.skipped += 1; yield publish(); continue; }
          entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) { reportUnreadable(directory, error, level === 0); yield publish(); continue; }
        record = { entries, terminal: false };
        directories.set(key, record);
        // Never interpret a drive/share root as one game, even if stray player
        // binaries happen to be placed there. Directly registered game roots
        // retain depth-zero support.
        const executableNames = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() &&
          /\.exe$/i.test(entry.name) && !HELPER_EXE.some((helper) => helper.test(entry.name))).map((entry) => entry.name);
        if (directory !== path.parse(directory).root && executableNames.length > 0) {
          progress.candidates += 1;
          let limited = false;
          const profile = detectGame(reg, directory, {
            deep: options.deep, measureSize: options.measureSize, probeDirectoryLimit: 128,
            onProbeLimit: (engineId) => {
              if (!limited) { limited = true; progress.probeLimited = (progress.probeLimited ?? 0) + 1; options.onUnreadable?.(directory); }
              options.onProbeLimit?.(engineId);
            },
          });
          if (profile?.executable && executableNames.includes(profile.executable)) {
            results.push(profile); progress.found = results.length; record.terminal = true;
          }
        }
      }
      if (!record.terminal) {
        const children: { directory: string; level: number }[] = [];
        for (const entry of record.entries) {
          if (entry.isSymbolicLink()) { progress.skipped += 1; continue; }
          if (!entry.isDirectory()) continue;
          const child = path.join(directory, entry.name);
          if (excluded(child, entry.name, false)) { progress.skipped += 1; continue; }
          if (level >= depth) { progress.depthLimited += 1; continue; }
          children.push({ directory: child, level: level + 1 });
        }
        // Reverse push preserves the old directory-listing traversal order.
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
      }
      yield publish();
    }
  }
  throwIfScanCancelled(options.signal);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Synchronous compatibility API; shares exactly the async traversal rules. */
export function scanLibrary(reg: Registry, roots: string[], options: ScanOptions = {}): GameProfile[] {
  const iterator = walkLibrary(reg, roots, options);
  let next = iterator.next();
  while (!next.done) next = iterator.next();
  return next.value;
}

/** Cooperatively yields so desktop progress, cancellation and other IPC run. */
export async function scanLibraryAsync(reg: Registry, roots: string[], options: ScanOptions = {}): Promise<GameProfile[]> {
  const iterator = walkLibrary(reg, roots, options);
  let start = performance.now(), processed = 0;
  while (true) {
    throwIfScanCancelled(options.signal);
    const next = iterator.next();
    if (next.done) return next.value;
    processed += 1;
    if (processed >= 32 || performance.now() - start >= 16) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfScanCancelled(options.signal);
      processed = 0; start = performance.now();
    }
  }
}

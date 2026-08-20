import fs from 'node:fs';
import path from 'node:path';
import type { GameProfile, InstalledLoader, InstalledTranslator, Registry } from '../types.ts';
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

const SKIP_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'users',
  'node_modules',
  'temp',
  '.git',
  'msocache',
  'recovery',
]);

export interface DetectOptions {
  /** Deep probes read IL2CPP metadata (tens of MB). Off during bulk scans. */
  deep?: boolean;
  /** Include a recursive folder size. Off during bulk scans. */
  measureSize?: boolean;
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

  const probe = new FsProbe(abs);
  const folderName = path.basename(abs);
  const exes = listExecutables(probe);
  const ranked = rankEngines(probe, reg.engines, exes);

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
    engineName: engineDef.displayName ?? engineDef.name,
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

export interface ScanOptions extends DetectOptions {
  /** How many directory levels below each root to search. 1 = roots' children only. */
  depth?: number;
  onProgress?: (current: string, found: number) => void;
}

/**
 * Scans library roots for games. A folder that itself matches an engine is not
 * descended into - installers commonly nest the real game one level down
 * (`Game/ReleaseVer1.1.2_Win/`), which is why the default depth is 2.
 */
export function scanLibrary(reg: Registry, roots: string[], options: ScanOptions = {}): GameProfile[] {
  const depth = options.depth ?? 2;
  const results: GameProfile[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, level: number): void => {
    if (level > depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      if (entry.name.startsWith('.')) continue;

      const child = path.join(dir, entry.name);
      const key = child.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      options.onProgress?.(child, results.length);
      const profile = detectGame(reg, child, options);
      if (profile) {
        results.push(profile);
        continue; // do not descend into a detected game
      }
      walk(child, level + 1);
    }
  };

  for (const root of roots) walk(path.resolve(root), 1);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

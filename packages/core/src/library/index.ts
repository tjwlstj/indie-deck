import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GameProfile, Registry } from '../types.ts';
import { scanLibraryAsync, detectGame, normalizeScanDepth, throwIfScanCancelled, type ScanOptions } from '../detect/index.ts';
import { defaultDataDir } from '../install/download.ts';
import { t } from '../i18n/index.ts';
import { isNativeLoader } from '../registry/index.ts';
import { ensureDir, pathExists } from '../util/fsx.ts';

export interface LauncherConfig {
  roots: string[];
  /** UI language: a locale code, or `system` to follow the environment. */
  locale: string;
  defaults: {
    targetLanguage: string;
    sourceLanguage: string;
    endpoint: string;
  };
  scanDepth: number;
  /** Undefined probes the Windows default; null explicitly disables MTool. */
  externalTools?: { mtoolRoot?: string | null };
}

export interface LibraryIndex {
  games: GameProfile[];
  scannedAt: string;
  roots: string[];
  /** Monotonic persisted-state token. Legacy indexes load as revision 0. */
  revision: number;
}

type LibrarySaveInput = Omit<LibraryIndex, 'revision'> & { revision?: number };

const DEFAULT_CONFIG: LauncherConfig = {
  roots: [],
  locale: 'system',
  defaults: { targetLanguage: 'en', sourceLanguage: 'ja', endpoint: 'GoogleTranslate' },
  scanDepth: normalizeScanDepth(undefined),
};

export function configPath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, 'config.json');
}

export function libraryPath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, 'library.json');
}

export async function loadConfig(dataDir = defaultDataDir()): Promise<LauncherConfig> {
  const file = configPath(dataDir);
  if (!(await pathExists(file))) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<LauncherConfig>;
    const externalTools = parsed.externalTools;
    const mtoolRoot = externalTools && typeof externalTools === 'object' &&
      (externalTools.mtoolRoot === null ||
        (typeof externalTools.mtoolRoot === 'string' && externalTools.mtoolRoot.length > 0 &&
          externalTools.mtoolRoot.length <= 32768 && !externalTools.mtoolRoot.includes('\0')))
      ? externalTools.mtoolRoot : undefined;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      defaults: { ...DEFAULT_CONFIG.defaults, ...(parsed.defaults ?? {}) },
      roots: parsed.roots ?? [],
      // Preserve valid existing depths (including 2); only new/malformed
      // configurations use the broader default. No silent user-setting migration.
      scanDepth: normalizeScanDepth(parsed.scanDepth),
      // A malformed persisted value cannot become a privileged tool target.
      // Omit it rather than coercing objects/numbers into filesystem paths.
      externalTools: mtoolRoot === undefined ? undefined : { mtoolRoot },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(config: LauncherConfig, dataDir = defaultDataDir()): Promise<void> {
  await ensureDir(dataDir);
  await fsp.writeFile(configPath(dataDir), JSON.stringify({ ...config, scanDepth: normalizeScanDepth(config.scanDepth) }, null, 2), 'utf8');
}

export async function addRoot(root: string, dataDir = defaultDataDir()): Promise<LauncherConfig> {
  const config = await loadConfig(dataDir);
  const resolved = path.resolve(root);
  if (!config.roots.some((r) => path.resolve(r).toLowerCase() === resolved.toLowerCase())) {
    config.roots.push(resolved);
    await saveConfig(config, dataDir);
  }
  return config;
}

export async function removeRoot(root: string, dataDir = defaultDataDir()): Promise<LauncherConfig> {
  const config = await loadConfig(dataDir);
  const resolved = path.resolve(root).toLowerCase();
  config.roots = config.roots.filter((r) => path.resolve(r).toLowerCase() !== resolved);
  await saveConfig(config, dataDir);
  return config;
}

export async function loadLibrary(dataDir = defaultDataDir()): Promise<LibraryIndex> {
  const file = libraryPath(dataDir);
  if (!(await pathExists(file))) return { games: [], scannedAt: '', roots: [], revision: 0 };
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Omit<LibraryIndex, 'revision'> & {
      revision?: unknown;
    };
    return {
      ...parsed,
      revision:
        typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0
          ? parsed.revision
          : 0,
    };
  } catch {
    return { games: [], scannedAt: '', roots: [], revision: 0 };
  }
}

/**
 * Persists an index with an atomic same-directory replace.
 *
 * The desktop main process serialises library read/write mutations. Within that
 * boundary, reading the on-disk revision immediately before the replace makes a
 * stale caller advance rather than rewind the revision. The optional revision
 * in the input keeps callers that construct the pre-revision shape compatible.
 */
export async function saveLibrary(index: LibrarySaveInput, dataDir = defaultDataDir()): Promise<LibraryIndex> {
  await ensureDir(dataDir);
  const file = libraryPath(dataDir);
  const current = await loadLibrary(dataDir);
  const requested =
    typeof index.revision === 'number' && Number.isSafeInteger(index.revision) && index.revision >= 0 ? index.revision : 0;
  const persisted: LibraryIndex = {
    ...index,
    revision: Math.max(current.revision, requested) + 1,
  };
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);

  try {
    const handle = await fsp.open(temp, 'wx');
    try {
      await handle.writeFile(JSON.stringify(persisted, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true });
  }

  return persisted;
}

export interface RefreshOptions extends ScanOptions {
  dataDir?: string;
  roots?: string[];
  /** Keep entries whose folder still exists but was not re-scanned. */
  merge?: boolean;
  /** Freeze desktop cancellation after reads/merge, immediately before commit. */
  onBeforeSave?: () => void;
}

export interface RefreshLibraryGameOptions {
  dataDir?: string;
  /** Targeted mutation refreshes are deep by default; tests/tools may opt out. */
  deep?: boolean;
  /** Keep the expensive recursive size measurement opt-in. */
  measureSize?: boolean;
}

export interface RefreshLibraryGameResult {
  index: LibraryIndex;
  /** Fresh profile, or null when the folder vanished or no longer matches a known engine. */
  profile: GameProfile | null;
}

/** Rescans configured roots and persists the result. */
export async function refreshLibrary(reg: Registry, options: RefreshOptions = {}): Promise<LibraryIndex> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const config = await loadConfig(dataDir);
  const roots = options.roots ?? config.roots;
  if (roots.length === 0) {
    throw new Error(t('core.error.no-roots', {}, 'No library roots configured. Add one with `indiedeck root add <path>`.'));
  }

  const unreadablePaths: string[] = [];
  const scanOptions: ScanOptions = {
    depth: options.depth ?? config.scanDepth,
    onUnreadable: (directory) => { unreadablePaths.push(directory); options.onUnreadable?.(directory); },
  };
  if (options.onProgress) scanOptions.onProgress = options.onProgress;
  if (options.onStatus) scanOptions.onStatus = options.onStatus;
  if (options.signal) scanOptions.signal = options.signal;
  if (options.maxDirectories !== undefined) scanOptions.maxDirectories = options.maxDirectories;
  if (options.deep !== undefined) scanOptions.deep = options.deep;
  if (options.measureSize !== undefined) scanOptions.measureSize = options.measureSize;

  const found = await scanLibraryAsync(reg, roots, scanOptions);
  throwIfScanCancelled(options.signal);
  let games = found;

  if (options.merge || unreadablePaths.length > 0) {
    const previous = await loadLibrary(dataDir);
    const byPath = new Map(found.map((g) => [g.path.toLowerCase(), g]));
    const within = (root: string, candidate: string): boolean => {
      const relative = path.relative(path.resolve(root).toLowerCase(), path.resolve(candidate).toLowerCase());
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    for (const old of previous.games) {
      throwIfScanCancelled(options.signal);
      if (byPath.has(old.path.toLowerCase())) continue;
      // Access failure is not evidence of deletion. Also retain an old game
      // when an unreadable payload subtree could have hidden its engine rules.
      // Missing registered roots are also retained (drive/share disconnect is
      // not deletion). Missing children of an available root still disappear.
      const affected = unreadablePaths.some((directory) => within(directory, old.path) || within(old.path, directory));
      if (affected || (options.merge && await pathExists(old.path))) byPath.set(old.path.toLowerCase(), old);
    }
    games = [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  throwIfScanCancelled(options.signal);
  options.onBeforeSave?.();
  throwIfScanCancelled(options.signal);
  return saveLibrary({ games, scannedAt: new Date().toISOString(), roots }, dataDir);
}

/**
 * Deep-detects one game and atomically replaces only its saved library row.
 *
 * Other games, roots and the full-scan timestamp are preserved. A missing
 * folder (or one whose engine markers disappeared) removes the stale row and
 * returns `profile: null`, giving mutation callers an explicit deletion signal.
 */
export async function refreshLibraryGame(
  reg: Registry,
  gamePath: string,
  options: RefreshLibraryGameOptions = {},
): Promise<RefreshLibraryGameResult> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const previous = await loadLibrary(dataDir);
  const resolved = path.resolve(gamePath);
  const key = resolved.toLowerCase();
  const detectOptions: { deep: boolean; measureSize?: boolean } = { deep: options.deep ?? true };
  if (options.measureSize !== undefined) detectOptions.measureSize = options.measureSize;
  const profile = detectGame(reg, resolved, detectOptions) ?? null;

  let replaced = false;
  const games: GameProfile[] = [];
  for (const existing of previous.games) {
    if (path.resolve(existing.path).toLowerCase() !== key) {
      games.push(existing);
      continue;
    }
    if (profile && !replaced) {
      games.push(profile);
      replaced = true;
    }
  }
  if (profile && !replaced) games.push(profile);

  const index = await saveLibrary(
    {
      games,
      scannedAt: previous.scannedAt,
      roots: previous.roots,
      revision: previous.revision,
    },
    dataDir,
  );
  return { index, profile };
}

/** Finds a game by exact path, folder name, or case-insensitive substring. */
export function findGames(index: LibraryIndex, query: string): GameProfile[] {
  const q = query.toLowerCase();
  const exact = index.games.filter((g) => g.path.toLowerCase() === path.resolve(query).toLowerCase());
  if (exact.length > 0) return exact;
  const byName = index.games.filter((g) => g.name.toLowerCase() === q);
  if (byName.length > 0) return byName;
  return index.games.filter((g) => g.name.toLowerCase().includes(q) || (g.title ?? '').toLowerCase().includes(q));
}

/**
 * Resolves a CLI game argument: an on-disk path is detected fresh, anything
 * else is looked up in the saved library.
 */
export async function resolveGameArg(
  reg: Registry,
  arg: string,
  options: { dataDir?: string; deep?: boolean } = {},
): Promise<GameProfile> {
  const dataDir = options.dataDir ?? defaultDataDir();
  if (await pathExists(arg)) {
    const detectOptions: { deep?: boolean } = {};
    if (options.deep !== undefined) detectOptions.deep = options.deep;
    const profile = detectGame(reg, arg, detectOptions);
    if (!profile) {
      throw new Error(t('core.error.no-engine', { path: path.resolve(arg) }, `No known engine detected in ${path.resolve(arg)}.`));
    }
    return profile;
  }

  const index = await loadLibrary(dataDir);
  const matches = findGames(index, arg);
  if (matches.length === 0) {
    throw new Error(
      t('core.error.no-match', { query: arg }, `No game matching "${arg}" - run \`indiedeck scan\` first, or pass a folder path.`),
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${t('core.error.ambiguous', { query: arg, count: matches.length }, `"${arg}" matches ${matches.length} games:`)}\n  ${matches
        .slice(0, 10)
        .map((m) => m.name)
        .join('\n  ')}`,
    );
  }
  // Re-detect so the profile reflects the folder as it is right now.
  const detectOptions: { deep?: boolean } = {};
  if (options.deep !== undefined) detectOptions.deep = options.deep;
  return detectGame(reg, matches[0]!.path, detectOptions) ?? matches[0]!;
}

export interface LibraryStats {
  total: number;
  byEngine: { engineId: string; engineName: string; count: number }[];
  withTranslator: number;
  withLoader: number;
  byBackend: Record<string, number>;
}

export function libraryStats(index: LibraryIndex, reg?: Registry): LibraryStats {
  const byEngine = new Map<string, { engineName: string; count: number }>();
  const byBackend: Record<string, number> = {};
  let withTranslator = 0;
  let withLoader = 0;

  for (const game of index.games) {
    const entry = byEngine.get(game.engineId) ?? { engineName: game.engineName, count: 0 };
    entry.count += 1;
    byEngine.set(game.engineId, entry);
    if (game.installedTranslators.length > 0) withTranslator += 1;
    const hasRealLoader = game.installedLoaders.some((l) =>
      reg ? !isNativeLoader(reg, l.loaderId) : l.loaderId !== 'renpy-native' && l.loaderId !== 'rpgmaker-plugins',
    );
    if (hasRealLoader) withLoader += 1;
    if (game.unity) byBackend[game.unity.backend] = (byBackend[game.unity.backend] ?? 0) + 1;
  }

  return {
    total: index.games.length,
    byEngine: [...byEngine.entries()]
      .map(([engineId, v]) => ({ engineId, engineName: v.engineName, count: v.count }))
      .sort((a, b) => b.count - a.count),
    withTranslator,
    withLoader,
    byBackend,
  };
}

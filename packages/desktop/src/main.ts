import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, stat, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  addRoot,
  applyPlan,
  auditGame,
  auditLibrary,
  detectGame,
  defaultDataDir,
  installModFromFile,
  libraryStats,
  localiseProfile,
  listMods,
  loadConfig,
  normalizeScanDepth,
  ScanCancelledError,
  ScanLimitError,
  loadLibrary,
  loadRegistry,
  loadCatalogs,
  tRegistry,
  t,
  availableLocales,
  getCatalog,
  getLocale,
  setLocale,
  planConfigChanges,
  redactConfigPlan,
  readGameConfig,
  writeGameConfig,
  modHosts,
  readReceipts,
  readReceiptEvidence,
  collectTranslatorEvidence,
  refreshLibrary,
  refreshLibraryGame,
  removeRoot,
  resolvePlans,
  resolveFontPlan,
  recommendGameFont,
  saveConfig,
  setModEnabled,
  summarisePlans,
  uninstallReceipt,
  isSafeReceiptComponentId,
  type GameProfile,
  type LauncherConfig,
  type Registry,
  type ResolveOptions,
  type FontResolveOptions,
  type ConfigChange,
  type ConfigSchema,
  type TranslatorPlan,
  type ApplyResult,
  type ReceiptEvidence,
  type TranslatorInstallEvidence,
} from '@indiedeck/core';
import { OperationManager, type OperationRequest, type OperationResult, type ProgressUpdate } from './operations.ts';
import { readSafeRemovalReceipts } from './receipt-guard.ts';
import { fontWriteBlockKey } from './font-guard.ts';
import { getMToolStatus, isMToolGame, mtoolLaunchSpec, getMToolGameExecutable, type MToolStatus } from './mtool.ts';
import { previewTranslatorMaintenance, runTranslatorMaintenance, type TranslatorMaintenancePreview } from './translator-maintenance.ts';
import { inspectGameArchive, listGameArchives, type GameArchiveInspection, type GameArchiveRecord } from './game-archives.ts';
import { installGameArchiveVersion, listGameInstallations, setActiveGameInstallation, recoverGameInstallations } from './game-installations.ts';
import { createLauncherUpdateController, LAUNCHER_RELEASE_URL } from './launcher-updates.ts';
import { withinLibraryRoots } from './library-roots.ts';
import { LibraryScanController } from './library-scan.ts';
import { getGameThumbnail, searchSteamCovers, fetchSteamCover, searchGogCovers, fetchGogCover } from './thumbnails.ts';
import { createGogSearchAuthority } from './gog-search-authority.ts';
import { readThumbnailPreferences, saveThumbnailPreference } from './thumbnail-preferences.ts';
import { importManualThumbnail, importManualThumbnailBytes, readManualThumbnail, clearManualThumbnail } from './manual-thumbnails.ts';
import { createStoreArtworkPreviews } from './store-artwork.ts';
import { STORE_PROVIDERS, canonicalStoreProductUrl, parseStoreLink, parseStoreLinkText, readStoreLinkFile, readStoreConnections, saveStoreConnection, removeStoreConnection, resolveStoreHandoff,
  type StoreLinkCandidate, type StoreProviderId, type StoreHandoffAction, type StoreConnection } from './store-connections.ts';
import { exportBrowserCompanion } from './browser-companion-export.ts';
import { buildTranslationConfigComparison, type TranslationConfigComparison } from './translation-config-comparison.ts';
import { TranslationConfigHistory, type TranslationConfigHistoryRecord } from './translation-config-history.ts';
import { createSecurityScanner, fingerprintSecurityTarget, type SecurityScanResult } from './security-scanner.ts';
import { createSecurityController } from './security-controller.ts';
import { isTrustedAppSender, safeExternalUrl } from './browser-security.ts';
import { gameProcessEnvironment } from './process-environment.ts';
import { readLibraryPreferences, saveLibraryPreferences } from './library-preferences.ts';
import { scanLaunchTarget } from './security-launch-policy.ts';
import { createLaunchDiagnostics } from './launch-diagnostics.ts';
import { inspectLaunchDirectory, inspectLaunchTarget, revalidateLaunchTarget } from './launch-target-guard.ts';
import { createOwnedGameSessions, shouldDeferBackgroundWork } from './owned-game-sessions.ts';
import { DEFAULT_GAMING_PREFERENCES, readGamingPreferences, saveGamingPreferences } from './gaming-preferences.ts';
import { parseGamingEntryArgs, gamingRegistration, exportGamingShortcut, gamingSettingsUrl } from './gaming-entry.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// Entry-point app paths differ between `electron .`, `electron packages/desktop`
// and packaged ASARs. Runtime assets share the compiled module's fixed layout.
const bundleRoot = path.resolve(here, '../../..');
const { autoUpdater } = electronUpdater;
const APP_ID = 'io.github.tjwlstj.indiedeck';

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
// Isolate the Chromium profile in source, portable and installed smoke runs.
// Test mode never shares the user's regular IndieDeck profile or lock.
if (process.env['INDIEDECK_SMOKE']) {
  const profile = path.join(defaultDataDir(), 'electron-profile');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}

let registry: Registry;
let comparisonHistory: TranslationConfigHistory | undefined;
let security: ReturnType<typeof createSecurityController>;
let smokeSecurityVerdict: SecurityScanResult['verdict'] = 'clean';
let smokeSecurityHold = false;
let mainWindow: BrowserWindow | undefined;
const launchDiagnostics = createLaunchDiagnostics((gameId, result) => send('game:launch-diagnostic', { gameId, result }));
let pendingMutations = 0;
let updateRestartReserved = false;
let sessionEnding = false;
let launcherUpdates: ReturnType<typeof createLauncherUpdateController>;
let mutationQueue: Promise<void> = Promise.resolve();
let stateRevision = 0;
const gameRevisions = new Map<string, number>();
let libraryRoots: string[] = [];
let gamingPreferences = { ...DEFAULT_GAMING_PREFERENCES };
let gamingSettingsError = false;
let gamingSequence = 0;
let minimizedForGame = false;
let rendererReady = false;
let queuedEntry: { fullscreen: boolean; launchGameId?: string } | undefined;
const ownedGames = createOwnedGameSessions({ onChange: () => {
  publishGamingState();
  if (!ownedGames.snapshot().sessions.length && minimizedForGame && gamingPreferences.restoreOnExit && mainWindow?.isMinimized()) {
    minimizedForGame = false;
    mainWindow.restore(); mainWindow.show();
  }
} });

function gamingSnapshot() {
  const sessions = ownedGames.snapshot().sessions;
  return { sequence: gamingSequence, fullscreen: mainWindow?.isFullScreen() ?? false, ...gamingPreferences,
    activeGameCount: sessions.length,
    runningGameIds: sessions.map(entry => entry.gameId), settingsError: gamingSettingsError };
}
function publishGamingState() { gamingSequence += 1; send('gaming:state', gamingSnapshot()); }
function focusLauncher() {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show(); mainWindow?.focus();
}
function entryArguments(argv: string[]) {
  return parseGamingEntryArgs(argv, { packaged: app.isPackaged, executable: process.execPath, appPath: app.getAppPath() });
}
async function acceptGamingEntry(argv: string[]) {
  const entry = entryArguments(argv);
  if (!entry.valid) { send('gaming:entry-error', { errorKey: 'ui.gaming.error.invalidArguments' }); return; }
  if (!rendererReady) { queuedEntry = entry; return; }
  await runGamingEntry(entry);
}
async function runGamingEntry(entry: { fullscreen: boolean; launchGameId?: string }) {
  if (entry.fullscreen) mainWindow?.setFullScreen(true);
  if (entry.launchGameId) {
    try { await launchGame(entry.launchGameId); }
    catch { focusLauncher(); send('gaming:entry-error', { errorKey: 'ui.gaming.error.launchFailed' }); }
  }
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', (_event, argv) => {
  focusLauncher();
  // Portable instances extract to different internal executable paths. argv[0]
  // is not execution authority: normalize it to this process, then validate
  // every application flag and resolve the opaque id against our own library.
  void acceptGamingEntry([process.execPath, ...argv.slice(1)]);
});

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Reserving a slot is synchronous, so a fast start reply cannot open a quit
 * gap before the queued file writer begins. */
function enqueueMutation<T>(work: () => Promise<T> | T): Promise<T> {
  if (updateRestartReserved) throw new Error('ui.update.error.busy');
  pendingMutations += 1;
  const result = mutationQueue.then(work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result.finally(() => { pendingMutations -= 1; });
}

const operations = new OperationManager({
  enqueue: (work) => { void enqueueMutation(work); },
  progress: (event) => send('maintenance:progress', event),
  outcome: (event) => send('maintenance:outcome', event),
});

const libraryScan = new LibraryScanController((task) => {
  send('scan:status', task);
  // Retain the older read-only progress subscription without emitting one IPC
  // per directory; the controller throttles running snapshots.
  if (task.status === 'running') send('scan:progress', task.current);
});

function markGameChanged(gameId: string): number {
  const revision = ++stateRevision;
  gameRevisions.set(gameId, revision);
  return revision;
}

/* ------------------------------------------------------- trust boundary */

/**
 * The renderer never hands the main process a path, an executable or a plan.
 *
 * It gets opaque ids and hands them back; the main process resolves each id
 * against its own tables and rebuilds the privileged object itself. A renderer
 * that somehow ran attacker-controlled script still cannot say "install this
 * archive into C:\Windows" or "launch this exe" - it can only name a game the
 * main process already knows about.
 */
const gamePathsById = new Map<string, string>();
const plansById = new Map<string, TranslatorPlan>();
const planOptionsById = new Map<string, FontResolveOptions>();
const translatorMaintenanceById = new Map<string, { gameId: string; path: string; preview: TranslatorMaintenancePreview }>();
const optionComparisonsByPreview = new WeakMap<TranslatorMaintenancePreview, TranslationConfigComparison>();
// If saving launcher history fails, the committed game operation still succeeds.
// Keep a session fallback so its report can be reviewed with a visible notice.
const lastOptionComparisonsByGame = new Map<string, TranslationConfigHistoryRecord>();
const securityResultsByGame = new Map<string, SecurityScanResult>();
const archiveCandidates = new Map<string, { path: string; inspection: GameArchiveInspection }>();
const storeLinkCandidates = new Map<string, StoreLinkCandidate>();
const storeArtworkPreviews = createStoreArtworkPreviews();
const thumbnailSearchResults = new Map<string, Set<string>>();
const thumbnailSearchGeneration = new Map<string, number>();
const gogSearchAuthority = createGogSearchAuthority();
interface ArchiveTask {
  id: string;
  sequence: number;
  status: 'running' | 'complete' | 'failed';
  phase: 'inspect' | 'extract' | 'publish' | 'complete' | 'failed';
  completedFiles: number; totalFiles: number;
  completedBytes: number; totalBytes: number;
  error?: string;
  result?: unknown;
}
let archiveTask: ArchiveTask | null = null;
let archiveSequence = 0;
let archiveRecoveryError: string | undefined;

function idFor(gamePath: string): string {
  return crypto.createHash('sha1').update(path.resolve(gamePath).toLowerCase()).digest('hex').slice(0, 16);
}

function rememberGames(profiles: GameProfile[]): void {
  const currentIds = new Set(profiles.map((profile) => idFor(profile.path)));
  for (const id of lastOptionComparisonsByGame.keys()) if (!currentIds.has(id)) lastOptionComparisonsByGame.delete(id);
  for (const id of securityResultsByGame.keys()) if (!currentIds.has(id)) securityResultsByGame.delete(id);
  for (const id of gamePathsById.keys()) if (!currentIds.has(id)) {
    gamePathsById.delete(id);
    gameRevisions.delete(id);
    for (const [key, entry] of translatorMaintenanceById) if (entry.gameId === id) translatorMaintenanceById.delete(key);
    for (const key of plansById.keys()) if (key.startsWith(`${id}:`)) {
      plansById.delete(key);
      planOptionsById.delete(key);
    }
  }
  for (const profile of profiles) gamePathsById.set(idFor(profile.path), path.resolve(profile.path));
}

function withinLibraryRoot(gamePath: string): boolean {
  return withinLibraryRoots(gamePath, libraryRoots);
}

function requireGamePath(gameId: unknown): string {
  if (typeof gameId !== 'string' || !/^[0-9a-f]{16}$/.test(gameId)) throw new Error('Malformed game id.');
  const resolved = gamePathsById.get(gameId);
  if (!resolved || !withinLibraryRoot(resolved)) throw new Error('Unknown game - rescan the library and try again.');
  return resolved;
}

function withId<T extends { path: string }>(profile: T): T & { id: string } {
  return { ...profile, id: idFor(profile.path) };
}

/** Recomputes plans for a game and keeps the authoritative copies main-side. */
function cachePlans(gameId: string, plans: TranslatorPlan[], options: FontResolveOptions): (TranslatorPlan & { id: string })[] {
  // Retain a small history: an older detail request finishing later must not
  // invalidate the ids already returned by the newer selected-game request.
  // Every install still rebuilds and compares its plan immediately before use.
  while (plansById.size > 250) {
    const key = plansById.keys().next().value!;
    plansById.delete(key);
    planOptionsById.delete(key);
  }
  return plans.map((plan) => {
    const id = `${gameId}:${crypto.randomUUID()}`;
    plansById.set(id, plan);
    planOptionsById.set(id, options);
    return { ...plan, id };
  });
}

function requirePlan(gameId: string, planId: unknown): TranslatorPlan {
  if (typeof planId !== 'string' || !planId.startsWith(`${gameId}:`)) throw new Error('Plan does not belong to this game.');
  const plan = plansById.get(planId);
  if (!plan) throw new Error('That plan is stale - reopen the game and try again.');
  // Belt and braces: the cached plan must still point at the game it was made for.
  if (path.resolve(plan.gamePath) !== requireGamePath(gameId)) throw new Error('Plan target mismatch.');
  return plan;
}

async function cacheTranslatorMaintenance(gameId: string, profile: GameProfile, preview: TranslatorMaintenancePreview) {
  const optionComparison = preview.files.length || profile.installedTranslators.some((item) => item.translatorId === 'xunity-autotranslator')
    ? await buildTranslationConfigComparison(registry, profile, {
    version: preview.version, variantId: preview.variantId, currentVersions: preview.currentVersions,
  }) : undefined;
  if (optionComparison) optionComparisonsByPreview.set(preview, optionComparison);
  while (translatorMaintenanceById.size >= 100) translatorMaintenanceById.delete(translatorMaintenanceById.keys().next().value!);
  const previewId = `${gameId}:${crypto.randomUUID()}`;
  translatorMaintenanceById.set(previewId, { gameId, path: path.resolve(profile.path), preview });
  return {
    previewId, supported: preview.supported, eligible: preview.eligible,
    canRemove: preview.removeEligible, canReinstall: preview.reinstallEligible,
    blockedReason: preview.blockReasonKey ? t(preview.blockReasonKey) : undefined,
    reinstallBlockedReason: preview.reinstallBlockReasonKey ? t(preview.reinstallBlockReasonKey) : undefined,
    files: preview.files, currentVersions: preview.currentVersions, targetVersion: preview.version,
    variantId: preview.variantId, preservedPaths: preview.preservedPaths, optionComparison,
  };
}

function requireTranslatorMaintenance(gameId: string, previewId: unknown): TranslatorMaintenancePreview {
  if (typeof previewId !== 'string' || !previewId.startsWith(`${gameId}:`)) throw new Error('Maintenance preview does not belong to this game.');
  const entry = translatorMaintenanceById.get(previewId);
  if (!entry || entry.gameId !== gameId || entry.path !== requireGamePath(gameId)) throw new Error(t('ui.maintenance.reason.stale'));
  return entry.preview;
}

/* ------------------------------------------------------------- window */

function appSecurityScanner(): ReturnType<typeof createSecurityScanner> {
  if (process.env['INDIEDECK_SMOKE'] !== '1') return createSecurityScanner();
  // Offline smoke profiles never invoke the user's native antivirus. The
  // explicit test flag enables fixture results, never production scan evidence.
  const ready = process.env['INDIEDECK_SMOKE_SECURITY'] === '1';
  const status = async () => ({ provider: 'microsoft-defender' as const, state: ready ? 'ready' as const : 'unavailable' as const,
    policy: 'existing-defender-policy' as const, ...(ready ? { engineVersion: '1.0.0', signatureVersion: '1.0.0', signatureAgeDays: 0 } : { reason: 'engine-missing' as const }) });
  return {
    status,
    scanTarget: async (target, options = {}) => {
      const startedAt = new Date().toISOString();
      while (smokeSecurityHold && !options.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 30));
      if (!ready || options.signal?.aborted) return { provider: 'microsoft-defender', verdict: 'not-checked',
        reason: options.signal?.aborted ? 'cancelled' : 'engine-missing', startedAt, completedAt: new Date().toISOString() };
      const fingerprint = await fingerprintSecurityTarget(target, { signal: options.signal });
      return { provider: 'microsoft-defender', verdict: smokeSecurityVerdict,
        ...(smokeSecurityVerdict === 'attention' ? { reason: 'engine-attention' as const } : smokeSecurityVerdict === 'not-checked' ? { reason: 'engine-error' as const } : {}),
        startedAt, completedAt: new Date().toISOString(), fingerprint, engineVersion: '1.0.0', signatureVersion: '1.0.0' };
    },
    updateSignatures: async () => ({ provider: 'microsoft-defender', state: ready ? 'updated' : 'not-updated', status: await status(), changed: false }),
  };
}

function declaredExternalUrls(): Set<string> {
  const font = registry.fonts.source;
  return new Set([
    LAUNCHER_RELEASE_URL, 'https://mtool.app/tutorial.php?lang=en',
    ...registry.translators.flatMap((item) => item.homepage ? [item.homepage] : []),
    ...registry.loaders.flatMap((item) => item.homepage ? [item.homepage] : []),
    ...registry.compat.rules.flatMap((item) => item.sources ?? []),
    ...(font.repo ? [`https://github.com/${font.repo}/releases/tag/${font.tag ?? 'latest'}`] : font.url ? [font.url] : []),
  ]);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#12131a',
    title: 'IndieDeck',
    show: false,
    fullscreen: queuedEntry?.fullscreen === true,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow = window;
  window.on('enter-full-screen', publishGamingState);
  window.on('leave-full-screen', publishGamingState);
  window.on('minimize', publishGamingState);
  window.on('hide', publishGamingState);
  window.on('show', publishGamingState);
  window.on('restore', () => { minimizedForGame = false; publishGamingState(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    callback({ cancel: details.webContentsId === window.webContents.id });
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  void window.loadFile(path.join(here, '..', 'renderer', 'index.html'));

  // Anything that wants to leave the app goes to the real browser, never to a
  // new Electron window with node access.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = safeExternalUrl(url, declaredExternalUrls());
    if (allowed) void shell.openExternal(allowed);
    return { action: 'deny' };
  });

  // loadFile() above is the one navigation the app initiates.  Any later page
  // navigation is renderer-controlled and must be denied: a different local
  // HTML file would otherwise inherit this window's privileged preload bridge.
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  // Closing a window while a download, install, uninstall or config write is
  // in flight could interrupt its rollback journal.  Mutations are counted in
  // main (not trusted renderer state), so a normal quit—and therefore an
  // updater install—cannot begin until every queued write has settled.
  let closeNoticeOpen = false;
  window.on('close', (event) => {
    if (pendingMutations === 0 && !operations.isActive()) return;
    event.preventDefault();
    if (closeNoticeOpen) return;
    closeNoticeOpen = true;
    void dialog
      .showMessageBox(window, {
        type: 'info',
        title: t('ui.busy.closeTitle', undefined, 'IndieDeck is still working'),
        message: t(
          'ui.busy.closeBody',
          undefined,
          'Wait for the current file operation to finish before closing IndieDeck.',
        ),
      })
      .finally(() => {
        closeNoticeOpen = false;
      });
  });
  // Never launch an updater installer during Windows logoff/shutdown.
  window.on('query-session-end', () => { sessionEnding = true; });
  window.on('session-end', () => { sessionEnding = true; });

  // INDIEDECK_DEBUG=1 pipes renderer console output to the terminal, which is
  // the only way to see a renderer error when devtools are closed.
  if (process.env['INDIEDECK_DEBUG'] || process.env['INDIEDECK_SMOKE']) {
    window.webContents.on('console-message', (details) => {
      console.log(`[renderer:${details.level}] ${details.message}  (${details.sourceId}:${details.lineNumber})`);
    });
    window.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`[renderer] failed to load: ${description} (${code})`);
    });
    if (process.env['INDIEDECK_DEBUG']) window.webContents.openDevTools({ mode: 'detach' });
  }

  // INDIEDECK_SMOKE=1 boots the window, waits for the library to render, prints
  // what it found and exits. Used in CI to catch a renderer that silently fails
  // to start, which no unit test would notice.
  if (process.env['INDIEDECK_SMOKE']) {
    void runSmokeTest(window).catch((err: unknown) => {
      console.error(`[smoke] ${err instanceof Error ? err.message : String(err)}`);
      app.exit(1);
    });
  }
}

async function runSmokeTest(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastState: { ready: boolean; gamingMode: boolean; engines: number } | undefined;
  await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()));

  while (Date.now() < deadline) {
    const report = (await window.webContents.executeJavaScript(
      `({
        ready: document.body.dataset.libraryState === 'ready',
        games: document.querySelectorAll('#gameList .game').length,
        engines: document.querySelectorAll('#engineFilters button').length,
        status: document.getElementById('status')?.textContent ?? '',
        counts: document.getElementById('counts')?.textContent ?? '',
        gamingMode: document.body.dataset.gamingMode === 'true',
      })`,
    )) as { ready: boolean; games: number; engines: number; status: string; counts: string; gamingMode: boolean };
    lastState = { ready: report.ready, gamingMode: report.gamingMode, engines: report.engines };

    // Waits on a data attribute, not on English prose - the launcher is
    // translated, so the status line is not a stable signal.
    if (report.ready && report.engines > 0 && (!process.argv.includes('--fullscreen') || report.gamingMode && window.isFullScreen())) {
      const localeReports = availableLocales();
      if (localeReports.some((locale) => locale.keys === 0)) {
        console.error(`[smoke] packaged locale catalogue missing: ${localeReports.filter((locale) => locale.keys === 0).map((locale) => locale.code).join(', ')}`);
        app.exit(1);
        return;
      }
      console.log(`[smoke] rendered ${report.games} game rows, ${report.engines} engine filters - ${report.counts || report.status}`);
      console.log('[smoke] startup verified ' + JSON.stringify({ fullscreenRequested: process.argv.includes('--fullscreen'),
        nativeFullscreen: window.isFullScreen(), rendererGamingMode: report.gamingMode }));
      const detail = (await window.webContents.executeJavaScript(
        `(async () => {
          const first = document.querySelector('#gameList .game');
          if (!first) return { skipped: true };
          first.click();
          await new Promise((r) => setTimeout(r, 4000));
          return {
            title: document.querySelector('#detail h1')?.textContent ?? '',
            plans: document.querySelectorAll('#detail .plan').length,
            configRows: document.querySelectorAll('#configPanel .cfg-row').length,
            configSections: document.querySelectorAll('#configPanel .cfg-section').length,
            configText: (document.getElementById('configPanel')?.textContent ?? '(no panel)').slice(0, 160),
            facts: document.querySelectorAll('#detail .facts dt').length,
          };
        })()`,
      )) as { skipped?: boolean; title?: string; plans?: number; facts?: number; configRows?: number; configSections?: number; configText?: string };

      if (detail.skipped) console.log('[smoke] no games indexed - detail panel not exercised');
      else console.log(`[smoke] detail for "${detail.title}": ${detail.facts} facts, ${detail.plans} translator plans, ${detail.configSections} config sections / ${detail.configRows} settings`);
      if (process.env['INDIEDECK_DEBUG']) console.log(`[smoke] config panel says: ${detail.configText}`);

      const companion = await exportBrowserCompanion(bundleRoot, defaultDataDir(), app.getVersion());
      const companionManifest = JSON.parse(await readFile(path.join(companion, 'chromium', 'manifest.json'), 'utf8'));
      if (companionManifest.version !== app.getVersion()) throw new Error('Packaged companion version disagrees with the launcher.');
      console.log('[smoke] bundled browser companion exported and version verified; no browser profile was changed');

      if (process.env['INDIEDECK_SMOKE_FLOW'] === '1') {
        await runSecuritySmoke(window);
        await runOperationSmoke(window);
      } else if (process.env['INDIEDECK_SMOKE_SECURITY'] === '1') await runSecuritySmoke(window);
      if (process.env['INDIEDECK_SMOKE_HISTORY']) await runComparisonHistorySmoke(window, process.env['INDIEDECK_SMOKE_HISTORY']);

      const shot = process.env['INDIEDECK_SCREENSHOT'];
      if (shot) {
        // Optionally frame a particular part of the page for documentation shots.
        const selector = process.env['INDIEDECK_SCREENSHOT_SELECTOR'];
        if (selector) {
          await window.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
        // DOM readiness can precede the first compositor frame for an empty
        // library. Wait for paint before capturing the packaged smoke window.
        await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const image = await window.webContents.capturePage(undefined, { stayAwake: true });
        await writeFile(shot, image.toPNG());
        console.log(`[smoke] screenshot written to ${shot}`);
      }

      app.exit(0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.error('[smoke] renderer did not finish loading within 20s; startup=' + JSON.stringify({
    entryValid: entryArguments(process.argv).valid, fullscreenRequested: process.argv.includes('--fullscreen'),
    nativeFullscreen: window.isFullScreen(), visible: window.isVisible(), rendererReady, ownsInstance, renderer: lastState,
  }));
  app.exit(1);
}

async function runSecuritySmoke(window: BrowserWindow): Promise<void> {
  if (process.env['INDIEDECK_SMOKE_SECURITY'] !== '1') throw new Error('Offline security fixtures were not enabled.');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(`(async () => (${source}))()`);
  const waitFor = async (source: string, label: string) => {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      if (await evaluate<boolean>(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Security smoke timed out: ${label}`);
  };
  const gameId = await evaluate<string>(`(async () => (await import('./store.js')).state.selected)()`);
  const before = await fingerprintSecurityTarget(requireGamePath(gameId));
  await waitFor(`!!document.querySelector('#gameSecurityBody .game-security-scan:not(:disabled)')`, 'ready engine and game scan');
  smokeSecurityHold = true;
  await evaluate(`document.querySelector('#gameSecurityBody .game-security-scan').click()`);
  await waitFor(`(async () => (await window.indiedeck.security.current()).task?.status === 'running')()`, 'running scan handshake');
  const busy = await evaluate<boolean>(`(async () => {
    const checks = await Promise.allSettled([window.indiedeck.security.update(), window.indiedeck.game.launch(${JSON.stringify(gameId)})]);
    return checks.every(item => item.status === 'rejected');
  })()`);
  if (!busy) throw new Error('A running security scan did not reserve the file-operation slot.');
  await new Promise<void>((resolve) => { window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload(); });
  await waitFor(`!!document.querySelector('#securitySettingsBody .security-cancel:not(:disabled)')`, 'scan recovery after reload');
  await evaluate(`document.querySelector('#securitySettingsBody .security-cancel').click()`);
  smokeSecurityHold = false;
  await waitFor(`(async () => (await window.indiedeck.security.current()).task?.status === 'cancelled')()`, 'cancelled scan');
  await waitFor(`document.body.dataset.libraryState === 'ready'`, 'library after scan cancellation');
  await evaluate(`(() => { document.getElementById('closeSettings').click(); window.dispatchEvent(new CustomEvent('indiedeck:select-game', {detail:{gameId:${JSON.stringify(gameId)}}})); })()`);
  await waitFor(`!!document.querySelector('#gameSecurityBody .game-security-scan:not(:disabled)')`, 'game after scan recovery');
  for (const verdict of ['attention', 'not-checked'] as const) {
    smokeSecurityVerdict = verdict;
    await evaluate(`document.querySelector('#gameSecurityBody .game-security-scan').click()`);
    await waitFor(`!!document.querySelector('#gameSecurityBody .security-result[data-verdict="${verdict}"]')`, `${verdict} result`);
    const stopped = await evaluate<boolean>(`(async () => {
      const { t } = await import('./i18n.js');
      try { await window.indiedeck.game.launch(${JSON.stringify(gameId)}); return false; }
      catch(error) { return error.message === t('ui.security.block.${verdict === 'attention' ? 'attention' : 'notChecked'}'); }
    })()`);
    if (!stopped) throw new Error('An incomplete or attention scan did not block game execution.');
    const stoppedMod = await evaluate<boolean>(`(async () => {
      const { state } = await import('./store.js'); const { t } = await import('./i18n.js');
      const mod = state.detail.mods.find(item => !item.enabled && item.file.endsWith('SecurityProbe.dll.disabled'));
      if (!mod) return false;
      try { await window.indiedeck.mods.toggle(state.selected, mod.id, true); return false; }
      catch(error) { return error.message === t('ui.security.block.${verdict === 'attention' ? 'attention' : 'notChecked'}'); }
    })()`);
    if (!stoppedMod) throw new Error('An incomplete or attention scan did not block mod activation.');
  }
  const rejectsUnknown = await evaluate<boolean>(`(async () => {
    for (const action of [() => window.indiedeck.security.scanGame('../outside'),
      () => window.indiedeck.security.scanGame('0000000000000000'),
      () => window.indiedeck.security.openHelp('https://untrusted.invalid'),
      () => window.indiedeck.open.url('https://127.0.0.1/private')]) {
      try { await action(); return false; } catch {}
    }
    return true;
  })()`);
  if (!rejectsUnknown) throw new Error('Security IPC accepted an arbitrary target or helper action.');
  const foreign = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(here, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  try {
    await foreign.loadFile(path.join(here, '..', 'renderer', 'index.html'));
    const denied = await foreign.webContents.executeJavaScript(`window.indiedeck.security.current().then(() => false, () => true)`);
    if (!denied) throw new Error('A second window inherited the main window IPC authority.');
  } finally { foreign.destroy(); }
  smokeSecurityVerdict = 'clean';
  await evaluate(`document.getElementById('openSettings').click()`);
  await waitFor(`!!document.querySelector('#securitySettingsBody .security-update:not(:disabled)')`, 'security update action');
  await evaluate(`document.querySelector('#securitySettingsBody .security-update').click()`);
  await waitFor(`(async () => {const task=(await window.indiedeck.security.current()).task; return task?.kind==='signature-update' && task.status==='complete';})()`, 'explicit mocked signature update');
  await evaluate(`document.getElementById('securitySettings').scrollIntoView({block:'start'})`);
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (process.env['INDIEDECK_SECURITY_SCREENSHOT']) await writeFile(process.env['INDIEDECK_SECURITY_SCREENSHOT'], (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.getElementById('closeSettings').click()`);
  const after = await fingerprintSecurityTarget(requireGamePath(gameId));
  if (before.sha256 !== after.sha256) throw new Error('Security review changed fixture game bytes.');
  console.log('[smoke] mocked security gates: scoped scan → reload/cancel → attention/error game and mod activation blocked → foreign IPC rejected → explicit signature update; unchanged game bytes, no real scan/update/game process');
}

/** Separate main processes exercise durable history rather than a renderer
 * reload that would leave an in-memory report available. */
async function runComparisonHistorySmoke(window: BrowserWindow, mode: string): Promise<void> {
  if (!['view', 'clear', 'empty', 'damaged'].includes(mode)) throw new Error('Unknown comparison history smoke mode.');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(`(async () => (${source}))()`);
  const waitFor = async (source: string, label: string) => {
    const end = Date.now() + 12_000;
    while (Date.now() < end) {
      if (await evaluate<boolean>(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Comparison history smoke timed out: ${label}`);
  };
  await waitFor(`(async () => !!(await import('./store.js')).state.detail?.comparisonHistory)()`, 'history detail');
  if (mode === 'view' || mode === 'clear') {
    await waitFor(`!!document.querySelector('#detail .last-option-comparison')`, 'saved report action');
    const persisted = await evaluate<boolean>(`(async () => {
      const { state } = await import('./store.js'); const item = state.detail.comparisonHistory.record;
      return item?.persistent === true && Number.isFinite(Date.parse(item.recordedAt))
        && item.hiddenValueIds.includes('xunity.translationDirectory')
        && !JSON.stringify(item).includes('SyntheticPrivate');
    })()`);
    if (!persisted) throw new Error('History was not restored with safe values from disk.');
  }
  if (mode === 'view') {
    const rejectsUnknown = await evaluate<boolean>(`(async () => {
      for (const id of ['0000000000000000', '../outside']) {
        try { await window.indiedeck.translatorConfig.clearHistory(id); return false; } catch {}
      }
      return true;
    })()`);
    if (!rejectsUnknown) throw new Error('History clear accepted an unknown game.');
    await evaluate(`document.querySelector('#detail .last-option-comparison').click()`);
    await waitFor(`!!document.querySelector('#translatorOptionsComparisonDialog[open]')`, 'historical report dialog');
    const language = await evaluate<string>(`document.querySelector('#translatorOptionsComparisonDialog .comparison-row[data-option-id="xunity.targetLanguage"] .comparison-current')?.textContent`);
    if (language !== 'ko') throw new Error('Persisted history lost the previous translation language.');
    const directory = await evaluate<string>(`document.querySelector('#translatorOptionsComparisonDialog .comparison-row[data-option-id="xunity.translationDirectory"] .comparison-current')?.textContent`);
    if (!directory || /SyntheticPrivate|Unknown|확인 불가/.test(directory)) throw new Error('Private saved values were not distinguished from unknown values.');
    const screenshot = process.env['INDIEDECK_HISTORY_SCREENSHOT'];
    if (screenshot) {
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    }
  } else if (mode === 'clear') {
    await evaluate(`document.querySelector('#detail .comparison-history-clear').click()`);
    await waitFor(`!!document.querySelector('#comparisonHistoryClearDialog[open] .comparison-history-confirm-clear')`, 'clear record confirmation');
    await evaluate(`document.querySelector('#comparisonHistoryClearDialog .comparison-history-confirm-clear').click()`);
    await waitFor(`(async () => {
      const { state } = await import('./store.js');
      return !state.detail?.comparisonHistory?.record && !document.querySelector('#detail .last-option-comparison');
    })()`, 'record removed');
  } else if (mode === 'empty') {
    const empty = await evaluate<boolean>(`(async () => {
      const { state } = await import('./store.js');
      return state.detail.comparisonHistory.state === 'ready' && !state.detail.comparisonHistory.record
        && !document.querySelector('#detail .last-option-comparison');
    })()`);
    if (!empty) throw new Error('Cleared history reappeared after an application restart.');
  } else {
    await waitFor(`!!document.querySelector('#detail .comparison-history-unavailable')`, 'damaged history notice');
    const isolated = await evaluate<boolean>(`(async () => {
      const { state } = await import('./store.js');
      return state.detail.comparisonHistory.state === 'unavailable' && !state.detail.comparisonHistory.record
        && !!document.querySelector('#detail h1') && !!document.querySelector('#detail .plan');
    })()`);
    if (!isolated) throw new Error('Damaged history blocked ordinary game details.');
    const protectedFile = await evaluate<boolean>(`(async () => {
      const { state } = await import('./store.js');
      try { await window.indiedeck.translatorConfig.clearHistory(state.selected); return false; } catch { return true; }
    })()`);
    if (!protectedFile) throw new Error('Damaged history could be overwritten through clear IPC.');
  }
  console.log(`[smoke] comparison history ${mode} passed`);
}

/** Exercises the real renderer/preload/main/core flow using only the disposable
 * fixtures and offline fetch implementation in scripts/desktop-flow-bootstrap. */
async function runOperationSmoke(window: BrowserWindow): Promise<void> {
  const evaluate = async <T>(source: string): Promise<T> => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try { return await (${source}); }
      catch (error) { return { __smokeError: String(error.stack ?? error) }; }
    })()`) as T & { __smokeError?: string };
    if (result?.__smokeError) throw new Error(`Renderer flow check failed: ${result.__smokeError}`);
    return result;
  };
  const waitFor = async (source: string, label: string, timeout = 15_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate<boolean>(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Operation smoke timed out: ${label}`);
  };
  const start = await evaluate<{ gameId: string; operationId?: string; immediate: boolean }>(`(async () => {
    const { state } = await import('./store.js');
    const gameId = state.selected;
    const font = document.querySelector('#detail .plan .include-font');
    if (!font?.checked || font.disabled) throw new Error('The font opt-out control was not available.');
    font.checked = false; font.dispatchEvent(new Event('change'));
    const button = document.querySelector('#detail .plan .install');
    if (!button) throw new Error('No viable translator plan in the smoke fixture.');
    button.click();
    return { gameId, operationId: state.operation?.operationId,
      immediate: !!state.operation && !!document.querySelector('#detail progress') };
  })()`);
  if (!start.immediate) throw new Error('Install progress did not appear in the click frame.');
  await waitFor(`(async () => {
    const op = (await import('./store.js')).state.operation;
    const bar = document.querySelector('#detail .operation-progress');
    return op?.phase === 'download' && op.received > 0 && op.received < op.total
      && bar && bar.value >= 10 && bar.value < 90;
  })()`, 'streamed download progress');
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const progressShot = process.env['INDIEDECK_FLOW_PROGRESS_SCREENSHOT'];
  if (progressShot) await writeFile(progressShot, (await window.webContents.capturePage()).toPNG());
  await evaluate(`(() => {
    document.querySelectorAll('#gameList .game')[1].click();
    document.getElementById('openSettings').click();
  })()`);
  const settings = await evaluate<boolean>(`!document.getElementById('taskStatus').hidden && document.getElementById('saveDefaults').disabled`);
  if (!settings) throw new Error('Settings lost the active operation or enabled a file mutation.');
  const busyMTool = await evaluate<boolean>(`(async () => {
    const { api, state } = await import('./store.js');
    if (!document.getElementById('mtoolPick').disabled || !document.getElementById('mtoolClear').disabled) return false;
    try { await api.mtool.launch(state.games.find((game) => game.engineId === 'rpgmaker-mv').id); return false; }
    catch { return true; }
  })()`);
  if (!busyMTool) throw new Error('MTool handoff was permitted during an active file operation.');
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve());
    window.webContents.reload();
  });
  await waitFor(`(async () => !!(await import('./store.js')).state.operation)()`, 'reload snapshot recovery');
  await waitFor(`(async () => !!(await import('./store.js')).state.operation?.outcome)()`, 'terminal outcome');
  await waitFor(`document.body.dataset.libraryState === 'ready'`, 'library after operation');
  const installed = await evaluate<{ status?: string; refreshStatus?: string; translated: number; revision: number; pending?: string[] }>(`(async () => {
    const { state } = await import('./store.js');
    return { status: state.operation?.outcome?.status, refreshStatus: state.operation?.outcome?.refreshStatus,
      translated: state.stats?.withTranslator, revision: state.libraryRevision,
      pending: state.operation?.outcome?.result?.pendingUserActions };
  })()`);
  if (installed.status !== 'success' || installed.refreshStatus !== 'complete' || installed.translated !== 1) {
    throw new Error(`Install did not atomically refresh the game list: ${JSON.stringify(installed)}`);
  }
  await evaluate(`document.getElementById('taskStatus').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.detail?.profile.id === ${JSON.stringify(start.gameId)}
      && !!document.querySelector('#detail .detail-sticky .operation-card.ok');
  })()`, 'completed operation detail');
  const settingsFile = path.join(requireGamePath(start.gameId), 'BepInEx/config/AutoTranslatorConfig.ini');
  const settingsBeforePreview = await readFile(settingsFile);
  await waitFor(`!!document.querySelector('#configPanel select[data-setting-id="xunity.targetLanguage"]')`, 'game translation settings');
  await evaluate(`(() => {
    const target = document.querySelector('#configPanel select[data-setting-id="xunity.targetLanguage"]');
    target.value = 'en'; target.dispatchEvent(new Event('change'));
    document.querySelector('#cfgFooter button.ghost').click();
  })()`);
  await waitFor(`document.getElementById('cfgLog')?.dataset.outcome === 'preview'`, 'config preview feedback');
  if (!(await readFile(settingsFile)).equals(settingsBeforePreview)) throw new Error('Translation option preview wrote the game config.');
  await evaluate(`document.querySelector('#cfgFooter button.primary').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return document.getElementById('cfgLog')?.dataset.outcome === 'saved'
      && state.translatorConfigs.get(state.selected)?.config.values.find(value => value.id === 'xunity.targetLanguage')?.value === 'en'
      && state.detail?.fontRecommendation?.status === 'not-needed';
  })()`, 'saved settings feedback and font recommendation refresh');
  await evaluate(`(() => {
    const engine = document.querySelector('#configPanel select[data-setting-id="xunity.endpoint"]');
    engine.value = 'GoogleTranslateV2'; engine.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(`!!document.querySelector('#configPanel button[data-setting-id="provider:GoogleTranslateV2:UseSimplest"]')`, 'non-secret engine option');
  await evaluate(`(() => {
    document.querySelector('#configPanel button[data-setting-id="provider:GoogleTranslateV2:UseSimplest"]').click();
    document.querySelector('#cfgFooter button.primary').click();
  })()`);
  await waitFor(`document.getElementById('cfgLog')?.dataset.outcome === 'saved'
    && document.querySelector('#configPanel button[data-setting-id="provider:GoogleTranslateV2:UseSimplest"]')?.getAttribute('aria-pressed') === 'true'`, 'saved provider boolean reflects actual config');
  await evaluate(`(() => {
    const fallback = document.querySelector('#configPanel select[data-setting-id="xunity.fallbackEndpoint"]');
    fallback.value = 'DeepLTranslateLegitimate'; fallback.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(`!!document.querySelector('#configPanel input[data-setting-id="provider:DeepLTranslateLegitimate:ApiKey"]')`, 'fallback engine credential controls');
  await evaluate(`document.querySelector('#cfgFooter button:last-child').click()`);
  await evaluate(`(() => {
    for (const [id,value] of [['xunity.targetLanguage','ko'],['xunity.endpoint','GoogleTranslate']]) {
      const field = document.querySelector('#configPanel select[data-setting-id="'+id+'"]');
      field.value = value; field.dispatchEvent(new Event('change'));
    }
    document.querySelector('#cfgFooter button.primary').click();
  })()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return document.getElementById('cfgLog')?.dataset.outcome === 'saved'
      && state.translatorConfigs.get(state.selected)?.config.values.find(value => value.id === 'xunity.targetLanguage')?.value === 'ko'
      && state.detail?.fontRecommendation?.status === 'recommended';
  })()`, 'restored game options before existing font scenarios');
  const settingsAfter = await readFile(settingsFile, 'utf8');
  if (!settingsAfter.includes('UseSimplest=True') || (await loadConfig()).defaults.targetLanguage !== 'ko') throw new Error('Provider options or launcher defaults were unexpectedly changed.');
  console.log('[smoke] translation form preview/save → persistent feedback → non-secret provider boolean → fallback controls → independent launcher defaults passed');
  // Restore this disposable fixture before independent font ownership tests.
  // Actual user edits must never become removable original files via a font.
  await writeFile(settingsFile, settingsBeforePreview);
  await evaluate(`(async () => {
    const { state } = await import('./store.js'); state.translatorConfigs.delete(state.selected);
    window.dispatchEvent(new CustomEvent('indiedeck:refresh-detail'));
  })()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.detail?.fontRecommendation?.status === 'recommended'
      && state.translatorConfigs.get(state.selected)?.config?.values?.some(value => value.id === 'xunity.targetLanguage' && value.value === 'ko');
  })()`, 'restored independent font fixture');
  const fontBefore = await evaluate<{ bundles: string[]; hasPlan: boolean; recommendation: unknown }>(`(async () => {
    const { state } = await import('./store.js');
    return { bundles: state.detail?.profile.installedFontBundles, hasPlan: !!state.detail.fontPlan,
      recommendation: state.detail?.fontRecommendation };
  })()`);
  if (fontBefore.bundles.length !== 0 || !fontBefore.hasPlan) throw new Error(`Font opt-out did not allow later font maintenance: ${JSON.stringify(fontBefore)}`);
  const gamePath = requireGamePath(start.gameId);
  const dllPath = path.join(gamePath, 'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll');
  const beforeHash = crypto.createHash('sha256').update(await readFile(dllPath)).digest('hex');
  const beforeMtime = (await stat(dllPath)).mtimeMs;
  await evaluate(`document.querySelector('#detail .install-font').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.operation?.kind === 'install-font' && !!state.operation.outcome;
  })()`, 'standalone font outcome');
  const fontAdded = await evaluate<{ status: string; refreshStatus: string; recommendation: string; bundles: string[]; receipts: string[] }>(`(async () => {
    const { state } = await import('./store.js');
    return { status: state.operation.outcome.status, refreshStatus: state.operation.outcome.refreshStatus,
      recommendation: state.detail.fontRecommendation.status, bundles: state.detail.profile.installedFontBundles,
      receipts: state.detail.receipts.map((receipt) => receipt.kind) };
  })()`);
  if (fontAdded.status !== 'success' || fontAdded.refreshStatus !== 'complete' || fontAdded.recommendation !== 'installed' ||
      !fontAdded.bundles.includes('arialuni_sdf_u2019') || !fontAdded.receipts.includes('font')) {
    throw new Error(`Font maintenance did not refresh its file/config/receipt state: ${JSON.stringify(fontAdded)}`);
  }
  if (beforeHash !== crypto.createHash('sha256').update(await readFile(dllPath)).digest('hex') || beforeMtime !== (await stat(dllPath)).mtimeMs) {
    throw new Error('Font-only maintenance rewrote the translator payload.');
  }
  const fontConfigText = await readFile(path.join(gamePath, 'BepInEx/config/AutoTranslatorConfig.ini'), 'utf8');
  if (!fontConfigText.includes('Language=ko') || !fontConfigText.includes('Endpoint=GoogleTranslate') || !fontConfigText.includes('FallbackFontTextMeshPro=arialuni_sdf_u2019')) {
    throw new Error('Font-only maintenance changed or omitted the language/provider/fallback settings.');
  }
  const evidence = collectTranslatorEvidence(registry, requireDetectedGame(start.gameId), { targetLanguage: 'ko' });
  if (evidence.some((entry) => entry.healthIssues.includes('managed-drift'))) throw new Error('A legitimate font overlay was classified as translator drift.');
  const fontShot = process.env['INDIEDECK_FONT_SCREENSHOT'];
  if (fontShot) {
    await evaluate(`document.querySelector('#detail .font-recommendation').scrollIntoView({ block: 'center' })`);
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await writeFile(fontShot, (await window.webContents.capturePage()).toPNG());
  }
  window.setSize(1000, 680);
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const visible = await evaluate<boolean>(`(() => {
    const panel = document.getElementById('detail'); panel.scrollTop = panel.scrollHeight;
    const sticky = document.querySelector('.detail-sticky').getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return sticky.top >= bounds.top - 1 && sticky.bottom <= bounds.bottom;
  })()`);
  if (!visible) throw new Error('Sticky game actions escaped the small-window detail viewport.');
  const shot = process.env['INDIEDECK_FLOW_SCREENSHOT'];
  if (shot) await writeFile(shot, (await window.webContents.capturePage()).toPNG());

  // Duplicate/manual old payload beside a managed translator: keep the loader,
  // unrelated mod, user configuration, translations and font overlay untouched.
  const duplicateRel = 'Mods/XUnity.AutoTranslator.Plugin.MelonMod.dll';
  const userFiles = [
    'Mods/OtherMod.dll', 'BepInEx/Translation/ko/_AutoGeneratedTranslations.txt',
  ];
  for (const rel of [duplicateRel, ...userFiles]) {
    const target = path.join(gamePath, rel);
    await (await import('node:fs/promises')).mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rel === duplicateRel ? Buffer.from('ProductVersion5.4.0\0', 'utf16le') : 'user fixture kept byte-for-byte');
  }
  const preserved = [path.join(gamePath, 'Game.exe'), path.join(gamePath, 'BepInEx/core/BepInEx.dll'),
    path.join(gamePath, 'BepInEx/config/AutoTranslatorConfig.ini'), path.join(gamePath, 'arialuni_sdf_u2019'),
    ...userFiles.map((rel) => path.join(gamePath, rel))];
  const preservedHashes = await Promise.all(preserved.map(async (file) => crypto.createHash('sha256').update(await readFile(file)).digest('hex')));
  await evaluate(`window.dispatchEvent(new CustomEvent('indiedeck:refresh-detail'))`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.detail?.translatorMaintenance?.canReinstall
      && state.detail.translatorMaintenance.files.some((file) => file.path === ${JSON.stringify(duplicateRel)});
  })()`, 'safe duplicate cleanup preview');
  await evaluate(`document.querySelector('#detail .translator-reinstall').click()`);
  const previewConfirmed = await evaluate<boolean>(`!!document.querySelector('#translatorMaintenanceConfirm[open] .translator-confirm')`);
  if (!previewConfirmed || !(await stat(path.join(gamePath, duplicateRel))).isFile()) throw new Error('Cleanup deleted files before confirmation.');
  const comparisonReviewed = await evaluate<boolean>(`(async () => {
    const { state } = await import('./store.js');
    const report = state.detail.translatorMaintenance.optionComparison;
    const row = document.querySelector('#translatorMaintenanceConfirm .comparison-row[data-option-id="xunity.targetLanguage"]');
    return report?.available === true && report.preservesConfig === true && report.migrationSimulated === false
      && row?.querySelector('.comparison-current')?.textContent === 'ko'
      && row?.querySelector('.comparison-target')?.textContent === 'en';
  })()`);
  if (!comparisonReviewed) throw new Error('Reinstall review did not distinguish current settings from reference defaults.');
  window.setSize(1360, 880);
  const maintenanceShot = process.env['INDIEDECK_MAINTENANCE_SCREENSHOT'];
  if (maintenanceShot) await writeFile(maintenanceShot, (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('#translatorMaintenanceConfirm .translator-confirm').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.operation?.kind === 'reinstall-translator' && !!state.operation.outcome;
  })()`, 'duplicate cleanup and managed reinstall');
  const maintained = await evaluate<{ status: string; backup: string; files: string[] }>(`(async () => {
    const { state } = await import('./store.js');
    return { status: state.operation.outcome.status, backup: state.operation.outcome.result?.backupDirectory,
      files: state.operation.outcome.result?.removed ?? [] };
  })()`);
  if (maintained.status !== 'success' || !maintained.backup || !maintained.files.includes(duplicateRel)) {
    throw new Error(`Safe reinstall did not complete: ${JSON.stringify(maintained)}`);
  }
  if (await stat(path.join(gamePath, duplicateRel)).then(() => true, () => false)) throw new Error('Duplicate old variant survived cleanup.');
  if (!(await stat(path.join(maintained.backup, 'files', duplicateRel))).isFile()) throw new Error('Cleanup discarded the old payload without a backup.');
  for (let index = 0; index < preserved.length; index++) {
    if (crypto.createHash('sha256').update(await readFile(preserved[index]!)).digest('hex') !== preservedHashes[index]) {
      throw new Error(`Translator maintenance changed a preserved game/user file: ${preserved[index]}`);
    }
  }
  await waitFor(`!!document.querySelector('#detail .operation-comparison-open')`, 'retained pre-reinstall option report');
  await evaluate(`document.querySelector('#detail .operation-comparison-open').click()`);
  await waitFor(`!!document.querySelector('#translatorOptionsComparisonDialog[open] .comparison-row[data-option-id="xunity.targetLanguage"]')`, 'post-reinstall comparison review');
  await evaluate(`document.querySelector('#translatorOptionsComparisonDialog button').click()`);
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload();
  });
  await waitFor(`document.body.dataset.libraryState === 'ready'`, 'library after comparison report reload');
  await evaluate(`window.dispatchEvent(new CustomEvent('indiedeck:select-game', { detail: { gameId: '${start.gameId}' } }))`);
  await waitFor(`!!document.querySelector('#detail .last-option-comparison')`, 'session comparison survives operation acknowledgement and renderer reload');
  await evaluate(`document.querySelector('#detail .last-option-comparison').click()`);
  const retainedComparison = await evaluate<boolean>(`document.querySelector('#translatorOptionsComparisonDialog .comparison-row[data-option-id="xunity.targetLanguage"] .comparison-current')?.textContent === 'ko'`);
  if (!retainedComparison) throw new Error('Reinstall report disappeared after operation acknowledgement/reload.');
  await evaluate(`document.querySelector('#translatorOptionsComparisonDialog button').click()`);
  const settingsBeforeHistoryDelete = await readFile(settingsFile);
  await evaluate(`(() => {
    const target = document.querySelector('#configPanel select[data-setting-id="xunity.targetLanguage"]');
    target.value = 'en'; target.dispatchEvent(new Event('change'));
    document.querySelector('#detail .comparison-history-clear').click();
    document.querySelector('#comparisonHistoryClearDialog .comparison-history-confirm-clear').click();
  })()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.detail?.comparisonHistory?.record && !document.querySelector('#detail .last-option-comparison');
  })()`, 'saved comparison deletion');
  const draftRetained = await evaluate<boolean>(`document.querySelector('#configPanel select[data-setting-id="xunity.targetLanguage"]')?.value === 'en'
    && !document.querySelector('#cfgFooter button.primary')?.disabled`);
  if (!draftRetained) throw new Error('Deleting launcher history discarded an unsaved translation option.');
  await evaluate(`document.querySelector('#cfgFooter button:last-child').click()`);
  if (!(await readFile(settingsFile)).equals(settingsBeforeHistoryDelete)) throw new Error('Deleting launcher history changed game settings.');
  console.log('[smoke] exact-file confirmation → duplicate cleanup/reinstall → retained backup and unchanged loader/mod/config/translation/font passed');

  await evaluate(`document.querySelector('#detail .uninstall').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.operation?.kind === 'uninstall' && !!state.operation.outcome;
  })()`, 'removal outcome');
  const removed = await evaluate<{ status?: string; translated: number; revision: number }>(`(async () => {
    const { state } = await import('./store.js');
    return { status: state.operation?.outcome?.status, translated: state.stats?.withTranslator, revision: state.libraryRevision };
  })()`);
  if (removed.status !== 'success' || removed.translated !== 0 || removed.revision <= installed.revision) {
    throw new Error(`Removal did not refresh translator badges/statistics: ${JSON.stringify(removed)}`);
  }
  if (requireDetectedGame(start.gameId).installedFontBundles.length) throw new Error('Uninstall left the managed standalone font behind.');
  // Manually installed payloads can be removed without deleting their user
  // settings. Retained settings must not keep an installed-translator badge.
  await (await import('node:fs/promises')).mkdir(path.dirname(dllPath), { recursive: true });
  await writeFile(dllPath, Buffer.from('ProductVersion5.4.0\0', 'utf16le'));
  const manualConfig = path.join(gamePath, 'BepInEx/config/AutoTranslatorConfig.ini');
  await (await import('node:fs/promises')).mkdir(path.dirname(manualConfig), { recursive: true });
  await writeFile(manualConfig, '[General]\nLanguage=ko\n[Service]\nEndpoint=GoogleTranslate\n');
  const manualConfigBytes = await readFile(manualConfig);
  await evaluate(`window.dispatchEvent(new CustomEvent('indiedeck:refresh-detail'))`);
  await waitFor(`!!document.querySelector('#detail .translator-remove:not(:disabled)')`, 'manual translator cleanup');
  await waitFor(`(async () => (await import('./store.js')).state.detail?.translatorMaintenance?.optionComparison?.currentVersion?.version === '5.4.0')()`, 'old translator option version detection');
  await evaluate(`document.querySelector('#detail .translator-reinstall').click()`);
  const oldOptionComparison = await evaluate<boolean>(`(async () => {
    const { state } = await import('./store.js'); const report = state.detail.translatorMaintenance.optionComparison;
    const introduced = document.querySelector('#translatorMaintenanceConfirm .comparison-row[data-option-id="xunity.enableUIElements"]');
    return report.targetRegistered === true && report.currentVersion.version === '5.4.0'
      && report.rows.some(row => row.id === 'xunity.enableUIElements' && row.introduced === true)
      && introduced?.dataset.status === 'new-default' && !introduced.closest('details');
  })()`);
  if (!oldOptionComparison) throw new Error('Old-to-target option differences were not visible before reinstall.');
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (process.env['INDIEDECK_CONFIG_COMPARISON_SCREENSHOT']) await writeFile(process.env['INDIEDECK_CONFIG_COMPARISON_SCREENSHOT'], (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('#translatorMaintenanceConfirm .maintenance-actions .ghost').click()`);
  if (!(await readFile(manualConfig)).equals(manualConfigBytes)) throw new Error('Reviewing the option comparison modified the settings.');
  await evaluate(`document.querySelector('#detail .translator-remove').click()`);
  await evaluate(`document.querySelector('#translatorMaintenanceConfirm .translator-confirm').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.operation?.kind === 'remove-translator' && state.operation.outcome?.status === 'success'
      && state.stats.withTranslator === 0 && state.detail.profile.installedTranslators.length === 0;
  })()`, 'manual payload removal without false config-only badge');
  if (!(await readFile(manualConfig)).equals(manualConfigBytes) || await stat(dllPath).then(() => true, () => false)) {
    throw new Error('Manual cleanup deleted configuration or retained the active payload.');
  }
  console.log('[smoke] old/current options → registered schema reference → reinstall preservation → retained comparison and old-version option introduction review passed');
  // A different game keeps the default opt-in and exercises the integrated
  // translator + font plan rather than reusing the standalone path above.
  await evaluate(`document.querySelectorAll('#gameList .game')[1].click()`);
  await waitFor(`!!document.querySelector('#detail .plan .include-font')?.checked`, 'second game font opt-in');
  await evaluate(`document.querySelector('#detail .plan .install').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.operation?.kind === 'install' && !!state.operation.outcome;
  })()`, 'integrated font install');
  const integrated = await evaluate<boolean>(`(async () => {
    const { state } = await import('./store.js');
    return state.operation.outcome.status === 'success' && state.detail.fontRecommendation.status === 'installed'
      && state.detail.profile.installedFontBundles.includes('arialuni_sdf_u2019')
      && state.detail.receipts.every((receipt) => receipt.kind !== 'font');
  })()`);
  if (!integrated) throw new Error('The default integrated translator/font plan did not finish safely.');
  await evaluate(`document.querySelector('#detail .uninstall').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.operation?.kind === 'uninstall' && !!state.operation.outcome;
  })()`, 'integrated font removal');
  const secondRemoved = await evaluate<boolean>(`(async () => {
    const { state } = await import('./store.js');
    return state.operation.outcome.status === 'success' && state.stats.withTranslator === 0
      && state.detail.profile.installedFontBundles.length === 0;
  })()`);
  if (!secondRemoved) throw new Error('Integrated font removal left managed files or stale statistics.');
  console.log('[smoke] font opt-out → translator install → reload → standalone font + config/receipt refresh → ordered removal → integrated font install/removal passed');

  const boundary = await evaluate<boolean>(`(async () => {
    const { api, state } = await import('./store.js');
    if (document.querySelector('#detail .mtool-integration')) return false;
    const saved = await api.config.set({ ...state.config, externalTools: { mtoolRoot: 'Z:/renderer-injected' } });
    if (saved.externalTools?.mtoolRoot !== state.config.externalTools?.mtoolRoot) return false;
    for (const id of ['unknown-game-id', ${JSON.stringify(start.gameId)}]) {
      try { await api.mtool.launch(id); return false; } catch { /* expected opaque/engine rejection */ }
    }
    return true;
  })()`);
  if (!boundary) throw new Error('MTool renderer target/settings authority escaped its boundary.');
  await evaluate(`document.querySelectorAll('#gameList .game')[2].click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.detail?.profile.engineId === 'rpgmaker-mv'
      && !!document.querySelector('#detail .mtool-integration.ready .mtool-launch:not(:disabled)');
  })()`, 'RPG Maker MTool card');
  const rpg = await evaluate<{ gameId: string; revision: number; clean: boolean }>(`(async () => {
    const { state } = await import('./store.js');
    return { gameId: state.selected, revision: state.libraryRevision,
      clean: state.detail.mtoolIntegration.autoApply === false && state.stats.withTranslator === 0
        && state.detail.profile.installedTranslators.length === 0 && state.detail.receipts.length === 0 };
  })()`);
  if (!rpg.clean) throw new Error('Connecting MTool invented translator files or install receipts.');
  const mtoolCalls = () => (globalThis as typeof globalThis & {
    __indiedeckMToolSmokeCalls: Array<{ executable: string; args: string[]; cwd: string; shell: boolean }>
  }).__indiedeckMToolSmokeCalls;
  await evaluate(`document.querySelector('#detail .mtool-integration .mtool-launch').click()`);
  await waitFor(`(async () => !(await import('./store.js')).state.mtoolBusy)()`, 'MTool game handoff acknowledgement');
  const expectedExe = await getMToolGameExecutable(requireMToolGame(rpg.gameId));
  const firstCall = mtoolCalls()[0];
  if (mtoolCalls().length !== 1 || firstCall?.args.length !== 1 || firstCall.args[0] !== expectedExe
      || firstCall.executable !== process.env['INDIEDECK_SMOKE_MTOOL_EXE']
      || firstCall.cwd !== path.dirname(firstCall.executable) || firstCall.shell !== false) {
    throw new Error(`MTool handoff did not use the validated single argument/cwd: ${JSON.stringify(mtoolCalls())}`);
  }
  // Rendering is scheduled after the busy flag clears. Wait for the enabled
  // control too so a fast test cannot click the previous disabled DOM node.
  await waitFor(`!!document.querySelector('#detail .mtool-integration .mtool-open:not(:disabled)')`, 'MTool tool-only control ready');
  await evaluate(`document.querySelector('#detail .mtool-integration .mtool-open').click()`);
  await waitFor(`(async () => !(await import('./store.js')).state.mtoolBusy)()`, 'MTool tool-only acknowledgement');
  if (mtoolCalls().length !== 2 || mtoolCalls()[1]!.args.length !== 0) throw new Error('Tool-only fallback passed a game argument.');
  window.setSize(1360, 880);
  await evaluate(`document.querySelector('#detail .mtool-integration').scrollIntoView({ block: 'center' })`);
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const mtoolShot = process.env['INDIEDECK_MTOOL_SCREENSHOT'];
  if (mtoolShot) await writeFile(mtoolShot, (await window.webContents.capturePage()).toPNG());

  // A synthetic external marker tests file evidence refresh, not MTool runtime
  // translation. The disposable fixture is removed by the outer smoke runner.
  await writeFile(path.join(requireGamePath(rpg.gameId), 'TrsData.bin'), 'offline external marker fixture');
  await evaluate(`document.querySelector('#detail .mtool-integration .mtool-refresh').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.mtoolBusy && state.libraryRevision > ${rpg.revision}
      && state.stats.withTranslator === 1
      && state.detail.profile.installedTranslators.some((entry) => entry.translatorId === 'mtool')
      && state.detail.receipts.length === 0;
  })()`, 'actual external marker refresh without fabricated receipts');
  const toolFixture = process.env['INDIEDECK_SMOKE_MTOOL_EXE']!;
  const originalTool = await readFile(toolFixture);
  await writeFile(toolFixture, 'invalid offline PE fixture');
  await evaluate(`document.getElementById('openSettings').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.mtoolStatusLoading && state.mtoolStatus.status === 'invalid'
      && document.querySelector('#mtoolSettings .mtool-open').disabled;
  })()`, 'fresh settings status after external tool invalidation');
  await writeFile(toolFixture, originalTool);
  await evaluate(`(() => { document.getElementById('closeSettings').click(); document.getElementById('openSettings').click(); })()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.mtoolStatusLoading && state.mtoolStatus.status === 'ready'
      && !document.getElementById('mtoolClear').disabled;
  })()`, 'fresh settings status after external tool restoration');
  await evaluate(`document.getElementById('mtoolClear').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.mtoolBusy && state.mtoolStatus.status === 'disabled' && state.config.externalTools.mtoolRoot === null;
  })()`, 'MTool explicit disconnect');
  const disconnected = await evaluate<boolean>(`(async () => {
    const { api, state } = await import('./store.js');
    const saved = await api.config.set({ ...state.config, externalTools: { mtoolRoot: 'D:/MTool' } });
    if (saved.externalTools.mtoolRoot !== null || (await api.mtool.status()).status !== 'disabled') return false;
    try { await api.mtool.launch(${JSON.stringify(rpg.gameId)}); return false; } catch { return true; }
  })()`);
  if (!disconnected || mtoolCalls().length !== 2) throw new Error('Disconnect silently fell back to a default MTool or launched it.');
  console.log('[smoke] RPG Maker → mocked single-exe handoff → tool-only fallback → external file refresh → live status invalidation/restoration → disconnect and IPC authority checks passed; no real MTool/game process was started');

  const archiveBoundary = await evaluate<boolean>(`(async () => {
    const { api } = await import('./store.js');
    try { await api.archives.import('renderer-chosen-path', '../injected'); return false; } catch { return true; }
  })()`);
  if (!archiveBoundary) throw new Error('Archive import accepted an unissued candidate.');
  await evaluate(`document.getElementById('importArchive').click()`);
  await waitFor(`document.body.dataset.view === 'settings'
    && getComputedStyle(document.getElementById('libraryView')).display === 'none'
    && getComputedStyle(document.getElementById('settingsView')).display !== 'none'`, 'exclusive archive settings view');
  await evaluate(`document.querySelector('#archiveSettings .archive-pick').click()`);
  await waitFor(`!!document.querySelector('#archiveSettings .archive-import:not(:disabled)')`, 'safe game ZIP inspection');
  await evaluate(`(() => {
    const input = document.getElementById('archiveVersionLabel'); input.value = '1.0 smoke'; input.dispatchEvent(new Event('input'));
    document.querySelector('#archiveSettings .archive-import').click();
  })()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.archiveBusy && state.archiveProgress?.status === 'complete'
      && state.archiveRecords.length === 1 && state.games.length === 4;
  })()`, 'first side-by-side game import');
  const firstProduct = await evaluate<{ id: string; activeInstallationId: string }>(`(async () => {
    const { state } = await import('./store.js');
    if (state.archiveCatalog?.products.length !== 1) throw new Error('Missing stable game product.');
    return state.archiveCatalog.products[0];
  })()`);
  const firstArchive = await evaluate<{ gameRoot: string; id: string; hash: string }>(`(async () => {
    const record = (await import('./store.js')).state.archiveRecords[0];
    return { gameRoot: record.gameRoot, id: record.id, hash: record.sourceSha256 };
  })()`);
  const firstGameHash = crypto.createHash('sha256').update(await readFile(path.join(firstArchive.gameRoot, 'Game.exe'))).digest('hex');
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload();
  });
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return document.body.dataset.libraryState === 'ready' && state.archiveRecords.length === 1
      && state.archiveProgress?.status === 'complete' && state.games.length === 4;
  })()`, 'archive completed snapshot/record reload recovery');
  await evaluate(`document.getElementById('importArchive').click()`);
  await evaluate(`document.querySelector('#archiveSettings .archive-pick').click()`);
  await waitFor(`!!document.querySelector('#archiveSettings .archive-import:not(:disabled)')`, 'second ZIP inspection');
  await evaluate(`(() => {
    const product = document.getElementById('archiveProduct');
    product.value = ${JSON.stringify(firstProduct.id)}; product.dispatchEvent(new Event('change'));
    const confirmed = document.getElementById('archiveProductConfirmed');
    if (!confirmed || !document.querySelector('#archiveSettings .archive-import').disabled) throw new Error('Game/edition confirmation was skipped.');
    confirmed.checked = true; confirmed.dispatchEvent(new Event('change'));
  })()`);
  await evaluate(`(() => {
    const input = document.getElementById('archiveVersionLabel'); input.value = '2.0 smoke'; input.dispatchEvent(new Event('input'));
    document.querySelector('#archiveSettings .archive-import').click();
  })()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.archiveBusy && state.archiveProgress?.status === 'complete'
      && state.archiveRecords.length === 2 && state.games.length === 5;
  })()`, 'second side-by-side version import');
  const versions = await evaluate<boolean>(`(async () => {
    const { state } = await import('./store.js');
    return state.archiveRecords.every((record) => record.gameId && record.versionHintIsGuess)
      && new Set(state.archiveRecords.map((record) => record.gameRoot)).size === 2
      && state.archiveRecords.some((record) => record.label === '1.0 smoke')
      && state.archiveRecords.some((record) => record.label === '2.0 smoke');
  })()`);
  if (!versions || firstGameHash !== crypto.createHash('sha256').update(await readFile(path.join(firstArchive.gameRoot, 'Game.exe'))).digest('hex')) {
    throw new Error('Archive versions overwrote their predecessor or lost version provenance/labels.');
  }
  const newInstallationId = await evaluate<string>(`(async () => {
    const { state } = await import('./store.js');
    const catalog = state.archiveCatalog;
    if (catalog.products.length !== 1 || catalog.installations.length !== 2 || catalog.releases.length !== 2
        || catalog.products[0].id !== ${JSON.stringify(firstProduct.id)}
        || catalog.products[0].activeInstallationId !== ${JSON.stringify(firstProduct.activeInstallationId)}) {
      throw new Error('Version grouping changed the previous active copy.');
    }
    return catalog.installations.find((entry) => entry.id !== ${JSON.stringify(firstProduct.activeInstallationId)}).id;
  })()`);
  const forgedActivation = await evaluate<boolean>(`(async () => {
    const { api } = await import('./store.js');
    try { await api.archives.activate('C:/renderer-target.exe'); return false; } catch { return true; }
  })()`);
  if (!forgedActivation) throw new Error('Installation activation accepted a renderer-provided path.');
  await evaluate(`document.querySelector('.archive-activate[data-installation-id="${newInstallationId}"]').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.archiveBusy && state.archiveCatalog?.products[0].activeInstallationId === '${newInstallationId}'
      && state.view === 'library' && !!document.querySelector('.detail-versions');
  })()`, 'explicit active version selection and detail refresh');
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload();
  });
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return document.body.dataset.libraryState === 'ready' && state.archiveCatalog?.products[0].activeInstallationId === '${newInstallationId}';
  })()`, 'active version survives renderer restart');
  await evaluate(`document.getElementById('importArchive').click()`);
  await waitFor(`!!document.querySelector('.archive-activate[data-installation-id="${firstProduct.activeInstallationId}"]:not(:disabled)')`, 'previous version still available');
  await evaluate(`document.querySelector('.archive-activate[data-installation-id="${firstProduct.activeInstallationId}"]').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.archiveBusy && state.archiveCatalog?.products[0].activeInstallationId === '${firstProduct.activeInstallationId}';
  })()`, 'previous active version restored');
  await evaluate(`document.getElementById('importArchive').click()`);
  for (const source of [process.env['INDIEDECK_SMOKE_GAME_ARCHIVE']!, process.env['INDIEDECK_SMOKE_GAME_ARCHIVE_V2']!]) {
    if (!(await stat(source)).isFile()) throw new Error('Game import removed its original archive.');
  }
  const beforeFullScan = await evaluate<number>(`(async () => (await import('./store.js')).state.libraryRevision)()`);
  await evaluate(`document.getElementById('rescanRoots').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.libraryRevision > ${beforeFullScan} && state.games.length === 5 && state.archiveRecords.length === 2
      && state.archiveRecords.every((record) => record.gameId && state.games.some((game) => game.id === record.gameId));
  })()`, 'direct registered archive versions survive full library rescan');
  const archiveShot = process.env['INDIEDECK_ARCHIVES_SCREENSHOT'];
  await evaluate(`document.getElementById('archiveSettings').scrollIntoView({ block: 'start' })`);
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (archiveShot) await writeFile(archiveShot, (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('#archiveSettings .archive-open-game').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.view === 'library' && state.archiveRecords.some((record) => record.gameId === state.selected)
      && document.querySelectorAll('#gameList .game').length === 5
      && document.querySelectorAll('#gameList .archive-version-label').length === 2;
  })()`, 'imported version selected with library label');
  console.log('[smoke] ZIP → explicit product/edition grouping → preserved active copy → version activation/reload/revert → library refresh; original archives and predecessor preserved');

  // Use the companion's real exported JSON through the real picker, parser,
  // persistence and IPC. Only OS/browser/client launch acknowledgements are
  // mocked by the isolated entry point; no account or session is accessed.
  const catalogBeforeStoreLink = await readFile(path.join(defaultDataDir(), 'game-installations.json'), 'utf8');
  const storeCalls = () => (globalThis as typeof globalThis & { __indiedeckStoreSmokeCalls?: { kind: string; url?: string; folder?: string }[] }).__indiedeckStoreSmokeCalls ?? [];
  const storeCallStart = storeCalls().length;
  await evaluate(`document.getElementById('openSettings').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.storeConnectionsLoaded && !state.storeReadPending && document.querySelectorAll('.store-provider').length === 8;
  })()`, 'store provider hub load');
  await evaluate(`document.querySelector('.store-provider[data-provider="booth"] .store-open[data-action="login"]').click()`);
  await waitFor(`(async () => !(await import('./store.js')).state.storeBusy)()`, 'browser login handoff acknowledgement');
  if (!storeCalls().slice(storeCallStart).some((call) => call.url === 'https://accounts.booth.pm/users/sign_in')) throw new Error('Store login did not use the fixed official browser entry.');
  await evaluate(`document.querySelector('.store-pick').click()`);
  await waitFor(`!!document.querySelector('.store-save:not(:disabled)')`, 'companion file review');
  await evaluate(`(() => {
    const product = document.getElementById('storeLinkProduct'); product.value = '${firstProduct.id}';
    product.dispatchEvent(new Event('change')); document.querySelector('.store-save').click();
  })()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return !state.storeBusy && state.storeConnections?.snapshot?.links.length === 1
      && state.storeConnections.snapshot.links[0].managedProductId === '${firstProduct.id}';
  })()`, 'store reference saved without payload ownership change');
  await evaluate(`(async () => {
    const { state } = await import('./store.js');
    const record = state.archiveRecords.find((entry) => entry.id === '${firstArchive.id}');
    window.dispatchEvent(new CustomEvent('indiedeck:select-game', { detail: { gameId: record.gameId } }));
  })()`);
  await waitFor(`!!document.querySelector('.detail-stores .store-open[data-provider="steam"]')`, 'managed game detail official-store shortcuts');
  await evaluate(`document.getElementById('openSettings').click()`);
  await waitFor(`!!document.querySelector('.store-link .store-open[data-action="client"]:not(:disabled)')`, 'store reference actions ready');
  await evaluate(`document.querySelector('.store-link .store-open[data-action="client"]').click()`);
  await waitFor(`(async () => !(await import('./store.js')).state.storeBusy)()`, 'validated Steam client handoff');
  if (!storeCalls().some((call) => call.url === 'steam://install/440')) throw new Error('Steam handoff did not rebuild the numeric install URI.');
  const callsBeforeInjection = storeCalls().length;
  const rejectedStoreRequests = await evaluate<boolean>(`(async () => {
    const { api } = await import('./store.js');
    const requests = [() => api.stores.open('steam', 'site', 'file:///renderer-path'),
      () => api.stores.open('steam', 'javascript:alert(1)'), () => api.stores.save('unissued-candidate')];
    for (const request of requests) { try { await request(); return false; } catch {} }
    return true;
  })()`);
  if (!rejectedStoreRequests || storeCalls().length !== callsBeforeInjection) throw new Error('A forged store request reached an external application.');
  await evaluate(`document.querySelector('.store-companion-open').click()`);
  await waitFor(`(async () => !(await import('./store.js')).state.storeBusy)()`, 'bundled companion folder preparation');
  if (!storeCalls().some((call) => call.kind === 'folder' && call.folder === path.join(defaultDataDir(), 'browser-companion', app.getVersion()))) throw new Error('Companion folder was not exported to the fixed managed path.');
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload();
  });
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return document.body.dataset.libraryState === 'ready' && state.storeConnections?.snapshot?.links.length === 1
      && state.storeConnections.snapshot.links[0].url === 'https://store.steampowered.com/app/440/';
  })()`, 'store link reload persistence and canonical URL');
  await evaluate(`document.getElementById('openSettings').click()`);
  await waitFor(`!!document.querySelector('.store-link .store-remove:not(:disabled)')`, 'store list reload settled');
  await evaluate(`document.getElementById('storeSettings').scrollIntoView({ block: 'start' })`);
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (process.env['INDIEDECK_STORES_SCREENSHOT']) await writeFile(process.env['INDIEDECK_STORES_SCREENSHOT'], (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('.store-remove').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js'); return !state.storeBusy && state.storeConnections?.snapshot?.links.length === 0;
  })()`, 'store reference removal');
  if (catalogBeforeStoreLink !== await readFile(path.join(defaultDataDir(), 'game-installations.json'), 'utf8')) throw new Error('Store references changed payload ownership or active installations.');
  console.log('[smoke] browser companion metadata → explicit managed-product reference → fixed browser/client handoff → reload/removal; no authentication claims or payload changes');

  // Real scanner/UI/IPC against disposable empty folders. Delay is owned by
  // the offline bootstrap, not an application option or renderer authority.
  await evaluate(`document.getElementById('openSettings').click()`);
  await evaluate(`(() => {
    const input = document.getElementById('scanDepth'); input.value = '6'; input.dispatchEvent(new Event('change'));
    document.getElementById('saveScanSettings').click();
  })()`);
  await waitFor(`(async () => (await import('./store.js')).state.config?.scanDepth === 6)()`, 'saved scan depth');
  await evaluate(`document.getElementById('scanDepth').scrollIntoView({ block: 'center' })`);
  const scanRevision = await evaluate<number>(`(async () => (await import('./store.js')).state.libraryRevision)()`);
  (globalThis as typeof globalThis & { __indiedeckScanSmokeSlow?: boolean }).__indiedeckScanSmokeSlow = true;
  await evaluate(`document.getElementById('rescanRoots').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.scanStatus?.status === 'running' && state.scanStatus.visited > 20
      && !document.getElementById('cancelScan').disabled;
  })()`, 'cooperative scan progress and cancel action');
  const scanShot = process.env['INDIEDECK_SCAN_SCREENSHOT'];
  if (scanShot) await writeFile(scanShot, (await window.webContents.capturePage()).toPNG());
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload();
  });
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.scanStatus?.status === 'running' && !document.getElementById('scanTask').hidden
      && !document.getElementById('cancelScan').disabled;
  })()`, 'scan snapshot and early-bound cancellation survive reload');
  await evaluate(`document.getElementById('cancelScan').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return document.body.dataset.libraryState === 'ready' && state.scanStatus?.status === 'cancelled'
      && state.libraryRevision === ${scanRevision} && state.games.length === 5;
  })()`, 'cancelled scan preserves the exact previous library revision');
  (globalThis as typeof globalThis & { __indiedeckScanSmokeSlow?: boolean }).__indiedeckScanSmokeSlow = false;
  await evaluate(`document.getElementById('scan').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.scanStatus?.status === 'complete' && state.libraryRevision > ${scanRevision}
      && state.games.length === 5 && state.scanStatus.visited >= 320 && state.scanStatus.depth === 6;
  })()`, 'complete bounded rescan commits its result after cancellation');
  console.log('[smoke] bounded scan settings → real progress → renderer reload → cancel/unchanged library revision → complete rescan passed');

  // A store lookup is explicitly clicked, and both the API and image bytes
  // come from the offline disposable harness. The selection persists across a
  // renderer reload without touching a real game or Steam account.
  await evaluate(`(() => {
    const game = [...document.querySelectorAll('#gameList .game')].find((row) => row.textContent.includes('Aster Test Game'));
    if (!game) throw new Error('Thumbnail fixture game missing'); game.click();
  })()`);
  await waitFor(`!!document.querySelector('.thumbnail-controls .thumbnail-actions button')`, 'thumbnail search controls');
  await evaluate(`document.querySelector('.thumbnail-controls .thumbnail-actions button').click()`);
  await waitFor(`document.querySelector('.thumbnail-choice')?.textContent.includes('Aster Steam Fixture')`, 'explicit Steam search fixture');
  const deniesCrossGame = await evaluate<boolean>(`(async () => {
    const { api, state } = await import('./store.js');
    const other = state.games.find((game) => game.name === 'Birch Test Game');
    if (!other) throw new Error('Missing other fixture game');
    try { await api.game.thumbnailSelect(other.id, '440'); return false; } catch { return true; }
  })()`);
  if (!deniesCrossGame) throw new Error('A different game accepted another game’s search result.');
  await evaluate(`document.querySelector('.thumbnail-choice').click()`);
  await waitFor(`document.querySelector('.thumbnail-detail img')?.src.startsWith('data:image/png;base64,')`, 'chosen artwork visible');
  const thumbnailShot = process.env['INDIEDECK_THUMBNAIL_SCREENSHOT'];
  if (thumbnailShot) await writeFile(thumbnailShot, (await window.webContents.capturePage()).toPNG());
  const thumbnailSelection = await readThumbnailPreferences(defaultDataDir());
  if (![...thumbnailSelection.values()].includes('440')) throw new Error('Thumbnail selection was not persisted.');
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload();
  });
  await waitFor(`document.body.dataset.libraryState === 'ready'`, 'thumbnail reload library');
  await evaluate(`(() => {
    const game = [...document.querySelectorAll('#gameList .game')].find((row) => row.textContent.includes('Aster Test Game'));
    if (!game) throw new Error('Thumbnail fixture game missing after reload'); game.click();
  })()`);
  await waitFor(`document.querySelector('.thumbnail-detail img')?.src.startsWith('data:image/png;base64,')`, 'saved artwork restored on reload');
  console.log('[smoke] offline Steam artwork search → explicit choice → saved mapping → renderer reload passed');

  // Native File objects cross the actual isolated preload bridge. All paths
  // belong to this disposable test; the production bridge never exposes them.
  const coverGameId = await evaluate<string>(`(async () => (await import('./store.js')).state.games.find(g => g.name === 'Aster Test Game').id)()`);
  await evaluate(`(() => { const s = document.querySelector('.thumbnail-action-select'); s.value = 'folder'; s.dispatchEvent(new Event('change')); document.querySelector('.thumbnail-manual-apply').click(); })()`);
  await waitFor(`(async () => (await window.indiedeck.game.thumbnail('${coverGameId}'))?.source === 'manual')()`, 'manual cover picker');
  if (!(await readManualThumbnail(defaultDataDir(), coverGameId))) throw new Error('Manual image was not stored in launcher data.');
  await new Promise<void>((resolve) => { window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload(); });
  await waitFor(`document.body.dataset.libraryState === 'ready'`, 'manual cover library reload');
  await evaluate(`(() => { [...document.querySelectorAll('#gameList .game')].find(row => row.textContent.includes('Aster Test Game')).click(); })()`);
  await waitFor(`!!document.querySelector('.thumbnail-action-select')`, 'manual cover controls restored');
  await waitFor(`(async () => (await window.indiedeck.game.thumbnail('${coverGameId}'))?.source === 'manual')()`, 'manual cover restart persistence');
  await evaluate(`(() => { const s = document.querySelector('.thumbnail-action-select'); s.value = 'clear'; s.dispatchEvent(new Event('change')); document.querySelector('.thumbnail-manual-apply').click(); })()`);
  await waitFor(`(async () => (await window.indiedeck.game.thumbnail('${coverGameId}'))?.source === 'steam')()`, 'manual reset provider fallback');
  await waitFor(`!!document.querySelector('.thumbnail-manual-apply:not(:disabled)')`, 'manual reset controls settled');
  await evaluate(`(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'nativeFileFixture'; input.hidden = true; document.body.append(input); })()`);
  window.webContents.debugger.attach('1.3');
  try {
    const document = await window.webContents.debugger.sendCommand('DOM.getDocument');
    const input = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#nativeFileFixture' });
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [process.env['INDIEDECK_SMOKE_COVER']!] });
    await evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(document.getElementById('nativeFileFixture').files[0]); document.querySelector('.game-cover-section').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); })()`);
    await waitFor(`(async () => (await window.indiedeck.game.thumbnail('${coverGameId}'))?.source === 'manual')()`, 'native local image drop');
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [process.env['INDIEDECK_SMOKE_STORE_LINK']!] });
    const linkedGame = await evaluate<boolean>(`(async () => { const file = document.getElementById('nativeFileFixture').files[0]; const result = await window.indiedeck.stores.importFile(file); const saved = await window.indiedeck.stores.save(result.candidate.id, undefined, '${coverGameId}'); return saved.snapshot.links.some(link => link.gameId === '${coverGameId}'); })()`);
    if (!linkedGame) throw new Error('Native connection File could not link an ordinary scanned game.');
  } finally { window.webContents.debugger.detach(); }
  if (thumbnailShot) await writeFile(thumbnailShot, (await window.webContents.capturePage()).toPNG());
  console.log('[smoke] manual cover picker and native File drop → launcher-owned persistence/reload → reset fallback → ordinary game product link passed');

  // Importing metadata cannot fetch or apply its artwork. A preview and a
  // selected ordinary game are separate explicit actions through the real UI.
  await clearManualThumbnail(defaultDataDir(), coverGameId);
  await evaluate(`document.getElementById('openSettings').click()`);
  await waitFor(`!!document.querySelector('.store-preview:not(:disabled)')`, 'product artwork importer');
  await evaluate(`(() => {
    const input = document.getElementById('storeLinkInput');
    input.value = JSON.stringify({ schemaVersion: 2, kind: 'indiedeck-store-link', provider: 'steam', productId: '440',
      title: 'Offline artwork fixture', artwork: { url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg?t=123' } });
    input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.store-preview').click();
  })()`);
  await waitFor(`!!document.querySelector('.store-artwork-preview:not(:disabled)')`, 'product artwork candidate');
  if (await readManualThumbnail(defaultDataDir(), coverGameId)) throw new Error('Importing product metadata applied artwork without confirmation.');
  await evaluate(`document.querySelector('.store-artwork-preview').click()`);
  await waitFor(`!!document.querySelector('.store-artwork-image') && !!document.querySelector('.store-artwork-preview:not(:disabled)')`, 'validated product artwork preview');
  if (await readManualThumbnail(defaultDataDir(), coverGameId)) throw new Error('Previewing product artwork changed the existing cover.');
  await evaluate(`(() => { const target = document.getElementById('storeLinkProduct'); target.value = 'game:${coverGameId}'; target.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`!!document.querySelector('.store-artwork-apply:not(:disabled)')`, 'explicit installed-game artwork target');
  const artworkShot = process.env['INDIEDECK_STORE_ARTWORK_SCREENSHOT'];
  if (artworkShot) {
    await evaluate(`document.querySelector('.store-artwork').scrollIntoView({ block: 'center' })`);
    await writeFile(artworkShot, (await window.webContents.capturePage()).toPNG());
  }
  const artworkGates = await evaluate<boolean>(`(async () => {
    const api = window.indiedeck; const { state } = await import('./store.js'); const id = state.storeCandidate.id;
    const unissued = await api.stores.previewArtwork('unissued').then(() => false, () => true);
    const noPreview = await api.stores.applyArtwork(id, 'unissued', '${coverGameId}').then(() => false, () => true);
    const wrongGame = await api.stores.applyArtwork(id, state.storeArtworkPreview.previewId, 'unknown-game').then(() => false, () => true);
    return unissued && noPreview && wrongGame;
  })()`);
  if (!artworkGates) throw new Error('Artwork IPC accepted unissued preview or game identity.');
  await evaluate(`document.querySelector('.store-artwork-apply').click()`);
  await waitFor(`(async () => !(await import('./store.js')).state.storeBusy && (await window.indiedeck.game.thumbnail('${coverGameId}'))?.source === 'manual')()`, 'product artwork persistent apply');
  await evaluate(`document.querySelector('.store-save').click()`);
  await waitFor(`(async () => !(await import('./store.js')).state.storeBusy && !document.querySelector('.store-candidate'))()`, 'independent product connection save');
  await evaluate(`document.getElementById('closeSettings').click()`);
  await new Promise<void>(resolve => { window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload(); });
  await waitFor(`document.body.dataset.libraryState === 'ready'`, 'product artwork reload');
  if ((await readManualThumbnail(defaultDataDir(), coverGameId))?.source !== 'manual') throw new Error('Applied product artwork did not persist.');
  console.log('[smoke] product artwork metadata → explicit preview → installed-game-only apply → independent connection save → persisted reload passed; offline CDN fixture only');

  await evaluate(`document.getElementById('toggleGamingMode').click()`);
  await waitFor(`document.body.dataset.gamingMode === 'true'`, 'native fullscreen gaming mode');
  const oneClick = await evaluate<boolean>(`(() => {
    const row = document.querySelector('#gameList .game'); let clicks = 0;
    row.addEventListener('click', () => { clicks += 1; }, { once: true }); row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return clicks === 1;
  })()`);
  if (!oneClick) throw new Error('Gaming-mode Enter did not activate one row.');
  const modalBoundary = await evaluate<boolean>(`(() => {
    const row = document.querySelector('#gameList .game'); let backgroundClicks = 0, modalClicks = 0;
    const onBackground = () => { backgroundClicks += 1; };
    row.addEventListener('click', onBackground);
    const dialog = document.createElement('dialog'), button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Offline modal fixture';
    button.addEventListener('click', () => { modalClicks += 1; });
    dialog.append(button); document.body.append(dialog); dialog.showModal(); button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const passed = modalClicks === 1 && backgroundClicks === 0 && !dialog.open && document.body.dataset.gamingMode === 'true';
    dialog.remove(); row.removeEventListener('click', onBackground); row.focus();
    return passed;
  })()`);
  if (!modalBoundary) throw new Error('Gaming-mode modal boundary activated the background or failed to close.');
  if (process.env['INDIEDECK_GAMING_SCREENSHOT']) await writeFile(process.env['INDIEDECK_GAMING_SCREENSHOT'], (await window.webContents.capturePage()).toPNG());
  const gameChildren = () => (globalThis as typeof globalThis & {
    __indiedeckGameSmokeChildren: Array<{ emit(event: string, code: number): void }>
  }).__indiedeckGameSmokeChildren;
  await evaluate(`window.indiedeck.game.launch('${coverGameId}')`);
  for (let n = 0; n < 100 && window.isVisible() && !window.isMinimized(); n += 1) await new Promise(resolve => setTimeout(resolve, 50));
  // A hosted desktop can already report a fullscreen window as hidden. Such a
  // window needs no minimize request and must not be shown merely for a test.
  if (gameChildren().length !== 1 || window.isVisible() && !window.isMinimized()) throw new Error('Owned game spawn left an active launcher window: ' + JSON.stringify({
    children: gameChildren().length, active: gamingSnapshot().activeGameCount, preference: gamingPreferences.minimizeOnLaunch,
    visible: window.isVisible(), fullscreen: window.isFullScreen(), minimizable: window.isMinimizable(), minimized: window.isMinimized(),
  }));
  const gates = await evaluate<boolean>(`(async () => {
    const api = window.indiedeck;
    const duplicate = await api.game.launch('${coverGameId}').then(() => false, () => true);
    const write = await api.translatorConfig.write('${coverGameId}', 'xunity-autotranslator', []).then(() => false, () => true);
    return duplicate && write && (await api.gaming.current()).activeGameCount === 1;
  })()`);
  if (!gates) throw new Error('Tracked game did not block duplicate launch and game-file writes.');
  gameChildren()[0]!.emit('exit', 0);
  if (ownedGames.snapshot().sessions.length || window.isVisible() && !window.isMinimized()) throw new Error('Child completion did not clear ownership or unexpectedly restored focus.');
  window.restore(); window.show();
  app.emit('second-instance', {}, ['portable-extraction.exe', '--fullscreen', '--launch-game', coverGameId]);
  for (let n = 0; n < 200 && gameChildren().length < 2; n += 1) await new Promise(resolve => setTimeout(resolve, 50));
  if (gameChildren().length !== 2) throw new Error('Second-instance game shortcut did not use guarded launch.');
  gameChildren()[1]!.emit('exit', 0); window.restore(); window.show();
  const beforeInvalidEntry = gameChildren().length;
  app.emit('second-instance', {}, [process.execPath, '--launch-game', '../../untrusted.exe']);
  await new Promise(resolve => setTimeout(resolve, 30));
  if (gameChildren().length !== beforeInvalidEntry) throw new Error('Malformed launch arguments reached spawn.');
  if (process.platform === 'win32') {
    const shortcutDir = path.join(defaultDataDir(), 'gaming-shortcut-fixture'); mkdirSync(shortcutDir, { recursive: true });
    const details = gamingRegistration(app.getPath('exe'), coverGameId);
    const exported = await exportGamingShortcut(shortcutDir, details, shell);
    if (shell.readShortcutLink(exported.path).args !== details.argumentLine) throw new Error('Native gaming shortcut arguments changed.');
    let replaced = false; try { await exportGamingShortcut(shortcutDir, details, shell); replaced = true; } catch { /* Existing link preserved. */ }
    if (replaced) throw new Error('An existing gaming shortcut was overwritten.');
  }
  await evaluate(`window.indiedeck.gaming.openSettings('xboxMode')`);
  if (!storeCalls().some(call => call.url === 'ms-settings:gaming-fullscreen')) throw new Error('Xbox settings action did not use the official fixed URI.');
  await evaluate(`window.indiedeck.gaming.setFullscreen(false)`);
  await waitFor(`document.body.dataset.gamingMode !== 'true'`, 'native fullscreen exit');
  console.log('[smoke] gaming mode and guarded owned-game lifecycle → single keyboard activation and modal boundary → duplicate/write gates → opaque second-instance shortcut → native lnk verified; synthetic children only, no Xbox/Steam registration or process priority change');

  // Installed-update IPC/UI contract with a mocked native updater supplied by
  // the disposable bootstrap. This does not prove a public N→N+1 installation.
  const updateCalls = (globalThis as typeof globalThis & {
    __indiedeckUpdateSmoke?: { checks: number; downloads: number; installs: number };
  }).__indiedeckUpdateSmoke;
  if (!updateCalls) throw new Error('Offline update fixture was not installed.');
  await evaluate(`document.getElementById('openSettings').click()`);
  await waitFor(`!!document.querySelector('#launcherUpdates .update-check:not(:disabled)')`, 'installed update settings');
  if (Number(updateCalls.downloads) !== 0) throw new Error('An update downloaded without an explicit request.');
  await evaluate(`document.querySelector('#launcherUpdates .update-check').click()`);
  await waitFor(`!!document.querySelector('#launcherUpdates .update-download:not(:disabled)')`, 'available launcher release');
  await evaluate(`document.querySelector('#launcherUpdates .update-download').click()`);
  await waitFor(`document.querySelector('#launcherUpdates .update-progress')?.value > 0`, 'launcher download progress');
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve()); window.webContents.reload();
  });
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return document.body.dataset.libraryState === 'ready' && state.updateStatus?.status === 'downloading';
  })()`, 'launcher main-owned download reload recovery');
  await evaluate(`document.getElementById('openSettings').click()`);
  await waitFor(`!!document.querySelector('#launcherUpdates .update-install:not(:disabled)')`, 'verified launcher download');
  const rejectsBusyRestart = await evaluate<boolean>(`(async () => {
    const { api, state } = await import('./store.js');
    const results = await Promise.allSettled([api.config.set(state.config), api.updates.install()]);
    return results[0].status === 'fulfilled' && results[1].status === 'rejected';
  })()`);
  if (!rejectsBusyRestart || Number(updateCalls.installs) !== 0) throw new Error('Launcher restart raced a queued file write.');
  await evaluate(`document.querySelector('#launcherUpdates .update-install').click()`);
  await waitFor(`!!document.querySelector('#launcherUpdateConfirm .update-confirm')`, 'launcher restart confirmation');
  await evaluate(`document.querySelector('#launcherUpdateConfirm .update-confirm').click()`);
  await waitFor(`(async () => {
    const { state } = await import('./store.js');
    return state.updateStatus?.status === 'error' && state.updateStatus?.downloadedVersion
      && document.querySelector('#launcherUpdates .update-install:not(:disabled)');
  })()`, 'native installer failure unlocks and permits retry');
  const writeAfterFailure = await evaluate<boolean>(`(async () => {
    const { api, state } = await import('./store.js');
    await api.config.set(state.config); return true;
  })()`);
  if (!writeAfterFailure || Number(updateCalls.installs) !== 1) throw new Error('Failed installer left a permanent restart lock.');
  await evaluate(`document.getElementById('launcherUpdates').scrollIntoView({ block: 'start' })`);
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const updateShot = process.env['INDIEDECK_UPDATES_SCREENSHOT'];
  if (updateShot) await writeFile(updateShot, (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('#launcherUpdates .update-install').click()`);
  await evaluate(`document.querySelector('#launcherUpdateConfirm .update-confirm').click()`);
  await waitFor(`(async () => (await import('./store.js')).state.updateStatus?.status === 'installing')()`, 'explicit retry reserves restart');
  const reservationBoundary = await evaluate<boolean>(`(async () => {
    const { api, state } = await import('./store.js');
    const results = await Promise.allSettled([
      api.config.set(state.config), api.mtool.clear(), api.library.scan(), api.game.launch(state.selected),
    ]);
    return results.every((result) => result.status === 'rejected')
      && (await api.updates.current()).status === 'installing';
  })()`);
  if (!reservationBoundary || Number(updateCalls.downloads) !== 1 || Number(updateCalls.installs) !== 2) {
    throw new Error('Restart reservation failed to block new mutations or repeated native actions.');
  }
  console.log('[smoke] launcher update mock flow: explicit download/progress → renderer reload recovery → busy restart rejected → native failure unlocked → retry/reservation passed; no real updater download/install/restart');
}

/* ------------------------------------------------------------ updates */

/**
 * Installed builds update from the NSIS artifact attached to GitHub Releases.
 * Portable builds deliberately opt out: there is no stable install location to
 * replace, so users update those by downloading the next portable executable.
 */
function configureAutoUpdates(): void {
  const mode = process.env['PORTABLE_EXECUTABLE_DIR'] !== undefined ? 'portable'
    : !app.isPackaged ? 'development'
    : process.env['INDIEDECK_DISABLE_UPDATES'] === '1' || process.platform !== 'win32'
      || !existsSync(path.join(process.resourcesPath, 'app-update.yml')) ? 'disabled' : 'installed';
  launcherUpdates = createLauncherUpdateController(autoUpdater, {
    mode, currentVersion: app.getVersion(),
    isBusy: () => pendingMutations > 0 || operations.isActive(),
    isShutdownSafe: () => !sessionEnding,
    reserveInstall: () => {
      if (updateRestartReserved || sessionEnding || pendingMutations > 0 || operations.isActive()) return false;
      updateRestartReserved = true;
      return true;
    },
    releaseInstallReservation: () => { updateRestartReserved = false; },
    onChange: (snapshot) => send('updates:status', snapshot),
  });
  if (mode === 'installed') {
    const checkWhenQuiet = () => {
      // A manual check/download may already have completed (including a cached
      // download). Startup must not clear that user's verified install state.
      if (launcherUpdates.snapshot().status !== 'idle') return;
      if (shouldDeferBackgroundWork(ownedGames.snapshot(), Boolean(mainWindow?.isVisible() && !mainWindow.isMinimized()))) {
        mainWindow?.once('restore', checkWhenQuiet);
        mainWindow?.once('show', checkWhenQuiet);
        return;
      }
      void launcherUpdates.check().catch(() => {});
    };
    const timer = setTimeout(checkWhenQuiet, 8_000);
    timer.unref();
  }
}

/* ------------------------------------------------------------- config */

function pickTranslator(schemas: Map<string, ConfigSchema>, profile: GameProfile, requested?: string): string {
  if (typeof requested === 'string' && schemas.has(requested)) return requested;
  const installed = profile.installedTranslators.find((t) => schemas.has(t.translatorId));
  if (installed) return installed.translatorId;
  const first = [...schemas.keys()][0];
  if (!first) throw new Error('No translator config schemas are registered.');
  return first;
}

/** Renderer-supplied changes are reduced to plain id/value string pairs. */
function sanitiseChanges(changes: unknown): ConfigChange[] {
  if (!Array.isArray(changes)) return [];
  return changes
    .filter((c): c is { id: unknown; value: unknown } => typeof c === 'object' && c !== null)
    .map((c) => ({ id: String(c.id), value: String(c.value) }))
    .slice(0, 200);
}

async function configContext(gameId: string, translatorId: string) {
  const gamePath = requireGamePath(gameId);
  const profile = detectGame(registry, gamePath, { deep: true });
  if (!profile) throw new Error('Game folder is gone.');
  const schemas = registry.configSchemas as Map<string, ConfigSchema>;
  const id = pickTranslator(schemas, profile, translatorId);
  const schema = schemas.get(id)!;
  const config = await readGameConfig(registry, schemas, profile, id, { revealSecrets: true });
  return { schema, config, profile };
}

/** One shape for both load and scan, with display strings in the active locale. */
function libraryPayload(index: Awaited<ReturnType<typeof loadLibrary>>, options: ResolveOptions = {}) {
  const games = index.games.filter((game) => withinLibraryRoot(game.path)).map((game) => localiseProfile(registry, game));
  stateRevision = Math.max(stateRevision, index.revision);
  for (const game of games) if (!gameRevisions.has(idFor(game.path))) gameRevisions.set(idFor(game.path), stateRevision);
  rememberGames(games);
  return {
    index: { ...index, games: games.map(withId) },
    stats: libraryStats({ ...index, games }),
    audits: auditLibrary(registry, games, options).map((a) => ({ ...a, id: idFor(a.path) })),
  };
}

function safeResolveOptions(options?: ResolveOptions): ResolveOptions {
  return {
    targetLanguage: String(options?.targetLanguage ?? 'en').slice(0, 40),
    sourceLanguage: String(options?.sourceLanguage ?? 'ja').slice(0, 40),
    endpoint: String(options?.endpoint ?? 'GoogleTranslate').slice(0, 100),
    includeNonViable: true,
    ...(typeof options?.includeFont === 'boolean' ? { includeFont: options.includeFont } : {}),
  };
}

async function translatorConfigPayload(profile: GameProfile, requested?: string) {
  const schemas = registry.configSchemas as Map<string, ConfigSchema>;
  const id = pickTranslator(schemas, profile, requested);
  const schema = schemas.get(id)!;
  const config = await readGameConfig(registry, schemas, profile, id);
  return {
    config,
    categories: (schema.categories ?? []).map((category) => ({
      id: category.id,
      label: tRegistry(`configSchema.${id}.categories.${category.id}`, category.label),
    })),
    fontBundles: profile.installedFontBundles,
    gameRevision: gameRevisions.get(idFor(profile.path)) ?? 0,
  };
}

async function gameDetailPayload(gameId: string, options: ResolveOptions, detected?: GameProfile) {
  const profile = localiseProfile(registry, detected ?? requireDetectedGame(gameId));
  const history = comparisonHistory ? await comparisonHistory.get(gameId) : { state: 'unavailable' as const, record: undefined };
  const fallback = lastOptionComparisonsByGame.get(gameId);
  const historyRecord = fallback ?? history.record;
  const configTranslator = profile.installedTranslators.find((entry) => entry.translatorId === 'xunity-autotranslator')
    ?? profile.installedTranslators.find((entry) => registry.configSchemas.has(entry.translatorId));
  const receiptsEvidence = readReceiptEvidence(profile.path);
  const installEvidence = collectTranslatorEvidence(registry, profile, options);
  const translatorConfig = configTranslator ? await translatorConfigPayload(profile, configTranslator.translatorId) : null;
  const fontOptions = installedFontOptions(options, translatorConfig?.config);
  const fontRecommendation = recommendGameFont(registry, profile, fontOptions);
  const standalone = resolveFontPlan(registry, profile, fontOptions);
  let fontPlan;
  if (standalone) {
    const key = await fontWriteBlockKey(profile, standalone, receiptsEvidence, installEvidence, translatorConfig?.config);
    if (key) {
      fontRecommendation.installable = false;
      fontRecommendation.blockReasonKey = `ui.font.block.${key}`;
      fontRecommendation.blockReason = t(fontRecommendation.blockReasonKey);
    } else fontPlan = cachePlans(gameId, [standalone], fontOptions)[0];
  }
  const withoutFontOptions = { ...options, includeFont: false };
  const withoutFonts = cachePlans(gameId, summarisePlans(resolvePlans(registry, profile, withoutFontOptions)), withoutFontOptions);
  const plans = await Promise.all(cachePlans(gameId, summarisePlans(resolvePlans(registry, profile, options)), options)
    .map(async (plan) => {
      const key = await fontWriteBlockKey(profile, plan, receiptsEvidence, installEvidence);
      const without = plan.fontBundle ? withoutFonts.find((candidate) => candidate.translatorId === plan.translatorId && candidate.variantId === plan.variantId && candidate.version === plan.version) : undefined;
      return {
        ...plan,
        installBlockReason: installBlockReason(plan, receiptsEvidence, installEvidence) ?? (key ? t(`ui.font.block.${key}`) : undefined),
        ...(without ? { withoutFontPlanId: without.id, withoutFontInstallBlockReason: installBlockReason(without, receiptsEvidence, installEvidence) } : {}),
      };
    }));
  return {
    profile: withId(profile),
    launchDiagnostic: launchDiagnostics.get(gameId),
    gameRevision: gameRevisions.get(gameId) ?? 0,
    plans,
    fontRecommendation,
    fontPlan,
    comparisonHistory: { state: history.state, ...(historyRecord ? { record: { ...historyRecord, persistent: !fallback } } : {}) },
    securityResult: securityResultsByGame.get(gameId),
    securityEngine: security.current().engine,
    ...(profile.engineId === 'unity' ? { translatorMaintenance: await cacheTranslatorMaintenance(gameId, profile,
      await previewTranslatorMaintenance(registry, profile, options)) } : {}),
    ...(isMToolGame(profile) ? { mtoolIntegration: {
      ...await currentMToolStatus(), supported: true, gameExecutable: profile.executable,
      autoApply: false, docsUrl: 'https://mtool.app/tutorial.php?lang=en',
    } } : {}),
    audit: auditGame(registry, profile, options),
    receipts: await readReceipts(profile.path),
    mods: await listMods(registry, profile),
    hosts: modHosts(registry, profile).map((h) => ({ loaderId: h.loader.id, name: h.loader.name, dir: h.dir })),
    translatorConfig,
  };
}

function installedFontOptions(options: ResolveOptions, config?: Awaited<ReturnType<typeof translatorConfigPayload>>['config']): FontResolveOptions {
  if (config?.translatorId !== 'xunity-autotranslator' || !config.location.exists) return options;
  return {
    ...options,
    targetLanguage: config.values.find((value) => value.id === 'xunity.targetLanguage')?.value ?? options.targetLanguage,
    currentFallbackFontTextMeshPro: config.values.find((value) => value.id === 'xunity.fallbackFontTextMeshPro')?.value ?? '',
  };
}

async function currentMToolStatus(): Promise<MToolStatus> {
  return getMToolStatus((await loadConfig()).externalTools?.mtoolRoot);
}

function requireReadyMTool(status: MToolStatus): void {
  if (status.status !== 'ready') throw new Error(status.reasonKey ? t(status.reasonKey, undefined, status.reason) : status.reason ?? 'MTool is unavailable.');
}

/** A spawn acknowledgement is not game connection or translation success.
 * MTool stays an independent process; IndieDeck never patches its settings or
 * implements its injector. Arguments and cwd come only from validated main
 * state, never from renderer text or a shell command. */
async function openMTool(profile?: GameProfile) {
  const status = await currentMToolStatus();
  requireReadyMTool(status);
  const spec = await mtoolLaunchSpec(status, profile).catch((error: Error) => {
    throw new Error(/^ui\.mtool\.reason\./.test(error.message) ? t(error.message) : error.message);
  });
  await security.scanBeforeUse(spec.executable);
  if (profile?.executable) await security.scanBeforeUse(path.join(profile.path, profile.executable), idFor(profile.path));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd, shell: false, detached: true, stdio: 'ignore',
      env: gameProcessEnvironment(),
      windowsHide: false, // Explicit user action opens an interactive GUI.
    });
    child.once('error', (error) => reject(new Error(t('ui.mtool.launchFailed', { error: error.message }, 'Could not open MTool: {error}'))));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { opened: true, ...(profile ? { gameId: idFor(profile.path) } : {}), autoApply: false };
}

function requireMToolGame(gameId: string): GameProfile {
  const profile = requireDetectedGame(gameId);
  if (!isMToolGame(profile)) throw new Error(t('ui.mtool.gameUnsupported', undefined,
    'Only supported RPG Maker, Wolf RPG, Ren\'Py and KiriKiri games can currently be handed to MTool.'));
  if (!profile.executable) throw new Error(t('ui.mtool.gameUnavailable', undefined,
    'The game executable is missing or unsafe. Refresh its folder before trying again.'));
  return profile;
}

function enqueueMToolLaunch(gameId?: string) {
  if (pendingMutations > 0 || operations.isActive()) throw new Error(t('ui.operation.busy', undefined, 'Wait for the current file operation to finish.'));
  // Reserve synchronously: double clicks cannot queue two external launches,
  // and a normal quit is blocked until the spawn acknowledgement settles.
  return enqueueMutation(() => openMTool(gameId === undefined ? undefined : requireMToolGame(gameId)));
}

function requireDetectedGame(gameId: string): GameProfile {
  const profile = detectGame(registry, requireGamePath(gameId), { deep: true });
  if (!profile) throw new Error('No known engine detected here any more - the folder may have changed.');
  return profile;
}

/** A read begun before a write cannot label its older files with a newer
 * revision. Wait for the writer, then retry if another write started while the
 * asynchronous receipt/mod/config snapshot was assembled. */
async function stableGameRead<T>(gameId: string, read: () => Promise<T>): Promise<T> {
  for (;;) {
    const barrier = mutationQueue;
    await barrier;
    const revision = gameRevisions.get(gameId) ?? 0;
    const snapshot = await read();
    if (barrier === mutationQueue && revision === (gameRevisions.get(gameId) ?? 0) && !operations.isActive()) return snapshot;
  }
}

async function refreshGameState(gameId: string, report: (update: ProgressUpdate) => void) {
  report({ phase: 'redetect' });
  const { index, profile } = await refreshLibraryGame(registry, requireGamePath(gameId));
  stateRevision = Math.max(stateRevision, index.revision);
  const gameRevision = markGameChanged(gameId);
  report({ phase: 'audit' });
  const options = safeResolveOptions((await loadConfig()).defaults);
  const library = libraryPayload(index, options);
  const detail = profile ? await gameDetailPayload(gameId, options, profile) : null;
  return { gameId, gameRevision, library, detail, translatorConfig: detail?.translatorConfig ?? null };
}

function planFingerprint(plan: TranslatorPlan): string {
  return JSON.stringify({
    translatorId: plan.translatorId, variantId: plan.variantId, version: plan.version,
    purpose: plan.purpose,
    loader: plan.loader, fontBundle: plan.fontBundle, viable: plan.viable, config: plan.config,
    steps: plan.steps.map(({ action, source, dest, details }) => ({ action, source, dest, details })),
  });
}

function receiptsAreUnsafe(evidence: ReceiptEvidence): boolean {
  return evidence.issues.length > 0 || evidence.records.some((r) =>
    !isSafeReceiptComponentId(r.componentId) ||
    r.storageId !== `${r.kind}-${r.componentId}.json`);
}

function validateManagedReceipts(gamePath: string): void {
  if (receiptsAreUnsafe(readReceiptEvidence(gamePath))) {
    throw new Error(t('ui.operation.receiptBlocked', undefined,
      'An install record is damaged or unsupported. Review it before changing managed files.'));
  }
}

function installBlockReason(
  plan: TranslatorPlan, receipts: ReceiptEvidence, installations: TranslatorInstallEvidence[],
): string | undefined {
  if (receiptsAreUnsafe(receipts)) return t('ui.operation.receiptBlocked', undefined,
    'An install record is damaged or unsupported. Review it before changing managed files.');
  if (receipts.records.some((r) => (r.kind === 'translator' && r.componentId === plan.translatorId) ||
    (r.kind === 'loader' && r.componentId === plan.loader?.loaderId && !plan.loader?.alreadyInstalled))) {
    return t('ui.operation.reinstallBlocked', undefined,
      'This component already has an install record. Safe updates and repairs require the upcoming maintenance flow.');
  }
  const evidence = installations.find((e) => e.translatorId === plan.translatorId);
  if (evidence?.healthIssues.some((issue) =>
    ['duplicate-variants', 'multiple-versions', 'managed-drift', 'corrupt-receipt', 'newer-than-registry'].includes(issue)) ||
    evidence?.variantHits.some((hit) => hit.paths.length > 0 && hit.variantId !== plan.variantId)) {
    return t('ui.operation.cleanupBlocked', undefined,
      'The existing translator needs review or cleanup before this install can run.');
  }
  return undefined;
}

async function runMaintenance(
  request: OperationRequest, plan: TranslatorPlan | undefined, options: FontResolveOptions,
  report: (update: ProgressUpdate) => void,
  translatorMaintenance?: TranslatorMaintenancePreview,
): Promise<OperationResult> {
  let result: OperationResult = {
    status: 'failed', mutationStatus: 'rolled-back', rollbackStatus: 'not-run',
    rollbackFailures: [], refreshStatus: 'failed',
  };
  markGameChanged(request.gameId);
  try {
    report({ phase: 'preflight' });
    const profile = requireDetectedGame(request.gameId);
    validateManagedReceipts(profile.path);
    if (request.kind === 'remove-translator' || request.kind === 'reinstall-translator') {
      if (!translatorMaintenance) throw new Error(t('ui.maintenance.reason.stale'));
      const maintained = await runTranslatorMaintenance(translatorMaintenance,
        request.kind === 'remove-translator' ? 'remove' : 'reinstall', { onEvent: (event) => report(event),
          beforeUseAsset: (asset) => security.scanBeforeUse(asset.path, undefined, asset.sha256).then(() => {}) });
      if (request.kind === 'reinstall-translator' && maintained.mutationStatus === 'committed') {
        const comparison = optionComparisonsByPreview.get(translatorMaintenance);
        if (comparison) {
          lastOptionComparisonsByGame.delete(request.gameId);
          try {
            if (!comparisonHistory) throw new Error('Comparison history is unavailable.');
            await comparisonHistory.save(request.gameId, comparison);
          } catch {
            while (lastOptionComparisonsByGame.size >= 20) lastOptionComparisonsByGame.delete(lastOptionComparisonsByGame.keys().next().value!);
            lastOptionComparisonsByGame.set(request.gameId, { gameId: request.gameId, recordedAt: new Date().toISOString(), report: comparison, hiddenValueIds: [] });
          }
        }
      }
      result = { ...result, status: maintained.pendingUserActions.length ? 'needs-user-action' : 'success',
        mutationStatus: maintained.mutationStatus, rollbackStatus: maintained.rollbackStatus,
        rollbackFailures: maintained.rollbackFailures, result: {
          ...maintained, ...(request.kind === 'reinstall-translator' ? { optionComparison: optionComparisonsByPreview.get(translatorMaintenance) } : {}),
        } };
    } else if (request.kind === 'install' || request.kind === 'install-font') {
      if (!plan?.viable) throw new Error('That plan cannot be installed.');
      const fontConfig = request.kind === 'install-font' ? (await translatorConfigPayload(profile, 'xunity-autotranslator')).config : undefined;
      const fresh = request.kind === 'install-font'
        ? resolveFontPlan(registry, profile, installedFontOptions(options, fontConfig))
        : summarisePlans(resolvePlans(registry, profile, options)).find((candidate) => planFingerprint(candidate) === planFingerprint(plan));
      if (!fresh?.viable || planFingerprint(fresh) !== planFingerprint(plan)) throw new Error(t('ui.operation.planChanged', undefined,
        'The game or install plan changed. Reopen the game and choose a fresh plan.'));
      const receiptsEvidence = readReceiptEvidence(profile.path);
      const installations = collectTranslatorEvidence(registry, profile, options);
      const key = await fontWriteBlockKey(profile, fresh, receiptsEvidence, installations, fontConfig);
      const blocked = (request.kind === 'install' ? installBlockReason(fresh, receiptsEvidence, installations) : undefined) ?? (key ? t(`ui.font.block.${key}`) : undefined);
      if (blocked) throw new Error(blocked);
      const applied = await applyPlan(fresh, {
        beforeUseAsset: (asset) => security.scanBeforeUse(asset.path, undefined, asset.sha256).then(() => {}),
        onEvent: (event) => report(event),
        logger: {
          level: 'info', debug: () => {},
          info: (log) => report({ log }), warn: (log) => report({ log }), error: (log) => report({ log }),
          child() { return this; },
        },
      });
      result = {
        ...result, status: applied.pendingUserActions.length ? 'needs-user-action' : 'success',
        mutationStatus: 'committed', result: applied,
      };
    } else {
      const receipts = await readSafeRemovalReceipts(profile.path, profile.executable ? [profile.executable] : []);
      // Undo the font config overlay before the translator's original receipt.
      receipts.sort((a, b) => Number(b.kind === 'font') - Number(a.kind === 'font'));
      const removed = [];
      result.mutationStatus = 'partial';
      for (let index = 0; index < receipts.length; index += 1) {
        report({ phase: 'backup', stepIndex: index + 1, stepCount: receipts.length,
          description: `${receipts[index]!.kind}: ${receipts[index]!.componentId}` });
        removed.push(await uninstallReceipt(receipts[index]!, { root: profile.path }));
      }
      result = {
        ...result, status: removed.some((entry) => entry.keptModified.length > 0 || entry.missing.length > 0)
          ? 'needs-user-action' : 'success', mutationStatus: 'committed', result: removed,
      };
    }
  } catch (err) {
    const error = err as Error & { applyResult?: ApplyResult; maintenanceResult?: Awaited<ReturnType<typeof runTranslatorMaintenance>> };
    const applied = error.maintenanceResult ?? error.applyResult;
    result = {
      ...result, status: 'failed', error: localiseTaskError(error),
      ...(applied ? {
        result: applied, mutationStatus: applied.mutationStatus,
        rollbackStatus: applied.rollbackStatus, rollbackFailures: applied.rollbackFailures,
      } : {}),
    };
  }

  try {
    result.postState = await refreshGameState(request.gameId, report);
    result.refreshStatus = 'complete';
  } catch (err) {
    result.refreshError = (err as Error).message;
    markGameChanged(request.gameId);
  }
  return result;
}

/* ---------------------------------------------------------------- ipc */

/** Wraps a handler so renderer errors arrive as data, not as unhandled rejections. */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const expected = pathToFileURL(path.join(here, '..', 'renderer', 'index.html')).href;
      if (!mainWindow || !isTrustedAppSender(_event, mainWindow.webContents, expected)) throw new Error('ui.security.untrustedSender');
      if (updateRestartReserved && channel !== 'updates:current' && channel !== 'app:info') {
        throw new Error('ui.update.error.busy');
      }
      return { ok: true as const, data: await fn(...(args as never[])) };
    } catch (err) {
      return { ok: false as const, error: localiseTaskError(err) };
    }
  });
}

function localiseTaskError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^ui\.(maintenance|archives|update|stores|security|gaming)\.[a-zA-Z0-9.-]+$/.test(message) ? t(message) : message;
}

const STORE_ACTIONS: StoreHandoffAction[] = ['site', 'library', 'login', 'client', 'downloadClient'];
function storeActions(provider: StoreProviderId, link?: StoreConnection) {
  return STORE_ACTIONS.flatMap((action) => {
    try {
      const handoff = resolveStoreHandoff(provider, action, link);
      const label = action === 'client' ? ({ steam: 'steamInstall', epic: 'epicProduct', itch: 'itchLibrary' }[provider as 'steam' | 'epic' | 'itch'] ?? action) : action;
      return [{ id: action, kind: handoff.kind, labelKey: `ui.stores.action.${label}` }];
    } catch { return []; }
  });
}

async function storeConnectionsPayload() {
  const providers = STORE_PROVIDERS.map((provider) => ({
    id: provider.id, name: provider.name, authMode: provider.authMode, actions: storeActions(provider.id),
  }));
  // Store references do not change the game's payload owner. A catalog failure
  // prevents new associations while still allowing fixed official web links.
  const products = await listGameInstallations(defaultDataDir()).then((catalog) =>
    catalog.products.map(({ id, title }) => ({ id, title }))).catch(() => []);
  const index = await loadLibrary();
  const games = index.games.filter((game) => withinLibraryRoot(game.path)).map((game) => ({
    id: idFor(game.path), title: game.title || game.name, name: game.name, path: game.path,
  }));
  try {
    const snapshot = await readStoreConnections(defaultDataDir());
    return { snapshot: { ...snapshot, links: snapshot.links.map((link) => ({
      ...link, url: canonicalStoreProductUrl(link), actions: storeActions(link.provider, link),
    })) }, providers, products, games };
  } catch (error) {
    return { snapshot: null, providers, products, games, error: localiseTaskError(error) };
  }
}

async function storeCandidatePayload(link: StoreLinkCandidate) {
  while (storeLinkCandidates.size >= 20) {
    const oldest = storeLinkCandidates.keys().next().value!;
    storeArtworkPreviews.revoke(oldest); storeLinkCandidates.delete(oldest);
  }
  const id = crypto.randomUUID(); storeLinkCandidates.set(id, link);
  return { ...await storeConnectionsPayload(), candidate: { ...link, id, url: canonicalStoreProductUrl(link) } };
}

/** The catalog owns stable product/version ids. Library profiles remain tied
 * to each physical copy so translator plans and receipts are never inherited. */
async function registerArchiveVersion(record: GameArchiveRecord): Promise<void> {
  const refreshed = await refreshLibraryGame(registry, record.gameRoot);
  if (!refreshed.profile?.executable) throw new Error('ui.archives.reason.noGame');
  const config = await addRoot(record.gameRoot);
  libraryRoots = config.roots;
  rememberGames(refreshed.index.games.filter((game) => withinLibraryRoot(game.path)));
  markGameChanged(idFor(record.gameRoot));
}

async function archiveSnapshot(gameId?: string) {
  const config = await loadConfig();
  libraryRoots = config.roots;
  const library = libraryPayload(await loadLibrary(), safeResolveOptions(config.defaults));
  return { records: await archiveRecords(), catalog: await listGameInstallations(defaultDataDir()), recoveryError: archiveRecoveryError, config, library, gameId };
}

async function archiveRecords() {
  return (await listGameArchives(defaultDataDir())).map((record) => {
    const gameId = idFor(record.gameRoot);
    return { ...record, ...(gamePathsById.has(gameId) && withinLibraryRoot(record.gameRoot) ? { gameId } : {}) };
  });
}

function publishArchiveTask(update: Partial<ArchiveTask>): void {
  if (!archiveTask) return;
  archiveTask = { ...archiveTask, ...update, sequence: ++archiveSequence };
  send('archives:progress', structuredClone(archiveTask));
}

function importSelectedArchive(candidateId: unknown, label: unknown, productId?: unknown) {
  if (pendingMutations > 0 || operations.isActive()) throw new Error(t('ui.operation.busy'));
  if (typeof candidateId !== 'string') throw new Error(t('ui.archives.reason.stale'));
  const candidate = archiveCandidates.get(candidateId);
  if (!candidate) throw new Error(t('ui.archives.reason.stale'));
  if (!candidate.inspection.canImport) throw new Error(t(candidate.inspection.reasonKey ?? 'ui.archives.reason.unsupported'));
  if (label !== undefined && (typeof label !== 'string' || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label))) {
    throw new Error(t('ui.archives.reason.invalidLabel'));
  }
  if (productId !== undefined && (typeof productId !== 'string' || !/^[0-9a-f-]{36}$/.test(productId))) {
    throw new Error('ui.archives.reason.invalidProduct');
  }
  archiveTask = { id: candidateId, sequence: ++archiveSequence, status: 'running', phase: 'inspect',
    completedFiles: 0, totalFiles: candidate.inspection.fileCount ?? 0,
    completedBytes: 0, totalBytes: candidate.inspection.unpackedBytes ?? 0 };
  send('archives:progress', structuredClone(archiveTask));
  return enqueueMutation(async () => {
    try {
      await security.scanBeforeUse(candidate.path, undefined, candidate.inspection.sha256);
      const imported = await installGameArchiveVersion(candidate.path, {
        dataDir: defaultDataDir(), registry, label: typeof label === 'string' ? label.trim() : undefined,
        productId: typeof productId === 'string' ? productId : undefined,
        register: registerArchiveVersion,
        expectedSha256: candidate.inspection.sha256,
        beforePublish: (stage) => security.scanStage(stage),
        onProgress: (event) => publishArchiveTask({
          phase: event.phase === 'verify' || event.phase === 'detect' ? 'inspect' : event.phase,
          completedFiles: event.filesDone, totalFiles: event.filesTotal,
          completedBytes: event.bytesDone, totalBytes: event.bytesTotal,
        }),
      });
      const gameId = idFor(imported.record.gameRoot);
      const result = { record: { ...imported.record, gameId }, duplicate: imported.duplicate,
        ...await archiveSnapshot(gameId) };
      publishArchiveTask({ status: 'complete', phase: 'complete', result });
      return result;
    } catch (error) {
      publishArchiveTask({ status: 'failed', phase: 'failed', error: localiseTaskError(error) });
      throw error;
    }
  });
}

/** Serialises every filesystem mutation and makes pending work quit-visible. */
function handleMutation<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  handle(channel, (...args: never[]) => {
    if (operations.isActive()) throw new Error(t('ui.operation.busy', undefined, 'Wait for the current file operation to finish.'));
    if (channel === 'library:scan' && pendingMutations > 0) throw new Error(t('ui.operation.busy'));
    return enqueueMutation(() => {
      if (['mods:toggle', 'mods:add', 'config:write'].includes(channel) && typeof args[0] === 'string' && ownedGames.has(args[0])) {
        throw new Error('ui.gaming.error.gameRunning');
      }
      return fn(...args);
    });
  });
}

/** IPC and gaming shortcuts share this exact launch path and security gate. */
async function launchGame(gameId: string) {
  if (pendingMutations > 0 || operations.isActive()) throw new Error(t('ui.operation.busy'));
  requireGamePath(gameId);
  const session = ownedGames.reserve(gameId);
  try {
    return await enqueueMutation(async () => {
      const gamePath = requireGamePath(gameId);
      await inspectLaunchDirectory(gamePath);
      const profile = detectGame(registry, gamePath, { rejectLinks: true });
      if (!profile?.executable) throw new Error('ui.gaming.error.unsafeLaunchTarget');
      const target = await inspectLaunchTarget(gamePath, profile.executable);
      await scanLaunchTarget((await loadConfig()).scanOnLaunch, () => security.scanBeforeUse(target.executable, gameId));
      requireGamePath(gameId);
      await revalidateLaunchTarget(target);
      const token = launchDiagnostics.begin(gameId);
      let failed = false;
      const recordFailure = () => { if (!failed) { failed = true; launchDiagnostics.failed(gameId, token); } };
      try {
        const child = spawn(target.executable, { cwd: target.cwd, detached: true, stdio: 'ignore', shell: false, env: gameProcessEnvironment() });
        child.once('exit', (code) => { launchDiagnostics.exited(gameId, token, code); ownedGames.finish(gameId, session); });
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', () => {
            recordFailure(); ownedGames.finish(gameId, session);
            reject(new Error('ui.gaming.error.launchFailed'));
          });
          child.unref();
        });
        if (ownedGames.started(gameId, session) && gamingPreferences.minimizeOnLaunch && mainWindow?.isVisible() && !mainWindow.isMinimized()) {
          minimizedForGame = true; mainWindow.minimize();
        }
        return profile.executable;
      } catch (error) { recordFailure(); throw error; }
    });
  } catch (error) { ownedGames.finish(gameId, session); throw error; }
}

function register(): void {
  handle('gaming:current', () => gamingSnapshot());
  handle('gaming:setFullscreen', (enabled: unknown) => {
    if (typeof enabled !== 'boolean' || !mainWindow || mainWindow.isDestroyed()) throw new Error('ui.gaming.failed');
    mainWindow.setFullScreen(enabled);
    publishGamingState(); return gamingSnapshot();
  });
  handleMutation('gaming:configure', async (input: unknown) => {
    try { gamingPreferences = await saveGamingPreferences(defaultDataDir(), input); gamingSettingsError = false; }
    catch { gamingSettingsError = true; publishGamingState(); throw new Error('ui.gaming.failed'); }
    publishGamingState(); return gamingSnapshot();
  });
  const registration = async (gameId?: unknown) => {
    if (process.platform !== 'win32' || !app.isPackaged) throw new Error('ui.gaming.error.installedRequired');
    if (gameId !== undefined) requireGamePath(gameId);
    const executable = process.env['PORTABLE_EXECUTABLE_FILE'] || app.getPath('exe');
    const info = await lstat(executable);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('ui.gaming.error.installedRequired');
    return gamingRegistration(executable, gameId);
  };
  handle('gaming:registration', (gameId?: unknown) => registration(gameId));
  handleMutation('gaming:exportShortcut', async (gameId?: unknown) => {
    const details = await registration(gameId);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: app.getPath('desktop'),
      title: t('ui.gaming.shortcutFolder', undefined, 'Choose a folder for the gaming shortcut') });
    if (result.canceled || !result.filePaths[0]) return { created: false, canceled: true };
    if (gameId !== undefined) requireGamePath(gameId);
    try { return await exportGamingShortcut(result.filePaths[0], details, shell); }
    catch { throw new Error('ui.gaming.error.shortcutFailed'); }
  });
  handle('gaming:openSettings', async (action: unknown) => {
    if (process.platform !== 'win32') throw new Error('ui.gaming.failed');
    let target: string;
    try { target = gamingSettingsUrl(action); } catch { throw new Error('ui.gaming.failed'); }
    await shell.openExternal(target); return { opened: true };
  });
  handle('security:current', () => security.current());
  handleMutation('security:setLaunchScan', async (enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('ui.security.actionFailed');
    const config = await loadConfig();
    await saveConfig({ ...config, scanOnLaunch: enabled });
    return loadConfig();
  });
  handle('security:refresh', () => security.refresh());
  handle('security:scanGame', (gameId: string) => {
    const target = requireGamePath(gameId);
    return security.startGameScan(gameId, target);
  });
  handle('security:update', () => security.startUpdate());
  handle('security:cancel', (id: unknown) => security.cancel(id));
  handle('security:openHelp', async (action: unknown) => {
    if (action !== 'windows-security' && action !== 'malware-zero') throw new Error('ui.security.actionFailed');
    await shell.openExternal(action === 'windows-security' ? 'windowsdefender:' : 'https://malzero.xyz/');
    return true;
  });
  handle('app:info', () => ({
    version: app.getVersion(),
    // Portable builds set this env var; the updater deliberately stays off
    // there, and the settings page says so instead of a silent no-op.
    portable: process.env['PORTABLE_EXECUTABLE_DIR'] !== undefined,
    updateMode: launcherUpdates.snapshot().mode,
  }));
  handle('updates:current', () => launcherUpdates.snapshot());
  handle('updates:check', () => launcherUpdates.check());
  handle('updates:download', () => launcherUpdates.download());
  handle('updates:install', () => launcherUpdates.install());
  handle('updates:openRelease', async () => { await shell.openExternal(LAUNCHER_RELEASE_URL); return true; });

  handle('registry:get', () => ({
    engines: registry.engines.map((e) => ({ id: e.id, name: e.displayName ?? e.name })),
    translators: registry.translators.map((t) => ({
      id: t.id,
      name: t.name,
      engines: t.engines,
      detectOnly: t.detectOnly ?? false,
      endpoints: t.endpoints ?? [],
    })),
    updated: registry.meta.updated,
  }));

  handle('i18n:get', () => ({
    locale: getLocale(),
    locales: availableLocales().map((l) => ({ code: l.code, label: l.label, keys: l.keys })),
    catalog: getCatalog(),
  }));

  handle('config:get', () => loadConfig());
  handle('library-preferences:read', () => readLibraryPreferences());
  handleMutation('library-preferences:save', (input: unknown) => saveLibraryPreferences(input));
  handle('stores:list', async () => { await mutationQueue; return storeConnectionsPayload(); });
  handleMutation('stores:pick', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], title: t('ui.stores.pickTitle'),
      filters: [{ name: t('ui.stores.linkFiles'), extensions: ['json'] }] });
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return { ...await storeConnectionsPayload(), candidate: null };
    return storeCandidatePayload(await readStoreLinkFile(file));
  });
  handleMutation('stores:preview', async (text: unknown) => storeCandidatePayload(parseStoreLinkText(text)));
  handleMutation('stores:importFile', async (file: unknown) => {
    if (typeof file !== 'string' || file.length > 32767) throw new Error('ui.stores.error.linkFileInvalid');
    return storeCandidatePayload(await readStoreLinkFile(file));
  });
  handleMutation('stores:previewArtwork', async (candidateId: unknown) => {
    if (typeof candidateId !== 'string' || !storeLinkCandidates.has(candidateId)) throw new Error('ui.stores.artwork.stale');
    const candidate = storeLinkCandidates.get(candidateId)!;
    if (!candidate.artwork) throw new Error('ui.stores.artwork.invalid');
    return storeArtworkPreviews.preview(candidateId, candidate.provider, candidate.productId, candidate.artwork.url);
  });
  handleMutation('stores:applyArtwork', async (candidateId: unknown, previewId: unknown, gameId: string) => {
    if (typeof candidateId !== 'string' || !storeLinkCandidates.get(candidateId)?.artwork) throw new Error('ui.stores.artwork.stale');
    requireGamePath(gameId);
    const index = await loadLibrary();
    if (!index.games.some(game => idFor(game.path) === gameId && withinLibraryRoot(game.path))) throw new Error('ui.stores.error.invalidGame');
    const bytes = storeArtworkPreviews.get(candidateId, previewId);
    // Apply exactly what was previewed. Never refetch a mutable URL here.
    const thumbnail = await importManualThumbnailBytes(defaultDataDir(), gameId, bytes);
    return { gameId, thumbnail };
  });
  handleMutation('stores:save', async (candidateId: unknown, managedProductId?: unknown, gameId?: unknown, title?: unknown) => {
    if (typeof candidateId !== 'string' || !storeLinkCandidates.has(candidateId)) throw new Error('ui.stores.error.staleCandidate');
    if (managedProductId !== undefined && gameId !== undefined) throw new Error('ui.stores.error.invalidManagedProduct');
    if (managedProductId !== undefined) {
      if (typeof managedProductId !== 'string' || !(await listGameInstallations(defaultDataDir())).products.some((p) => p.id === managedProductId)) {
        throw new Error('ui.stores.error.invalidManagedProduct');
      }
    }
    if (gameId !== undefined) {
      requireGamePath(gameId);
      const index = await loadLibrary();
      if (!index.games.some((game) => idFor(game.path) === gameId && withinLibraryRoot(game.path))) throw new Error('ui.stores.error.invalidGame');
    }
    const candidate = storeLinkCandidates.get(candidateId)!;
    const chosen = title === undefined ? candidate : parseStoreLink({ ...candidate, title });
    await saveStoreConnection(defaultDataDir(), chosen, managedProductId as string | undefined, gameId as string | undefined);
    storeArtworkPreviews.revoke(candidateId);
    storeLinkCandidates.delete(candidateId);
    return storeConnectionsPayload();
  });
  handleMutation('stores:remove', async (linkId: unknown) => {
    if (typeof linkId !== 'string') throw new Error('ui.stores.error.invalidConnection');
    await removeStoreConnection(defaultDataDir(), linkId);
    return storeConnectionsPayload();
  });
  handleMutation('stores:open', async (provider: unknown, action: unknown, linkId?: unknown) => {
    if (typeof provider !== 'string' || !STORE_PROVIDERS.some((entry) => entry.id === provider)) throw new Error('ui.stores.error.invalidProvider');
    if (typeof action !== 'string' || !STORE_ACTIONS.includes(action as StoreHandoffAction)) throw new Error('ui.stores.error.invalidAction');
    let link: StoreConnection | undefined;
    if (linkId !== undefined) {
      if (typeof linkId !== 'string') throw new Error('ui.stores.error.invalidConnection');
      link = (await readStoreConnections(defaultDataDir())).links.find((entry) => entry.id === linkId && entry.provider === provider);
      if (!link) throw new Error('ui.stores.error.invalidConnection');
    }
    const handoff = resolveStoreHandoff(provider as StoreProviderId, action as StoreHandoffAction, link);
    if (handoff.kind === 'official-client' && !app.getApplicationNameForProtocol(handoff.url)) throw new Error('ui.stores.error.clientMissing');
    await shell.openExternal(handoff.url);
    return { opened: true, kind: handoff.kind, authentication: 'unverified' };
  });
  handleMutation('stores:openCompanion', async () => {
    const folder = await exportBrowserCompanion(bundleRoot, defaultDataDir(), app.getVersion());
    const error = await shell.openPath(folder);
    if (error) throw new Error('ui.stores.error.companionOpenFailed');
    return { opened: true };
  });
  handle('archives:current', () => structuredClone(archiveTask));
  handle('archives:list', async () => {
    await mutationQueue;
    const records = await archiveRecords();
    try {
      return { records, catalog: await listGameInstallations(defaultDataDir()), recoveryError: archiveRecoveryError };
    } catch (error) {
      // Preserve corrupt evidence while allowing the settings recovery card to
      // explain it. Mutating APIs continue to require a valid on-disk catalog.
      return { records, catalog: null, recoveryError: localiseTaskError(error) };
    }
  });
  handleMutation('archives:pick', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'],
      title: t('ui.archives.pickTitle'), filters: [{ name: t('ui.archives.archiveFiles'), extensions: ['zip', '7z', 'rar'] }] });
    const records = await archiveRecords();
    const catalog = await listGameInstallations(defaultDataDir());
    const source = picked.filePaths[0];
    if (picked.canceled || !source) return { candidate: null, records, catalog };
    const inspection = await inspectGameArchive(source);
    while (archiveCandidates.size >= 20) archiveCandidates.delete(archiveCandidates.keys().next().value!);
    const id = crypto.randomUUID();
    archiveCandidates.set(id, { path: source, inspection });
    return { candidate: { id, ...inspection }, records, catalog };
  });
  handle('archives:import', (candidateId: unknown, label: unknown, productId?: unknown) => importSelectedArchive(candidateId, label, productId));
  handleMutation('archives:activate', async (installationId: unknown) => {
    if (ownedGames.snapshot().sessions.length) throw new Error('ui.gaming.error.gameRunning');
    if (typeof installationId !== 'string') throw new Error('ui.archives.reason.invalidInstallation');
    const catalog = await listGameInstallations(defaultDataDir());
    const installation = catalog.installations.find((entry) => entry.id === installationId);
    const record = installation && (await listGameArchives(defaultDataDir())).find((entry) => entry.id === installation.archiveId);
    if (!record) throw new Error('ui.archives.reason.invalidInstallation');
    await security.scanStage(record.root);
    await registerArchiveVersion(record);
    await setActiveGameInstallation(defaultDataDir(), installationId);
    return archiveSnapshot(idFor(record.gameRoot));
  });
  handleMutation('archives:recover', async () => {
    await recoverGameInstallations({ dataDir: defaultDataDir(), registry, register: registerArchiveVersion });
    archiveRecoveryError = undefined;
    return archiveSnapshot();
  });
  handle('mtool:status', async () => { await mutationQueue; return currentMToolStatus(); });
  handleMutation('mtool:pick', async () => {
    const picked = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: t('ui.mtool.pickTitle', undefined, 'Select the MTool bundle or its Tool subfolder'),
    });
    const current = await loadConfig();
    if (picked.canceled || !picked.filePaths[0]) return { config: current, mtoolStatus: await currentMToolStatus() };
    const mtoolStatus = await getMToolStatus(picked.filePaths[0]);
    requireReadyMTool(mtoolStatus);
    const config = { ...current, externalTools: { ...current.externalTools, mtoolRoot: mtoolStatus.root! } };
    await saveConfig(config);
    return { config, mtoolStatus };
  });
  handleMutation('mtool:clear', async () => {
    const current = await loadConfig();
    const config = { ...current, externalTools: { ...current.externalTools, mtoolRoot: null } };
    await saveConfig(config);
    return { config, mtoolStatus: await getMToolStatus(null) };
  });
  handle('mtool:launch', (gameId: string) => {
    requireGamePath(gameId);
    return enqueueMToolLaunch(gameId);
  });
  handle('mtool:open', () => enqueueMToolLaunch());
  handle('mtool:openFolder', async () => {
    const status = await currentMToolStatus(); requireReadyMTool(status);
    const error = await shell.openPath(status.toolDirectory!);
    if (error) throw new Error(error);
    return true;
  });
  handle('mtool:selectGameFile', async (gameId: string) => {
    const target = await getMToolGameExecutable(requireMToolGame(gameId)).catch((error: Error) => {
      throw new Error(/^ui\.mtool\.reason\./.test(error.message) ? t(error.message) : error.message);
    });
    shell.showItemInFolder(target);
    return true;
  });
  handleMutation('config:set', async (config: LauncherConfig) => {
    // Only the fields the UI owns are honoured; roots are managed separately so
    // a config round-trip cannot quietly add a scan root.
    const current = await loadConfig();
    const locale = typeof config?.locale === 'string' ? config.locale : current.locale;
    await saveConfig({
      ...current,
      locale,
      scanDepth: config?.scanDepth === undefined ? current.scanDepth : normalizeScanDepth(config.scanDepth),
      defaults: {
        targetLanguage: String(config?.defaults?.targetLanguage ?? current.defaults.targetLanguage),
        sourceLanguage: String(config?.defaults?.sourceLanguage ?? current.defaults.sourceLanguage),
        endpoint: String(config?.defaults?.endpoint ?? current.defaults.endpoint),
      },
    });
    // Core renders its messages at creation time, so the active locale has to
    // change here before the renderer re-fetches the library.
    setLocale(locale);
    return loadConfig();
  });

  handleMutation('root:remove', async (root: string) => {
    const config = await removeRoot(String(root));
    libraryRoots = config.roots;
    rememberGames((await loadLibrary()).games.filter((game) => withinLibraryRoot(game.path)));
    return config;
  });

  // Adding a root always goes through the OS picker: the path comes from the
  // user via a native dialog, never from the renderer.
  handleMutation('root:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Add a library root' });
    if (result.canceled || result.filePaths.length === 0) return undefined;
    libraryRoots = (await addRoot(result.filePaths[0]!)).roots;
    return result.filePaths[0];
  });

  handle('library:load', async () => {
    await mutationQueue;
    const index = await loadLibrary();
    const payload = libraryPayload(index, safeResolveOptions((await loadConfig()).defaults));
    rendererReady = true;
    if (queuedEntry) {
      const entry = queuedEntry; queuedEntry = undefined;
      setImmediate(() => { void runGamingEntry(entry); });
    }
    return payload;
  });

  // These cannot wait for the mutation queue: reload and cancellation must
  // remain responsive while the queued scan is running.
  handle('library:scanCurrent', () => libraryScan.snapshot());
  handle('library:cancelScan', (id: unknown) => libraryScan.cancel(id));

  handleMutation('library:scan', async (options: { depth?: number; deep?: boolean }) => {
    const config = await loadConfig();
    const depth = normalizeScanDepth(options?.depth ?? config.scanDepth);
    const signal = libraryScan.start(depth);
    const scanOptions: Parameters<typeof refreshLibrary>[1] = {
      depth, signal,
      onStatus: (progress) => libraryScan.progress(progress),
      onBeforeSave: () => libraryScan.commit(),
    };
    if (typeof options?.deep === 'boolean') scanOptions.deep = options.deep;
    let saved = false;
    try {
      const index = await refreshLibrary(registry, scanOptions);
      saved = true;
      const result = libraryPayload(index, safeResolveOptions(config.defaults));
      libraryScan.finish('complete', { result, saved });
      return result;
    } catch (error) {
      const cancelled = error instanceof ScanCancelledError || (error instanceof Error && error.message === 'ui.scan.cancelled');
      const message = cancelled ? t('ui.scan.cancelled') : error instanceof ScanLimitError
        ? t('ui.scan.error.limit') : localiseTaskError(error);
      libraryScan.finish(cancelled ? 'cancelled' : 'failed', { error: message, saved });
      throw new Error(message);
    }
  });

  handle('game:detail', async (gameId: string, options: ResolveOptions) => {
    requireGamePath(gameId);
    return stableGameRead(gameId, () => gameDetailPayload(gameId, safeResolveOptions(options)));
  });

  handle('game:thumbnail', async (gameId: string) => {
    const gamePath = requireGamePath(gameId);
    const manual = await readManualThumbnail(defaultDataDir(), gameId);
    if (manual) return manual;
    const preferences = await readThumbnailPreferences(defaultDataDir()).catch(() => new Map<string, string>());
    const chosen = preferences.get(gameId);
    if (chosen) {
      const gog = /^gog:([1-9]\d{0,19}):([a-f0-9]{64})$/.exec(chosen);
      const image = await (gog ? fetchGogCover(gog[2]!, gog[1]!) : fetchSteamCover(chosen)).catch(() => null);
      if (image) return image;
    }
    return getGameThumbnail(gamePath);
  });

  handleMutation('game:pickThumbnail', async (gameId: string, fromGameFolder: unknown = false) => {
    const gamePath = requireGamePath(gameId);
    if (typeof fromGameFolder !== 'boolean') throw new Error('ui.thumbnail.importFailed');
    const picked = await dialog.showOpenDialog({ properties: ['openFile'],
      ...(fromGameFolder ? { defaultPath: gamePath } : {}),
      title: t('ui.thumbnail.pickTitle', undefined, 'Choose a cover image'),
      filters: [{ name: 'PNG / JPEG / WebP', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    const source = picked.filePaths[0];
    if (picked.canceled || !source) return null;
    requireGamePath(gameId);
    try { return await importManualThumbnail(defaultDataDir(), gameId, source); }
    catch { throw new Error('ui.thumbnail.importFailed'); }
  });
  handleMutation('game:importThumbnail', async (gameId: string, source: unknown) => {
    requireGamePath(gameId);
    if (typeof source !== 'string' || source.length > 32767) throw new Error('ui.thumbnail.importFailed');
    try { return await importManualThumbnail(defaultDataDir(), gameId, source); }
    catch { throw new Error('ui.thumbnail.importFailed'); }
  });
  handleMutation('game:clearThumbnail', async (gameId: string) => {
    requireGamePath(gameId);
    try { await clearManualThumbnail(defaultDataDir(), gameId); }
    catch { throw new Error('ui.thumbnail.importFailed'); }
    return null;
  });

  // The title is sent to Steam only after the user explicitly presses Search.
  // A result id is usable only for the specific game whose search returned it.
  handle('game:thumbnailSearch', async (gameId: string) => {
    const gamePath = requireGamePath(gameId);
    const generation = (thumbnailSearchGeneration.get(gameId) ?? 0) + 1;
    thumbnailSearchGeneration.set(gameId, generation);
    thumbnailSearchResults.delete(gameId);
    const index = await loadLibrary();
    const game = index.games.find((entry) => path.resolve(entry.path).toLowerCase() === gamePath.toLowerCase());
    if (!game) throw new Error('Game is no longer in the library.');
    const results = await searchSteamCovers((game.title || game.name).slice(0, 120));
    requireGamePath(gameId);
    if (thumbnailSearchGeneration.get(gameId) !== generation) return [];
    if (thumbnailSearchResults.size >= 100 && !thumbnailSearchResults.has(gameId)) thumbnailSearchResults.delete(thumbnailSearchResults.keys().next().value!);
    thumbnailSearchResults.set(gameId, new Set(results.map((result) => result.appId)));
    return results;
  });

  handleMutation('game:thumbnailSelect', async (gameId: string, appId: unknown) => {
    requireGamePath(gameId);
    if (typeof appId !== 'string' || !thumbnailSearchResults.get(gameId)?.has(appId)) throw new Error('Select a current Steam search result.');
    const image = await fetchSteamCover(appId);
    if (!image) throw new Error('Steam artwork is unavailable.');
    requireGamePath(gameId);
    await saveThumbnailPreference(defaultDataDir(), gameId, appId);
    await clearManualThumbnail(defaultDataDir(), gameId);
    return image;
  });

  // GOG search is user-triggered and its result IDs have authority only for
  // the game whose latest search returned them. Renderer never supplies URLs.
  handle('game:thumbnailSearchGog', async (gameId: string) => {
    const gamePath = requireGamePath(gameId);
    const generation = gogSearchAuthority.begin(gameId);
    const index = await loadLibrary();
    const game = index.games.find((entry) => path.resolve(entry.path).toLowerCase() === gamePath.toLowerCase());
    if (!game) throw new Error('Game is no longer in the library.');
    const results = await searchGogCovers((game.title || game.name).slice(0, 120));
    requireGamePath(gameId);
    return gogSearchAuthority.complete(gameId, generation, results);
  });
  handleMutation('game:thumbnailSelectGog', async (gameId: string, id: unknown) => {
    requireGamePath(gameId);
    const authorization = gogSearchAuthority.grant(gameId, id);
    if (typeof id !== 'string' || !authorization) throw new Error('Select a current GOG search result.');
    const image = await fetchGogCover(authorization.hash, id);
    if (!image) throw new Error('GOG artwork is unavailable.');
    requireGamePath(gameId);
    if (!gogSearchAuthority.isCurrent(gameId, id, authorization)) throw new Error('Select a current GOG search result.');
    await saveThumbnailPreference(defaultDataDir(), gameId, `gog:${id}:${authorization.hash}`);
    await clearManualThumbnail(defaultDataDir(), gameId);
    return image;
  });

  handleMutation('game:refresh', async (gameId: string) => refreshGameState(gameId, () => {}));

  handle('maintenance:start', (input: OperationRequest) => {
    if (!input || typeof input !== 'object') throw new Error('Malformed operation request.');
    if (pendingMutations > 0 || operations.isActive()) throw new Error(t('ui.operation.busy'));
    requireGamePath(input.gameId);
    if (ownedGames.has(input.gameId)) throw new Error('ui.gaming.error.gameRunning');
    const translatorKind = input.kind === 'remove-translator' || input.kind === 'reinstall-translator';
    const request: OperationRequest = {
      requestId: input.requestId, gameId: input.gameId, kind: input.kind,
      ...(input.kind === 'install' || input.kind === 'install-font' || translatorKind ? { planId: input.planId } : {}),
    };
    const plan = request.kind === 'install' || request.kind === 'install-font' ? requirePlan(request.gameId, request.planId) : undefined;
    const translatorMaintenance = translatorKind ? requireTranslatorMaintenance(request.gameId, request.planId) : undefined;
    if (translatorMaintenance && !(request.kind === 'remove-translator' ? translatorMaintenance.removeEligible : translatorMaintenance.reinstallEligible)) {
      throw new Error(t(request.kind === 'remove-translator' ? translatorMaintenance.blockReasonKey! : translatorMaintenance.reinstallBlockReasonKey!));
    }
    if (plan && (request.kind === 'install-font') !== (plan.purpose === 'font')) throw new Error('The operation kind does not match the selected plan.');
    const options = planOptionsById.get(request.planId ?? '') ?? {};
    if (plan && !plan.viable) throw new Error('That plan cannot be installed.');
    return operations.start(request, (report) => runMaintenance(request, plan, options, report, translatorMaintenance));
  });
  handle('maintenance:current', () => operations.current());
  handle('maintenance:outcome', (operationId: string) => operations.outcome(String(operationId)));
  handle('maintenance:acknowledge', (operationId: string) => operations.acknowledge(String(operationId)));

  handleMutation('mods:toggle', async (gameId: string, modId: string, enabled: boolean) => {
    const gamePath = requireGamePath(gameId);
    const profile = detectGame(registry, gamePath);
    if (!profile) throw new Error('Game folder is gone.');
    if (enabled === true) {
      const mod = (await listMods(registry, profile)).find((item) => item.id === modId || item.name === modId);
      if (!mod) throw new Error('ui.security.actionFailed');
      await security.scanBeforeUse(path.join(gamePath, mod.file));
    }
    await setModEnabled(registry, profile, String(modId), enabled === true);
    markGameChanged(gameId);
    return listMods(registry, profile);
  });

  handleMutation('mods:add', async (gameId: string) => {
    const gamePath = requireGamePath(gameId);
    const profile = detectGame(registry, gamePath);
    if (!profile) throw new Error('Game folder is gone.');
    const picked = await dialog.showOpenDialog({
      title: 'Pick a mod archive or file',
      properties: ['openFile'],
      filters: [{ name: 'Mods', extensions: ['zip', 'dll', 'js', 'rpy'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return undefined;
    const inspected = await security.scanBeforeUse(picked.filePaths[0]!);
    if (inspected.fingerprint?.scope !== 'file') throw new Error('ui.security.block.notChecked');
    await installModFromFile(registry, profile, picked.filePaths[0]!, { expectedSha256: inspected.fingerprint?.sha256 });
    markGameChanged(gameId);
    return listMods(registry, profile);
  });

  // The executable is resolved main-side from the detected profile: the
  // renderer cannot name an arbitrary binary to spawn.
  handle('game:launch', (gameId: string) => launchGame(gameId));

  handle('config:read', async (gameId: string, translatorId: string) => {
    // Renderer reads are always redacted.  Main-side planning below may read
    // the raw file so unchanged credentials are preserved, but those values
    // never cross the IPC boundary.
    requireGamePath(gameId);
    return stableGameRead(gameId, () => translatorConfigPayload(requireDetectedGame(gameId), translatorId));
  });

  handleMutation('config:clearHistory', async (gameId: string) => {
    requireGamePath(gameId);
    if (!comparisonHistory) throw new Error(t('ui.configComparison.history.unavailable'));
    try { await comparisonHistory.remove(gameId); }
    catch { throw new Error(t('ui.configComparison.history.clearFailed')); }
    lastOptionComparisonsByGame.delete(gameId);
  });

  handle('config:plan', async (gameId: string, translatorId: string, changes: ConfigChange[]) => {
    const { schema, config, profile } = await configContext(gameId, translatorId);
    const plan = planConfigChanges(schema, config, sanitiseChanges(changes), {
      fontBundles: profile.installedFontBundles,
    });
    return redactConfigPlan(plan);
  });

  handleMutation('config:write', async (gameId: string, translatorId: string, changes: ConfigChange[]) => {
    const { schema, config, profile } = await configContext(gameId, translatorId);
    const plan = planConfigChanges(schema, config, sanitiseChanges(changes), {
      fontBundles: profile.installedFontBundles,
    });
    if (!plan.valid) return { plan: redactConfigPlan(plan), result: undefined };
    // The plan is rebuilt here from the current file rather than trusting one
    // the renderer held on to, so a stale form cannot overwrite newer values.
    const result = await writeGameConfig(profile, config, plan);
    markGameChanged(gameId);
    return { plan: redactConfigPlan(plan), result };
  });

  handle('shell:openGameFolder', async (gameId: string) => shell.openPath(requireGamePath(gameId)));

  handle('shell:openExternal', async (url: string) => {
    const value = safeExternalUrl(url, declaredExternalUrls());
    if (!value) throw new Error('ui.security.externalBlocked');
    await shell.openExternal(value);
    return true;
  });
}

void app.whenReady().then(async () => {
  if (!ownsInstance) return;
  try {
    // Language before anything else: the registry load itself can throw a
    // translated error.
    if (app.isPackaged) loadCatalogs(path.join(app.getAppPath(), 'locales'));
    const config = await loadConfig();
    setLocale(config.locale);
    libraryRoots = config.roots;
    try { gamingPreferences = await readGamingPreferences(defaultDataDir()); }
    catch { gamingSettingsError = true; }
    registry = loadRegistry(app.isPackaged ? path.join(app.getAppPath(), 'registry') : undefined);
    const comparisonSchema = registry.configSchemas.get('xunity-autotranslator');
    if (comparisonSchema) comparisonHistory = new TranslationConfigHistory(defaultDataDir(), comparisonSchema);
  } catch (err) {
    dialog.showErrorBox('Registry not found', (err as Error).message);
    app.quit();
    return;
  }
  configureAutoUpdates();
  security = createSecurityController({ scanner: appSecurityScanner(), enqueue: (work) => enqueueMutation(work),
    isBusy: () => pendingMutations > 0 || operations.isActive() || updateRestartReserved,
    emit: (snapshot) => {
      const task = snapshot.task;
      if (task?.gameId && task.result && task.status !== 'running') {
        securityResultsByGame.delete(task.gameId);
        while (securityResultsByGame.size >= 100) securityResultsByGame.delete(securityResultsByGame.keys().next().value!);
        securityResultsByGame.set(task.gameId, task.result);
      }
      if (task?.kind === 'signature-update' && task.status === 'complete') securityResultsByGame.clear();
      send('security:status', snapshot);
    } });
  // Reconcile only our own recorded UUID installations. This does not scan
  // configured library drives or restart an interrupted source extraction.
  try {
    await enqueueMutation(() => recoverGameInstallations({ dataDir: defaultDataDir(), registry, register: registerArchiveVersion }));
  } catch (error) {
    archiveRecoveryError = localiseTaskError(error);
    console.error('[installations] recovery failed:', archiveRecoveryError);
  }
  register();
  if (!queuedEntry) {
    if (process.env['INDIEDECK_SMOKE']) {
      const entry = entryArguments(process.argv);
      // Packaged startup checks can verify fullscreen, but a smoke environment
      // never authorizes a real game launch from process arguments.
      if (entry.valid && !entry.launchGameId) queuedEntry = entry;
    } else await acceptGamingEntry(process.argv);
  }
  createWindow();
  void security.refresh().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (pendingMutations > 0 || operations.isActive()) event.preventDefault();
});

export type { GameProfile };

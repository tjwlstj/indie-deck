import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { inspectGameArchive, importGameArchive, listGameArchives, type GameArchiveInspection } from './game-archives.ts';
import { createLauncherUpdateController, LAUNCHER_RELEASE_URL } from './launcher-updates.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
const APP_ID = 'io.github.tjwlstj.indiedeck';

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let registry: Registry;
let mainWindow: BrowserWindow | undefined;
let pendingMutations = 0;
let updateRestartReserved = false;
let sessionEnding = false;
let launcherUpdates: ReturnType<typeof createLauncherUpdateController>;
let mutationQueue: Promise<void> = Promise.resolve();
let stateRevision = 0;
const gameRevisions = new Map<string, number>();
let libraryRoots: string[] = [];

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
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
const archiveCandidates = new Map<string, { path: string; inspection: GameArchiveInspection }>();
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

function idFor(gamePath: string): string {
  return crypto.createHash('sha1').update(path.resolve(gamePath).toLowerCase()).digest('hex').slice(0, 16);
}

function rememberGames(profiles: GameProfile[]): void {
  const currentIds = new Set(profiles.map((profile) => idFor(profile.path)));
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
  const resolved = path.resolve(gamePath).toLowerCase();
  return libraryRoots.some((root) => {
    const base = path.resolve(root).toLowerCase();
    return resolved === base || resolved.startsWith(base + path.sep);
  });
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

function cacheTranslatorMaintenance(gameId: string, profile: GameProfile, preview: TranslatorMaintenancePreview) {
  while (translatorMaintenanceById.size >= 100) translatorMaintenanceById.delete(translatorMaintenanceById.keys().next().value!);
  const previewId = `${gameId}:${crypto.randomUUID()}`;
  translatorMaintenanceById.set(previewId, { gameId, path: path.resolve(profile.path), preview });
  return {
    previewId, supported: preview.supported, eligible: preview.eligible,
    canRemove: preview.removeEligible, canReinstall: preview.reinstallEligible,
    blockedReason: preview.blockReasonKey ? t(preview.blockReasonKey) : undefined,
    reinstallBlockedReason: preview.reinstallBlockReasonKey ? t(preview.reinstallBlockReasonKey) : undefined,
    files: preview.files, currentVersions: preview.currentVersions, targetVersion: preview.version,
    variantId: preview.variantId, preservedPaths: preview.preservedPaths,
  };
}

function requireTranslatorMaintenance(gameId: string, previewId: unknown): TranslatorMaintenancePreview {
  if (typeof previewId !== 'string' || !previewId.startsWith(`${gameId}:`)) throw new Error('Maintenance preview does not belong to this game.');
  const entry = translatorMaintenanceById.get(previewId);
  if (!entry || entry.gameId !== gameId || entry.path !== requireGamePath(gameId)) throw new Error(t('ui.maintenance.reason.stale'));
  return entry.preview;
}

/* ------------------------------------------------------------- window */

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#12131a',
    title: 'IndieDeck',
    show: false,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  void window.loadFile(path.join(here, '..', 'renderer', 'index.html'));

  // Anything that wants to leave the app goes to the real browser, never to a
  // new Electron window with node access.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
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
  await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()));

  while (Date.now() < deadline) {
    const report = (await window.webContents.executeJavaScript(
      `({
        ready: document.body.dataset.libraryState === 'ready',
        games: document.querySelectorAll('#gameList .game').length,
        engines: document.querySelectorAll('#engineFilters button').length,
        status: document.getElementById('status')?.textContent ?? '',
        counts: document.getElementById('counts')?.textContent ?? '',
      })`,
    )) as { ready: boolean; games: number; engines: number; status: string; counts: string };

    // Waits on a data attribute, not on English prose - the launcher is
    // translated, so the status line is not a stable signal.
    if (report.ready && report.engines > 0) {
      const localeReports = availableLocales();
      if (localeReports.some((locale) => locale.keys === 0)) {
        console.error(`[smoke] packaged locale catalogue missing: ${localeReports.filter((locale) => locale.keys === 0).map((locale) => locale.code).join(', ')}`);
        app.exit(1);
        return;
      }
      console.log(`[smoke] rendered ${report.games} game rows, ${report.engines} engine filters - ${report.counts || report.status}`);
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

      if (process.env['INDIEDECK_SMOKE_FLOW'] === '1') await runOperationSmoke(window);

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
        const image = await window.webContents.capturePage();
        await writeFile(shot, image.toPNG());
        console.log(`[smoke] screenshot written to ${shot}`);
      }

      app.exit(0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.error('[smoke] renderer did not finish loading within 20s');
  app.exit(1);
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
  console.log('[smoke] OS-picked ZIP inspection → two side-by-side labeled game versions → library refresh/selection → original archives and predecessor preserved passed');

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
    const timer = setTimeout(() => {
      // A manual check/download may already have completed (including a cached
      // download). Startup must not clear that user's verified install state.
      if (launcherUpdates.snapshot().status !== 'idle') return;
      void launcherUpdates.check().catch(() => {});
    }, 8_000);
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
    gameRevision: gameRevisions.get(gameId) ?? 0,
    plans,
    fontRecommendation,
    fontPlan,
    ...(profile.engineId === 'unity' ? { translatorMaintenance: cacheTranslatorMaintenance(gameId, profile,
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
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd, shell: false, detached: true, stdio: 'ignore',
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
    'Only RPG Maker MV/MZ/XP/VX/VX Ace games can currently be handed to MTool.'));
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
        request.kind === 'remove-translator' ? 'remove' : 'reinstall', { onEvent: (event) => report(event) });
      result = { ...result, status: maintained.pendingUserActions.length ? 'needs-user-action' : 'success',
        mutationStatus: maintained.mutationStatus, rollbackStatus: maintained.rollbackStatus,
        rollbackFailures: maintained.rollbackFailures, result: maintained };
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
  return /^ui\.(maintenance|archives|update)\.[a-zA-Z0-9.]+$/.test(message) ? t(message) : message;
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

function importSelectedArchive(candidateId: unknown, label: unknown) {
  if (pendingMutations > 0 || operations.isActive()) throw new Error(t('ui.operation.busy'));
  if (typeof candidateId !== 'string') throw new Error(t('ui.archives.reason.stale'));
  const candidate = archiveCandidates.get(candidateId);
  if (!candidate) throw new Error(t('ui.archives.reason.stale'));
  if (!candidate.inspection.canImport) throw new Error(t(candidate.inspection.reasonKey ?? 'ui.archives.reason.unsupported'));
  if (label !== undefined && (typeof label !== 'string' || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label))) {
    throw new Error(t('ui.archives.reason.invalidLabel'));
  }
  archiveTask = { id: candidateId, sequence: ++archiveSequence, status: 'running', phase: 'inspect',
    completedFiles: 0, totalFiles: candidate.inspection.fileCount ?? 0,
    completedBytes: 0, totalBytes: candidate.inspection.unpackedBytes ?? 0 };
  send('archives:progress', structuredClone(archiveTask));
  return enqueueMutation(async () => {
    try {
      const imported = await importGameArchive(candidate.path, {
        dataDir: defaultDataDir(), registry, label: typeof label === 'string' ? label.trim() : undefined,
        expectedSha256: candidate.inspection.sha256,
        onProgress: (event) => publishArchiveTask({
          phase: event.phase === 'verify' || event.phase === 'detect' ? 'inspect' : event.phase,
          completedFiles: event.filesDone, totalFiles: event.filesTotal,
          completedBytes: event.bytesDone, totalBytes: event.bytesTotal,
        }),
      });
      const config = await addRoot(imported.record.gameRoot);
      libraryRoots = config.roots;
      const refreshed = await refreshLibraryGame(registry, imported.record.gameRoot);
      const library = libraryPayload(refreshed.index, safeResolveOptions(config.defaults));
      const gameId = idFor(imported.record.gameRoot);
      markGameChanged(gameId);
      const result = { record: { ...imported.record, gameId }, duplicate: imported.duplicate,
        records: await archiveRecords(), config, library, gameId };
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
    return enqueueMutation(() => fn(...args));
  });
}

function register(): void {
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
  handle('archives:current', () => structuredClone(archiveTask));
  handle('archives:list', async () => { await mutationQueue; return { records: await archiveRecords() }; });
  handleMutation('archives:pick', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'],
      title: t('ui.archives.pickTitle'), filters: [{ name: t('ui.archives.archiveFiles'), extensions: ['zip', '7z', 'rar'] }] });
    const records = await archiveRecords();
    const source = picked.filePaths[0];
    if (picked.canceled || !source) return { candidate: null, records };
    const inspection = await inspectGameArchive(source);
    while (archiveCandidates.size >= 20) archiveCandidates.delete(archiveCandidates.keys().next().value!);
    const id = crypto.randomUUID();
    archiveCandidates.set(id, { path: source, inspection });
    return { candidate: { id, ...inspection }, records };
  });
  handle('archives:import', (candidateId: unknown, label: unknown) => importSelectedArchive(candidateId, label));
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
    return libraryPayload(index, safeResolveOptions((await loadConfig()).defaults));
  });

  handleMutation('library:scan', async (options: { depth?: number; deep?: boolean }) => {
    const scanOptions: Parameters<typeof refreshLibrary>[1] = {
      onProgress: (current) => mainWindow?.webContents.send('scan:progress', current),
    };
    if (typeof options?.depth === 'number') scanOptions.depth = options.depth;
    if (typeof options?.deep === 'boolean') scanOptions.deep = options.deep;
    const index = await refreshLibrary(registry, scanOptions);
    return libraryPayload(index, safeResolveOptions((await loadConfig()).defaults));
  });

  handle('game:detail', async (gameId: string, options: ResolveOptions) => {
    requireGamePath(gameId);
    return stableGameRead(gameId, () => gameDetailPayload(gameId, safeResolveOptions(options)));
  });

  handleMutation('game:refresh', async (gameId: string) => refreshGameState(gameId, () => {}));

  handle('maintenance:start', (input: OperationRequest) => {
    if (!input || typeof input !== 'object') throw new Error('Malformed operation request.');
    if (pendingMutations > 0 || operations.isActive()) throw new Error(t('ui.operation.busy'));
    requireGamePath(input.gameId);
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
    await installModFromFile(registry, profile, picked.filePaths[0]!);
    markGameChanged(gameId);
    return listMods(registry, profile);
  });

  // The executable is resolved main-side from the detected profile: the
  // renderer cannot name an arbitrary binary to spawn.
  handle('game:launch', async (gameId: string) => {
    if (pendingMutations > 0) throw new Error(t('ui.operation.busy', undefined, 'Wait for the current file operation to finish.'));
    const gamePath = requireGamePath(gameId);
    const profile = detectGame(registry, gamePath);
    if (!profile?.executable) throw new Error('No launchable executable was detected in this folder.');
    const target = path.join(gamePath, profile.executable);
    if (!target.startsWith(gamePath + path.sep)) throw new Error('Refusing to launch outside the game folder.');
    const child = spawn(target, { cwd: gamePath, detached: true, stdio: 'ignore' });
    child.unref();
    return profile.executable;
  });

  handle('config:read', async (gameId: string, translatorId: string) => {
    // Renderer reads are always redacted.  Main-side planning below may read
    // the raw file so unchanged credentials are preserved, but those values
    // never cross the IPC boundary.
    requireGamePath(gameId);
    return stableGameRead(gameId, () => translatorConfigPayload(requireDetectedGame(gameId), translatorId));
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
    const value = String(url);
    if (!/^https:\/\//i.test(value)) throw new Error('Only https links can be opened.');
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
    registry = loadRegistry(app.isPackaged ? path.join(app.getAppPath(), 'registry') : undefined);
  } catch (err) {
    dialog.showErrorBox('Registry not found', (err as Error).message);
    app.quit();
    return;
  }
  configureAutoUpdates();
  register();
  createWindow();

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

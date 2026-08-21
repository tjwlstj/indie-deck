import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addRoot,
  applyPlan,
  auditGame,
  auditLibrary,
  detectGame,
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
  refreshLibrary,
  removeRoot,
  resolvePlans,
  saveConfig,
  setModEnabled,
  summarisePlans,
  uninstallReceipt,
  type GameProfile,
  type LauncherConfig,
  type Registry,
  type ResolveOptions,
  type ConfigChange,
  type ConfigSchema,
  type TranslatorPlan,
} from '@indiedeck/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
const APP_ID = 'io.github.tjwlstj.indiedeck';

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let registry: Registry;
let mainWindow: BrowserWindow | undefined;
let pendingMutations = 0;
let mutationQueue: Promise<void> = Promise.resolve();

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

function idFor(gamePath: string): string {
  return crypto.createHash('sha1').update(path.resolve(gamePath).toLowerCase()).digest('hex').slice(0, 16);
}

function rememberGames(profiles: GameProfile[]): void {
  for (const profile of profiles) gamePathsById.set(idFor(profile.path), path.resolve(profile.path));
}

function requireGamePath(gameId: unknown): string {
  if (typeof gameId !== 'string' || !/^[0-9a-f]{16}$/.test(gameId)) throw new Error('Malformed game id.');
  const resolved = gamePathsById.get(gameId);
  if (!resolved) throw new Error('Unknown game - rescan the library and try again.');
  return resolved;
}

function withId<T extends { path: string }>(profile: T): T & { id: string } {
  return { ...profile, id: idFor(profile.path) };
}

/** Recomputes plans for a game and keeps the authoritative copies main-side. */
function cachePlans(gameId: string, plans: TranslatorPlan[]): (TranslatorPlan & { id: string })[] {
  for (const key of [...plansById.keys()]) if (key.startsWith(`${gameId}:`)) plansById.delete(key);
  return plans.map((plan, index) => {
    const id = `${gameId}:${index}`;
    plansById.set(id, plan);
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
    if (pendingMutations === 0) return;
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

  // INDIEDECK_DEBUG=1 pipes renderer console output to the terminal, which is
  // the only way to see a renderer error when devtools are closed.
  if (process.env['INDIEDECK_DEBUG']) {
    window.webContents.on('console-message', (details) => {
      console.log(`[renderer:${details.level}] ${details.message}  (${details.sourceId}:${details.lineNumber})`);
    });
    window.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`[renderer] failed to load: ${description} (${code})`);
    });
    window.webContents.openDevTools({ mode: 'detach' });
  }

  // INDIEDECK_SMOKE=1 boots the window, waits for the library to render, prints
  // what it found and exits. Used in CI to catch a renderer that silently fails
  // to start, which no unit test would notice.
  if (process.env['INDIEDECK_SMOKE']) void runSmokeTest(window);
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

/* ------------------------------------------------------------ updates */

/**
 * Installed builds update from the NSIS artifact attached to GitHub Releases.
 * Portable builds deliberately opt out: there is no stable install location to
 * replace, so users update those by downloading the next portable executable.
 */
function configureAutoUpdates(): void {
  if (
    !app.isPackaged ||
    process.env['INDIEDECK_DISABLE_UPDATES'] === '1' ||
    process.env['PORTABLE_EXECUTABLE_DIR']
  ) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => console.error(`[updater] ${(err as Error).message}`));

  // Do not interrupt a translator/mod transaction with an updater-driven quit.
  // The update downloads in the background, shows a system notification, and
  // installs only after the user later exits the app normally.
  setTimeout(() => {
    void autoUpdater
      .checkForUpdatesAndNotify({
        title: t('ui.update.readyTitle', undefined, 'IndieDeck update ready'),
        body: t('ui.update.readyBody', undefined, 'The update will be installed after you close IndieDeck.'),
      })
      .catch((err: unknown) => console.error(`[updater] ${(err as Error).message}`));
  }, 8_000);
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
function libraryPayload(index: Awaited<ReturnType<typeof loadLibrary>>) {
  const games = index.games.map((game) => localiseProfile(registry, game));
  rememberGames(games);
  return {
    index: { ...index, games: games.map(withId) },
    stats: libraryStats({ ...index, games }),
    audits: auditLibrary(registry, games).map((a) => ({ ...a, id: idFor(a.path) })),
  };
}

/* ---------------------------------------------------------------- ipc */

/** Wraps a handler so renderer errors arrive as data, not as unhandled rejections. */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true as const, data: await fn(...(args as never[])) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });
}

/** Serialises every filesystem mutation and makes pending work quit-visible. */
function handleMutation<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  handle(channel, (...args: never[]) => {
    pendingMutations += 1;
    const result = mutationQueue.then(() => fn(...args));
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      pendingMutations -= 1;
    });
  });
}

function register(): void {
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

  handleMutation('root:remove', async (root: string) => removeRoot(String(root)));

  // Adding a root always goes through the OS picker: the path comes from the
  // user via a native dialog, never from the renderer.
  handleMutation('root:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Add a library root' });
    if (result.canceled || result.filePaths.length === 0) return undefined;
    await addRoot(result.filePaths[0]!);
    return result.filePaths[0];
  });

  handle('library:load', async () => {
    const index = await loadLibrary();
    return libraryPayload(index);
  });

  handleMutation('library:scan', async (options: { depth?: number; deep?: boolean }) => {
    const scanOptions: Parameters<typeof refreshLibrary>[1] = {
      onProgress: (current) => mainWindow?.webContents.send('scan:progress', current),
    };
    if (typeof options?.depth === 'number') scanOptions.depth = options.depth;
    if (typeof options?.deep === 'boolean') scanOptions.deep = options.deep;
    const index = await refreshLibrary(registry, scanOptions);
    return libraryPayload(index);
  });

  handle('game:detail', async (gameId: string, options: ResolveOptions) => {
    const gamePath = requireGamePath(gameId);
    const detected = detectGame(registry, gamePath, { deep: true });
    if (!detected) throw new Error('No known engine detected here any more - the folder may have changed.');
    const profile = localiseProfile(registry, detected);

    const safeOptions: ResolveOptions = {
      targetLanguage: String(options?.targetLanguage ?? 'en'),
      sourceLanguage: String(options?.sourceLanguage ?? 'ja'),
      endpoint: String(options?.endpoint ?? 'GoogleTranslate'),
      includeNonViable: true,
    };

    return {
      profile: withId(profile),
      plans: cachePlans(gameId, summarisePlans(resolvePlans(registry, profile, safeOptions))),
      audit: auditGame(registry, profile, {
        targetLanguage: safeOptions.targetLanguage,
        endpoint: safeOptions.endpoint,
      }),
      receipts: await readReceipts(profile.path),
      mods: await listMods(registry, profile),
      hosts: modHosts(registry, profile).map((h) => ({ loaderId: h.loader.id, name: h.loader.name, dir: h.dir })),
    };
  });

  handleMutation('game:install', async (gameId: string, planId: string, options: { dryRun?: boolean }) => {
    requireGamePath(gameId);
    const plan = requirePlan(gameId, planId);
    return applyPlan(plan, {
      dryRun: options?.dryRun === true,
      logger: {
        level: 'info',
        debug: () => {},
        info: (msg: string) => mainWindow?.webContents.send('install:progress', msg),
        warn: (msg: string) => mainWindow?.webContents.send('install:progress', msg),
        error: (msg: string) => mainWindow?.webContents.send('install:progress', msg),
        child: () => ({}) as never,
      },
      onProgress: (received, total) => mainWindow?.webContents.send('install:bytes', { received, total: total ?? 0 }),
    });
  });

  handleMutation('game:uninstall', async (gameId: string, componentId?: string) => {
    const gamePath = requireGamePath(gameId);
    const receipts = await readReceipts(gamePath);
    const selected = componentId ? receipts.filter((r) => r.componentId === componentId) : receipts;
    const results = [];
    for (const receipt of selected) results.push(await uninstallReceipt(receipt));
    return results;
  });

  handleMutation('mods:toggle', async (gameId: string, modId: string, enabled: boolean) => {
    const gamePath = requireGamePath(gameId);
    const profile = detectGame(registry, gamePath);
    if (!profile) throw new Error('Game folder is gone.');
    await setModEnabled(registry, profile, String(modId), enabled === true);
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
    return listMods(registry, profile);
  });

  // The executable is resolved main-side from the detected profile: the
  // renderer cannot name an arbitrary binary to spawn.
  handle('game:launch', async (gameId: string) => {
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
    const gamePath = requireGamePath(gameId);
    const profile = detectGame(registry, gamePath, { deep: true });
    if (!profile) throw new Error('Game folder is gone.');
    const schemas = registry.configSchemas as Map<string, ConfigSchema>;
    const id = pickTranslator(schemas, profile, translatorId);
    // Renderer reads are always redacted.  Main-side planning below may read
    // the raw file so unchanged credentials are preserved, but those values
    // never cross the IPC boundary.
    const config = await readGameConfig(registry, schemas, profile, id);
    const schema = schemas.get(id);
    return {
      config,
      categories: (schema?.categories ?? []).map((category) => ({
        id: category.id,
        label: tRegistry(`configSchema.${id}.categories.${category.id}`, category.label),
      })),
      fontBundles: profile.installedFontBundles,
    };
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
  try {
    // Language before anything else: the registry load itself can throw a
    // translated error.
    if (app.isPackaged) loadCatalogs(path.join(app.getAppPath(), 'locales'));
    setLocale((await loadConfig()).locale);
    registry = loadRegistry(app.isPackaged ? path.join(app.getAppPath(), 'registry') : undefined);
  } catch (err) {
    dialog.showErrorBox('Registry not found', (err as Error).message);
    app.quit();
    return;
  }
  register();
  createWindow();
  configureAutoUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export type { GameProfile };

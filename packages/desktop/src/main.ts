import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
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
  listMods,
  loadConfig,
  loadLibrary,
  loadRegistry,
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
  type TranslatorPlan,
} from '@indiedeck/core';

const here = path.dirname(fileURLToPath(import.meta.url));

let registry: Registry;
let mainWindow: BrowserWindow | undefined;

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
      sandbox: false,
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
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // INDIEDECK_DEBUG=1 pipes renderer console output to the terminal, which is
  // the only way to see a renderer error when devtools are closed.
  if (process.env['INDIEDECK_DEBUG']) {
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message}  (${sourceId}:${line})`);
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
        games: document.querySelectorAll('#gameList .game').length,
        engines: document.querySelectorAll('#engineFilters button').length,
        status: document.getElementById('status')?.textContent ?? '',
        counts: document.getElementById('counts')?.textContent ?? '',
      })`,
    )) as { games: number; engines: number; status: string; counts: string };

    if (report.engines > 0 && !report.status.startsWith('Loading')) {
      console.log(`[smoke] rendered ${report.games} game rows, ${report.engines} engine filters - ${report.counts || report.status}`);
      // Exercise the detail panel too: that is where core does the real work.
      const detail = (await window.webContents.executeJavaScript(
        `(async () => {
          const first = document.querySelector('#gameList .game');
          if (!first) return { skipped: true };
          first.click();
          await new Promise((r) => setTimeout(r, 4000));
          return {
            title: document.querySelector('#detail h1')?.textContent ?? '',
            plans: document.querySelectorAll('#detail .plan').length,
            facts: document.querySelectorAll('#detail .facts dt').length,
          };
        })()`,
      )) as { skipped?: boolean; title?: string; plans?: number; facts?: number };

      if (detail.skipped) console.log('[smoke] no games indexed - detail panel not exercised');
      else console.log(`[smoke] detail for "${detail.title}": ${detail.facts} facts, ${detail.plans} translator plans`);

      // INDIEDECK_SCREENSHOT=<path> captures the live window, which is how the
      // README image is produced - no external capture tool involved.
      const shot = process.env['INDIEDECK_SCREENSHOT'];
      if (shot) {
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

  handle('config:get', () => loadConfig());
  handle('config:set', async (config: LauncherConfig) => {
    await saveConfig(config);
    return loadConfig();
  });
  handle('root:add', async (root: string) => addRoot(root));
  handle('root:remove', async (root: string) => removeRoot(root));

  handle('root:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Add a library root' });
    if (result.canceled || result.filePaths.length === 0) return undefined;
    await addRoot(result.filePaths[0]!);
    return result.filePaths[0];
  });

  handle('library:load', async () => {
    const index = await loadLibrary();
    return { index, stats: libraryStats(index), audits: auditLibrary(registry, index.games) };
  });

  handle('library:scan', async (options: { depth?: number; deep?: boolean }) => {
    const scanOptions: Parameters<typeof refreshLibrary>[1] = {
      onProgress: (current) => mainWindow?.webContents.send('scan:progress', current),
    };
    if (options?.depth !== undefined) scanOptions.depth = options.depth;
    if (options?.deep !== undefined) scanOptions.deep = options.deep;
    const index = await refreshLibrary(registry, scanOptions);
    return { index, stats: libraryStats(index), audits: auditLibrary(registry, index.games) };
  });

  handle('game:detail', async (gamePath: string, options: ResolveOptions) => {
    const profile = detectGame(registry, gamePath, { deep: true });
    if (!profile) throw new Error(`No known engine detected in ${gamePath}`);
    const plans = summarisePlans(resolvePlans(registry, profile, { ...options, includeNonViable: true }));
    return {
      profile,
      plans,
      audit: auditGame(registry, profile, { targetLanguage: options?.targetLanguage, endpoint: options?.endpoint }),
      receipts: await readReceipts(profile.path),
      mods: await listMods(registry, profile),
      hosts: modHosts(registry, profile).map((h) => ({ loaderId: h.loader.id, name: h.loader.name, dir: h.dir })),
    };
  });

  handle('game:install', async (plan: TranslatorPlan, options: { dryRun?: boolean }) =>
    applyPlan(plan, {
      dryRun: options?.dryRun ?? false,
      logger: {
        level: 'info',
        debug: () => {},
        info: (msg: string) => mainWindow?.webContents.send('install:progress', msg),
        warn: (msg: string) => mainWindow?.webContents.send('install:progress', msg),
        error: (msg: string) => mainWindow?.webContents.send('install:progress', msg),
        child: () => ({}) as never,
      },
      onProgress: (received, total) =>
        mainWindow?.webContents.send('install:bytes', { received, total: total ?? 0 }),
    }),
  );

  handle('game:uninstall', async (gamePath: string, componentId?: string) => {
    const receipts = await readReceipts(gamePath);
    const selected = componentId ? receipts.filter((r) => r.componentId === componentId) : receipts;
    const results = [];
    for (const receipt of selected) results.push(await uninstallReceipt(receipt));
    return results;
  });

  handle('mods:toggle', async (gamePath: string, modId: string, enabled: boolean) => {
    const profile = detectGame(registry, gamePath);
    if (!profile) throw new Error('Game folder is gone.');
    await setModEnabled(registry, profile, modId, enabled);
    return listMods(registry, profile);
  });

  handle('mods:add', async (gamePath: string) => {
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

  handle('game:launch', async (gamePath: string, executable: string) => {
    const target = path.join(gamePath, executable);
    const child = spawn(target, { cwd: gamePath, detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  });

  handle('shell:openPath', async (target: string) => shell.openPath(target));
  handle('shell:openExternal', async (url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) links can be opened.');
    await shell.openExternal(url);
    return true;
  });
}

void app.whenReady().then(() => {
  try {
    registry = loadRegistry();
  } catch (err) {
    dialog.showErrorBox('Registry not found', (err as Error).message);
    app.quit();
    return;
  }
  register();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export type { GameProfile };

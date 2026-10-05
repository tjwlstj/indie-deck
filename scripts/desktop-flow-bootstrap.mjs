import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import electron from 'electron';
import electronUpdater from 'electron-updater';

// Isolate Electron's single-instance/profile state as well as launcher data.
// A second smoke must neither focus a user's app nor silently exit as success.
const smokeProfile = path.join(process.env.INDIEDECK_HOME, 'electron-profile');
await fs.mkdir(smokeProfile, { recursive: true });
electron.app.setPath('userData', smokeProfile);

// Simulate an installed layout ONLY in this disposable test entry point. The
// actual updater instance emits its real event contract, but all three native
// actions below are replaced: no release request, installer or restart occurs.
const fakeResources = path.join(process.env.INDIEDECK_HOME, 'update-resources');
await fs.mkdir(fakeResources, { recursive: true });
await fs.writeFile(path.join(fakeResources, 'app-update.yml'), 'provider: github\nowner: tjwlstj\nrepo: indie-deck\n');
Object.defineProperty(electron.app, 'isPackaged', { value: true });
electron.app.getAppPath = () => path.resolve('.');
Object.defineProperty(process, 'resourcesPath', { value: fakeResources });
delete process.env.INDIEDECK_DISABLE_UPDATES;
const updater = electronUpdater.autoUpdater;
const currentVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const parts = currentVersion.split('.').map(Number);
const nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const updateCalls = globalThis.__indiedeckUpdateSmoke = { checks: 0, downloads: 0, installs: 0 };
updater.checkForUpdates = async () => {
  updateCalls.checks += 1;
  updater.emit('update-available', { version: nextVersion });
  return { isUpdateAvailable: true, updateInfo: { version: nextVersion } };
};
updater.downloadUpdate = async () => {
  updateCalls.downloads += 1;
  for (let percent = 0; percent <= 100; percent += 10) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    updater.emit('download-progress', { percent, transferred: percent * 1024, total: 102400, bytesPerSecond: 25600 });
  }
  updater.emit('update-downloaded', { version: nextVersion });
  return ['offline-fixture-never-executed.exe'];
};
updater.quitAndInstall = () => {
  updateCalls.installs += 1;
  if (updateCalls.installs === 1) {
    setTimeout(() => updater.emit('error', new Error('permission denied in offline install fixture')), 30);
  }
};

// This entry point replaces downloads only inside the disposable smoke app.
// Production main/core have no mock network or plan bypass.
const archive = await fs.readFile(process.env.INDIEDECK_SMOKE_ARCHIVE);
const fontArchive = await fs.readFile(process.env.INDIEDECK_SMOKE_FONT_ARCHIVE);
const version = process.env.INDIEDECK_SMOKE_VERSION;

// Intercept exactly the disposable, non-runnable PE fixture. No real MTool or
// game process is started, and production main has no mock-spawn bypass.
const originalSpawn = childProcess.spawn;
globalThis.__indiedeckMToolSmokeCalls = [];
childProcess.spawn = (executable, args, options) => {
  if (executable === process.env.INDIEDECK_SMOKE_MTOOL_EXE) {
    globalThis.__indiedeckMToolSmokeCalls.push({ executable, args: [...args], cwd: options.cwd, shell: options.shell });
    const child = new EventEmitter();
    child.unref = () => child;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }
  return originalSpawn(executable, args, options);
};
syncBuiltinESMExports();
// Only the game-archive picker is mocked. Every selected source stays within
// this runner's disposable fixture tree; production uses the actual OS picker.
const originalDialog = electron.dialog.showOpenDialog.bind(electron.dialog);
let archivePickCount = 0;
electron.dialog.showOpenDialog = async (...args) => {
  const options = args.at(-1);
  if (options?.filters?.some((filter) => filter.extensions?.includes('zip')) && process.env.INDIEDECK_SMOKE_GAME_ARCHIVE) {
    const picked = archivePickCount++ === 0 ? process.env.INDIEDECK_SMOKE_GAME_ARCHIVE : process.env.INDIEDECK_SMOKE_GAME_ARCHIVE_V2;
    return { canceled: false, filePaths: [picked] };
  }
  return originalDialog(...args);
};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith('https://api.github.com/repos/bbepis/XUnity.AutoTranslator/releases/')) {
    return new Response(JSON.stringify({ tag_name: `v${version}`, assets: [{
      name: `XUnity.AutoTranslator-BepInEx-${version}.zip`,
      browser_download_url: 'https://smoke.invalid/translator.zip', size: archive.length,
    }, {
      name: process.env.INDIEDECK_SMOKE_FONT_ASSET,
      browser_download_url: 'https://smoke.invalid/fonts.7z', size: fontArchive.length,
    }] }), { headers: { 'content-type': 'application/json' } });
  }
  if (url === 'https://smoke.invalid/fonts.7z') return new Response(fontArchive, { headers: { 'content-length': String(fontArchive.length) } });
  if (url === 'https://smoke.invalid/translator.zip') {
    let cursor = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const next = Math.min(cursor + 128 * 1024, archive.length);
        controller.enqueue(archive.subarray(cursor, next));
        cursor = next;
        if (cursor === archive.length) controller.close();
      },
    }), { headers: { 'content-length': String(archive.length) } });
  }
  throw new Error(`Unexpected network access in the offline desktop smoke: ${url}`);
};

await import('../packages/desktop/dist/main.js');

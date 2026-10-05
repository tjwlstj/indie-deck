import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const main = fs.readFileSync(new URL('../../desktop/src/main.ts', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../../desktop/preload.cjs', import.meta.url), 'utf8');
const cliCommands = fs.readFileSync(new URL('../../cli/src/commands.ts', import.meta.url), 'utf8');
const builder = fs.readFileSync(new URL('../../../electron-builder.yml', import.meta.url), 'utf8');
const launcherUpdates = fs.readFileSync(new URL('../../desktop/src/launcher-updates.ts', import.meta.url), 'utf8');

test('the desktop preload cannot request unredacted translator credentials', () => {
  assert.match(
    preload,
    /read: \(gameId, translatorId\) => call\('config:read', gameId, translatorId\)/,
  );

  const start = main.indexOf("handle('config:read'");
  const end = main.indexOf("handle('config:plan'", start);
  assert.ok(start >= 0 && end > start, 'config:read handler exists');
  assert.doesNotMatch(main.slice(start, end), /revealSecrets/);

  const planStart = main.indexOf("handle('config:plan'");
  const planEnd = main.indexOf("handleMutation('config:write'", planStart);
  assert.match(main.slice(planStart, planEnd), /return redactConfigPlan\(plan\)/);

  const writeStart = planEnd;
  const writeEnd = main.indexOf("handle('shell:openGameFolder'", writeStart);
  assert.match(main.slice(writeStart, writeEnd), /plan: redactConfigPlan\(plan\)/);
  assert.doesNotMatch(main.slice(writeStart, writeEnd), /return \{ plan, result:/);
});

test('the desktop window keeps the renderer inside the packaged document', () => {
  assert.match(main, /sandbox: true/);
  assert.match(main, /window\.webContents\.on\('will-navigate', \(event\) => event\.preventDefault\(\)\)/);
  assert.match(main, /if \(\/\^https:/);
  assert.doesNotMatch(main, /\^https\?:/);
});

test('the Windows notification identity matches the installer identity', () => {
  const appId = builder.match(/^appId:\s*(\S+)$/m)?.[1];
  assert.equal(appId, 'io.github.tjwlstj.indiedeck');
  assert.match(main, /const APP_ID = 'io\.github\.tjwlstj\.indiedeck'/);
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
});

test('CLI JSON config plans cannot expose executable patches or credentials', () => {
  const configCommand = cliCommands.slice(cliCommands.indexOf('export async function cmdConfig'));
  assert.match(configCommand, /const publicPlan = redactConfigPlan\(plan\)/);
  assert.match(configCommand, /JSON\.stringify\(\{ plan: publicPlan, written: false \}/);
  assert.match(configCommand, /out\(ctx, \{ plan: publicPlan, result \}/);
  assert.doesNotMatch(configCommand, /JSON\.stringify\(\{ plan, written: false \}/);
  assert.doesNotMatch(configCommand, /out\(ctx, \{ plan, result \}/);
});

test('normal quit cannot interrupt a queued filesystem mutation', () => {
  assert.match(main, /let pendingMutations = 0/);
  assert.match(main, /function handleMutation/);
  assert.match(main, /window\.on\('close', \(event\) => \{/);
  assert.match(main, /if \(pendingMutations === 0 && !operations\.isActive\(\)\) return;\s+event\.preventDefault\(\)/);

  for (const channel of [
    'config:set',
    'root:remove',
    'root:pick',
    'library:scan',
    'game:refresh',
    'mods:toggle',
    'mods:add',
    'config:write',
  ]) {
    assert.match(main, new RegExp(`handleMutation\\('${channel.replace(':', '\\:')}'`));
  }
  assert.match(main, /enqueue: \(work\) => \{ void enqueueMutation\(work\); \}/);
  assert.match(main, /function enqueueMutation[\s\S]*pendingMutations \+= 1/);
  assert.match(main, /operations\.start\(request,/);
});

test('launcher update IPC accepts no renderer-provided feed, executable or installer arguments', () => {
  const bridgeStart = preload.indexOf('  updates: {');
  const bridgeEnd = preload.indexOf('  registry:', bridgeStart);
  assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart, 'the fixed update bridge exists');
  const bridge = preload.slice(bridgeStart, bridgeEnd);
  for (const method of ['current', 'check', 'download', 'install', 'openRelease']) {
    assert.match(bridge, new RegExp(`${method}: \\(\\) => call\\('updates:${method}'\\)`));
  }
  assert.match(bridge, /onStatus: \(fn\) => subscribe\('updates:status', fn\)/);
  assert.doesNotMatch(bridge, /\.\.\.args|feed|path|executable|url|ipcRenderer/);

  const handlers = main.slice(main.indexOf("handle('updates:current'"), main.indexOf("handle('registry:get'"));
  for (const method of ['check', 'download', 'install']) {
    assert.match(handlers, new RegExp(`handle\\('updates:${method}', \\(\\) => launcherUpdates\\.${method}\\(\\)\\)`));
  }
  assert.match(handlers, /handle\('updates:openRelease', async \(\) => \{ await shell\.openExternal\(LAUNCHER_RELEASE_URL\)/);
  assert.match(launcherUpdates, /LAUNCHER_RELEASE_URL = 'https:\/\/github\.com\/tjwlstj\/indie-deck\/releases\/latest'/);
  assert.doesNotMatch(main + launcherUpdates, /setFeedURL\(|checkForUpdatesAndNotify\(/);
});

test('restart reservation blocks every non-snapshot IPC and rejects queue entry before counting work', () => {
  const wrapper = main.slice(main.indexOf('function handle<T>'), main.indexOf('function localiseTaskError'));
  assert.match(wrapper, /if \(updateRestartReserved && channel !== 'updates:current' && channel !== 'app:info'\) \{\s+throw new Error\('ui\.update\.error\.busy'\)/);
  assert.ok(wrapper.indexOf('if (updateRestartReserved') < wrapper.indexOf('await fn('), 'all privileged handlers pass the reservation gate first');

  const queue = main.slice(main.indexOf('function enqueueMutation<T>'), main.indexOf('const operations ='));
  assert.match(queue, /if \(updateRestartReserved\) throw new Error\('ui\.update\.error\.busy'\)/);
  assert.ok(queue.indexOf('if (updateRestartReserved)') < queue.indexOf('pendingMutations += 1'), 'queued mutations cannot reserve work after update shutdown has been reserved');
  assert.ok(queue.indexOf('if (updateRestartReserved)') < queue.indexOf('mutationQueue.then(work)'), 'the queue also has a non-IPC defense');
});

test('normal quit and OS shutdown state remain part of the update restart safety gate', () => {
  assert.match(main, /app\.on\('before-quit', \(event\) => \{\s+if \(pendingMutations > 0 \|\| operations\.isActive\(\)\) event\.preventDefault\(\)/);
  assert.match(main, /window\.on\('query-session-end', \(\) => \{ sessionEnding = true; \}\)/);
  assert.match(main, /window\.on\('session-end', \(\) => \{ sessionEnding = true; \}\)/);
  const configuredStart = main.indexOf('function configureAutoUpdates()');
  const configuredEnd = main.indexOf('function pickTranslator(', configuredStart);
  assert.ok(configuredStart >= 0 && configuredEnd > configuredStart, 'the main-owned updater integration exists');
  const configured = main.slice(configuredStart, configuredEnd);
  assert.match(configured, /isBusy: \(\) => pendingMutations > 0 \|\| operations\.isActive\(\)/);
  assert.match(configured, /isShutdownSafe: \(\) => !sessionEnding/);
  assert.match(configured, /reserveInstall: \(\) => \{\s+if \(updateRestartReserved \|\| sessionEnding \|\| pendingMutations > 0 \|\| operations\.isActive\(\)\) return false;\s+updateRestartReserved = true;\s+return true;/);
  assert.match(configured, /releaseInstallReservation: \(\) => \{ updateRestartReserved = false; \}/);
  const install = launcherUpdates.slice(launcherUpdates.indexOf('  const install ='), launcherUpdates.indexOf('  const dispose ='));
  assert.ok(install.indexOf('reserved = reserve!()') < install.indexOf("transition('installing')"), 'the root gate is reserved before UI observers can enqueue work');
  assert.match(install, /transition\('installing'\);\s+if \(options\.isBusy\(\) \|\| options\.isShutdownSafe\?\.\(\) === false\) fail\('busy'\);\s+updater\.quitAndInstall\(false, true\)/);
});

test('startup only checks for updates and download or install require explicit controller actions', () => {
  for (const flag of ['autoDownload', 'autoInstallOnAppQuit', 'allowPrerelease', 'allowDowngrade']) {
    assert.match(launcherUpdates, new RegExp(`updater\\.${flag} = false`));
  }
  assert.match(launcherUpdates, /updater\.autoRunAppAfterInstall = true/);
  assert.match(main, /if \(mode === 'installed'\) \{\s+const timer = setTimeout\(\(\) => \{[\s\S]*?if \(launcherUpdates\.snapshot\(\)\.status !== 'idle'\) return;\s+void launcherUpdates\.check\(\)\.catch/);
  assert.doesNotMatch(main, /autoDownload\s*=\s*true|autoInstallOnAppQuit\s*=\s*true|autoUpdater\.downloadUpdate\(|autoUpdater\.quitAndInstall\(/);
  const check = launcherUpdates.slice(launcherUpdates.indexOf('  const check ='), launcherUpdates.indexOf('  const download ='));
  assert.match(check, /updater\.checkForUpdates\(\)/);
  assert.doesNotMatch(check, /downloadUpdate\(|quitAndInstall\(/);
  const download = launcherUpdates.slice(launcherUpdates.indexOf('  const download ='), launcherUpdates.indexOf('  const install ='));
  assert.match(download, /const target = version\(state\.availableVersion\)/);
  assert.match(download, /if \(!target \|\| !newer\(target, current!\)\) return Promise\.reject/);
  assert.match(download, /updater\.downloadUpdate\(\)/);
  assert.doesNotMatch(download, /quitAndInstall\(/);
  assert.equal([...launcherUpdates.matchAll(/updater\.downloadUpdate\(/g)].length, 1, 'the sole native download call belongs to the explicit download action');
  assert.equal([...launcherUpdates.matchAll(/updater\.quitAndInstall\(/g)].length, 1, 'the sole native install call belongs to the reserved explicit install action');
});

test('packaging verifies presence and current hashes of the launcher update runtime and UI', () => {
  const checker = fs.readFileSync(new URL('../../../scripts/check-package.mjs', import.meta.url), 'utf8');
  for (const relative of ['dist/launcher-updates.js', 'renderer/update-model.js', 'renderer/panels/updates.js']) {
    const packaged = `packages/desktop/${relative}`;
    assert.ok(checker.includes(`'\\\\${packaged.replaceAll('/', '\\\\')}'`), `${relative} is a required packaged entry`);
    assert.ok(checker.includes(`['${packaged}', '${packaged}']`), `${relative} must match the current built file by hash`);
  }
});

test('maintenance keeps opaque targets, rejects concurrent writes and revalidates plans before applying', () => {
  assert.match(preload, /start: \(request\) => call\('maintenance:start', request\)/);
  assert.doesNotMatch(preload, /game:install|game:uninstall|install:bytes|install:progress/);
  assert.match(main, /requirePlan\(request\.gameId, request\.planId\)/);
  assert.match(main, /planFingerprint\(candidate\) === planFingerprint\(plan\)/);
  assert.match(main, /if \(operations\.isActive\(\)\) throw/);
  assert.match(main, /if \(pendingMutations > 0\) throw/);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /r\.storageId !== `\$\{r\.kind\}-\$\{r\.componentId\}\.json`/);
  const removalStart = main.indexOf('const receipts = await readSafeRemovalReceipts(');
  const removalEnd = main.indexOf('} catch (err)', removalStart);
  assert.ok(removalStart >= 0 && removalEnd > removalStart, 'desktop removal uses the strict one-read receipt guard');
  assert.match(main.slice(removalStart, removalEnd), /profile\.executable \? \[profile\.executable\] : \[\]/);
  assert.doesNotMatch(main.slice(removalStart, removalEnd), /readReceipts\(|readReceiptEvidence\(/);
  assert.match(main.slice(removalStart, removalEnd), /uninstallReceipt\(receipts\[index\]!/);
});

test('standalone font requests cannot execute a normal translator plan or change its payload', () => {
  assert.match(main, /\(request\.kind === 'install-font'\) !== \(plan\.purpose === 'font'\)/);
  assert.match(main, /resolveFontPlan\(registry, profile, installedFontOptions\(options, fontConfig\)\)/);
  assert.match(main, /planFingerprint\(fresh\) !== planFingerprint\(plan\)/);
  assert.match(main, /fontWriteBlockKey\(profile, fresh, receiptsEvidence, installations, fontConfig\)/);
  assert.match(main, /receipts\.sort\(\(a, b\) => Number\(b\.kind === 'font'\) - Number\(a\.kind === 'font'\)\)/);
});

test('MTool handoff keeps paths and arguments in main and out of renderer authority', () => {
  assert.match(preload, /launch: \(gameId\) => call\('mtool:launch', gameId\)/);
  assert.match(preload, /pick: \(\) => call\('mtool:pick'\)/);
  assert.match(preload, /open: \(\) => call\('mtool:open'\)/);
  const open = main.slice(main.indexOf('async function openMTool'), main.indexOf('function requireDetectedGame'));
  assert.match(open, /mtoolLaunchSpec\(status, profile\)/);
  assert.match(open, /spawn\(spec\.executable, spec\.args/);
  assert.match(open, /cwd: spec\.cwd, shell: false/);
  assert.match(open, /isMToolGame\(profile\)/);
  assert.match(open, /pendingMutations > 0 \|\| operations\.isActive\(\)/);
  assert.match(open, /enqueueMutation\(\(\) => openMTool/);
  assert.match(open, /autoApply: false/);
  assert.doesNotMatch(open, /applyPlan|writeReceipt|exec\(|\.bat/);

  const handlers = main.slice(main.indexOf("handle('mtool:status'"), main.indexOf("handleMutation('config:set'"));
  assert.match(handlers, /dialog\.showOpenDialog\(\{\s+properties: \['openDirectory'\]/);
  assert.match(handlers, /getMToolStatus\(picked\.filePaths\[0\]/);
  assert.match(handlers, /mtoolRoot: null/);
  assert.match(handlers, /requireGamePath\(gameId\)/);
  assert.match(handlers, /getMToolGameExecutable\(requireMToolGame\(gameId\)\)/);
  const configSet = main.slice(main.indexOf("handleMutation('config:set'"), main.indexOf("handleMutation('root:remove'"));
  assert.match(configSet, /\.\.\.current/);
  assert.doesNotMatch(configSet, /config\??\.externalTools|config\??\.roots/);
});

test('Unity cleanup uses opaque cached previews and never promotes ordinary install to repair', () => {
  assert.match(main, /translatorMaintenanceById = new Map/);
  assert.match(main, /entry\.path !== requireGamePath\(gameId\)/);
  assert.match(main, /requireTranslatorMaintenance\(request\.gameId, request\.planId\)/);
  assert.match(main, /previewTranslatorMaintenance\(registry, profile, options\)/);
  assert.match(main, /runTranslatorMaintenance\(translatorMaintenance/);
  assert.match(main, /input\.kind === 'remove-translator' \|\| input\.kind === 'reinstall-translator'/);
  const publicPreview = main.slice(main.indexOf('function cacheTranslatorMaintenance'), main.indexOf('function requireTranslatorMaintenance'));
  assert.doesNotMatch(publicPreview, /\.\.\.preview|context:|plan: preview/);
  assert.match(main, /request\.kind === 'install' \? installBlockReason/);
});

test('game archive import can select paths only through the OS picker and cannot name destinations', () => {
  assert.match(preload, /import: \(candidateId, label\) => call\('archives:import', candidateId, label\)/);
  assert.match(preload, /pick: \(\) => call\('archives:pick'\)/);
  assert.match(main, /archiveCandidates\.set\(id, \{ path: source, inspection \}\)/);
  assert.match(main, /importGameArchive\(candidate\.path/);
  assert.match(main, /dataDir: defaultDataDir\(\), registry/);
  assert.match(main, /expectedSha256: candidate\.inspection\.sha256/);
  assert.match(main, /handle\('archives:current', \(\) => structuredClone\(archiveTask\)\)/);
  assert.match(main, /sequence: \+\+archiveSequence/);
  const importStart = main.slice(main.indexOf('function importSelectedArchive'), main.indexOf('/** Serialises every filesystem mutation'));
  assert.match(importStart, /pendingMutations > 0 \|\| operations\.isActive\(\)/);
  assert.match(importStart, /return enqueueMutation/);
  assert.doesNotMatch(importStart, /label\s*:\s*path|destination:\s*label|candidateId\s*:\s*path/);
});

test('desktop smoke isolates its Electron profile and requires actual scenario completion, not only exit zero', () => {
  const runner = fs.readFileSync(new URL('../../../scripts/check-desktop-flow.mjs', import.meta.url), 'utf8');
  const bootstrap = fs.readFileSync(new URL('../../../scripts/desktop-flow-bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(bootstrap, /app\.setPath\('userData', smokeProfile\)/);
  assert.match(bootstrap, /path\.join\(process\.env\.INDIEDECK_HOME, 'electron-profile'\)/);
  assert.match(runner, /requiredSmokeMarkers\.some\(\(marker\) => !smokeOutput\.includes\(marker\)\)/);
  assert.match(runner, /Desktop exited without completing every required smoke flow/);
});

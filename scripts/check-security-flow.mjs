import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { loadRegistry, refreshLibrary, saveConfig } from '../packages/core/dist/index.js';

// This flow deliberately uses the main process's explicit mock scanner. Its
// launch-denial assertions never execute the fake game or a native antivirus.
const locale = process.argv[2] ?? 'ko';
const packaged = process.argv.includes('--packaged');
assert.ok(['ko', 'en'].includes(locale), 'Choose ko or en for the security flow.');
assert.ok(process.argv.slice(3).every((arg) => arg === '--packaged'), 'Only the fixed --packaged option is supported.');
const workspace = path.resolve('.'), parent = path.join(workspace, 'out');
if (process.platform === 'win32' && process.env.GITHUB_ACTIONS !== 'true') {
  assert.equal(path.parse(parent).root.toLowerCase(), 'c:\\', 'Local fixtures must stay in the C drive workspace.');
}
await fs.mkdir(parent, { recursive: true });
const temporary = await fs.mkdtemp(path.join(parent, 'security-flow-'));
const dataDir = path.join(temporary, 'data'), gamesRoot = path.join(temporary, 'games');
const game = path.join(gamesRoot, 'Security Test Game');
const suffix = packaged ? '-packaged' : '';
const screenshot = path.join(parent, `desktop-security-${locale}${suffix}.png`);
const log = path.join(parent, `desktop-security-${locale}${suffix}.log`);
const executable = packaged ? path.join(workspace, 'release', 'win-unpacked', 'IndieDeck.exe') : createRequire(import.meta.url)('electron');

function fakeExe() {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}
async function snapshot(directory, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await snapshot(directory, name));
    else {
      assert.equal(entry.isFile(), true, 'Fixture snapshots accept regular files only.');
      files.push([name, crypto.createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')]);
    }
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}

try {
  const files = {
    'Game.exe': fakeExe(), 'UnityPlayer.dll': 'offline harmless Unity marker',
    'Game_Data/globalgamemanagers': '2019.4.0f1',
    'Game_Data/Managed/Assembly-CSharp.dll': 'offline harmless managed assembly marker',
    'BepInEx/core/BepInEx.dll': Buffer.from('ProductVersion5.4.23.5\0', 'utf16le'),
    'BepInEx/plugins/SecurityProbe.dll.disabled': 'disabled harmless security fixture',
    'user-notes.txt': 'Security review must not alter these fixture bytes.',
  };
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(game, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
  await saveConfig({ roots: [gamesRoot], locale, defaults: { targetLanguage: 'ko', sourceLanguage: 'ja', endpoint: 'GoogleTranslate' },
    scanDepth: 2, externalTools: { mtoolRoot: null } }, dataDir);
  const registry = loadRegistry(), library = await refreshLibrary(registry, { dataDir });
  assert.equal(library.games.length, 1, 'The isolated fixture must be the only indexed game.');
  assert.equal(library.games[0].engineId, 'unity');
  assert.equal(library.games[0].installedTranslators.length, 0);
  const before = await snapshot(game);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('INDIEDECK_')) delete env[key];
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS']) delete env[key];
  Object.assign(env, {
    INDIEDECK_HOME: dataDir, INDIEDECK_SMOKE: '1', INDIEDECK_SMOKE_SECURITY: '1',
    INDIEDECK_DISABLE_UPDATES: '1', INDIEDECK_REGISTRY: path.join(workspace, 'registry'),
    INDIEDECK_SECURITY_SCREENSHOT: screenshot,
  });
  const child = spawn(executable, packaged ? [] : [path.join(workspace, 'packages', 'desktop')], {
    cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-64 * 1024); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32 * 1024); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally { clearTimeout(timer); }
  await fs.writeFile(log, `${stdout}\n${stderr}`);
  assert.equal(timedOut, false, `Security flow exceeded 60 seconds. See ${log}`);
  assert.equal(code, 0, `Security flow exited unsuccessfully.\n${stdout}\n${stderr}`);
  assert.doesNotMatch(stdout + stderr, /\[renderer:error\]/i, 'Renderer errors invalidate the flow.');
  assert.ok(stdout.includes('[smoke] mocked security gates'), 'The app exited without completing the security gates.');
  assert.ok((await fs.stat(screenshot)).size > 0, 'The security screenshot was not written.');
  assert.deepEqual(await snapshot(game), before, 'Security checks changed the fixture game files.');
  console.log(`[security-flow] ${locale}${packaged ? ' packaged ASAR' : ' source'} passed: mocked attention/incomplete launch gates, reload/cancel, foreign IPC rejection and mocked signature update; unchanged game files, no native scan/update/game/browser process; screenshot: ${screenshot}`);
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), parent, 'Refusing cleanup outside the fixture parent.');
  assert.ok(path.basename(temporary).startsWith('security-flow-'), 'Refusing cleanup of a non-fixture directory.');
  await fs.rm(temporary, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Isolated empty-library smoke boots. No game, scanner, browser or personal
// launcher profile is used, and no 8dot3 filesystem setting is changed.
if (process.platform !== 'win32') {
  console.log('[portable-startup] skipped: Windows portable executable only');
  process.exit(0);
}
const project = process.cwd();
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const executable = path.resolve('release', 'IndieDeck-Portable-' + version + '-x64.exe');
assert.ok((await fs.stat(executable)).isFile(), 'Current-version portable executable is missing.');
let fixtureParent = path.resolve(os.tmpdir());
if (path.parse(fixtureParent).root.toLowerCase() !== 'c:\\') fixtureParent = path.join(os.homedir(), 'AppData', 'Local', 'Temp');
assert.equal(path.parse(fixtureParent).root.toLowerCase(), 'c:\\', 'Portable fixture data must stay on C drive.');
await fs.mkdir(fixtureParent, { recursive: true });
const temporary = await fs.mkdtemp(path.join(fixtureParent, 'indiedeck-portable-startup-'));
const evidence = path.resolve('out', 'portable-startup-' + version + '-' + crypto.randomUUID());
await fs.mkdir(evidence, { recursive: true });
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const nativeCode = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class IndieDeckPortableNativePath {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern uint GetShortPathName(string path, StringBuilder buffer, uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern uint GetLongPathName(string path, StringBuilder buffer, uint size);
}
'@
$taskPath = $env:INDIEDECK_PORTABLE_PATH_PROBE
$shortBuffer = [Text.StringBuilder]::new(32768)
$longBuffer = [Text.StringBuilder]::new(32768)
$shortCount = [IndieDeckPortableNativePath]::GetShortPathName($taskPath, $shortBuffer, [uint32]$shortBuffer.Capacity)
$longCount = [IndieDeckPortableNativePath]::GetLongPathName($taskPath, $longBuffer, [uint32]$longBuffer.Capacity)
if ($shortCount -eq 0 -or $longCount -eq 0) { throw 'Native path query failed.' }
[Console]::WriteLine((@{ shortPath = $shortBuffer.ToString(); longPath = $longBuffer.ToString() } | ConvertTo-Json -Compress))
`;
function nativePaths(directory) {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(nativeCode, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 65536,
    env: { ...process.env, INDIEDECK_PORTABLE_PATH_PROBE: directory },
  });
  if (result.status !== 0) throw new Error('Native short/long path query failed.');
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  for (const key of ['shortPath', 'longPath']) {
    assert.equal(typeof parsed[key], 'string');
    assert.equal(path.parse(parsed[key]).root.toLowerCase(), 'c:\\');
  }
  return parsed;
}
async function run(label, tempDir) {
  const home = path.join(temporary, label + '-launcher-home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({
    roots: [], locale: 'en', defaults: { targetLanguage: 'ko', sourceLanguage: 'ja', endpoint: 'GoogleTranslate' },
    scanDepth: 6, externalTools: { mtoolRoot: null },
  }));
  const screenshot = path.join(evidence, label + '.png'), chromiumLog = path.join(evidence, label + '-chromium.log');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('INDIEDECK_')) delete env[key];
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE']) delete env[key];
  Object.assign(env, { TEMP: tempDir, TMP: tempDir, INDIEDECK_HOME: home, INDIEDECK_SMOKE: '1',
    INDIEDECK_DISABLE_UPDATES: '1', INDIEDECK_SCREENSHOT: screenshot });
  const args = label === 'normal' ? ['--fullscreen'] : ['--enable-logging=file', '--log-file=' + chromiumLog];
  const child = spawn(executable, args, {
    cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
  const start = Date.now();
  const timer = setTimeout(() => {
    timedOut = true;
    // The PID belongs to the child just created above; only its process tree is
    // terminated. This never searches for or stops other launcher instances.
    if (child.pid && child.exitCode === null) {
      spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    }
  }, 90000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  await fs.writeFile(path.join(evidence, label + '-stdout.log'), stdout);
  await fs.writeFile(path.join(evidence, label + '-stderr.log'), stderr);
  const png = await fs.readFile(screenshot).catch(() => Buffer.alloc(0));
  const result = { label, code, timedOut, fullscreenRequested: label === 'normal', elapsedMs: Date.now() - start, tempDir, screenshot, screenshotBytes: png.length, chromiumLog };
  await fs.writeFile(path.join(evidence, label + '-result.json'), JSON.stringify(result, null, 2));
  if (code !== 0 || timedOut || png.length < 8 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    const lastChrome = await fs.readFile(chromiumLog, 'utf8').then(text => text.slice(-12000), () => '(Chromium file log unavailable)');
    console.error(stdout.slice(-3000), stderr.slice(-3000), lastChrome);
    throw new Error('Portable ' + label + ' boot failed; inspect ' + evidence);
  }
  console.log('[portable-startup] ' + label + ' PASS: ' + screenshot);
  return result;
}
const summary = { version, executable, evidence, results: [] };
try {
  const normal = path.join(temporary, 'normal temporary directory'), alias = path.join(temporary, 'short alias temporary directory');
  await fs.mkdir(normal); await fs.mkdir(alias);
  const normalPaths = nativePaths(normal), aliasPaths = nativePaths(alias);
  summary.results.push(await run('normal', normalPaths.longPath));
  const hasNativeAlias = aliasPaths.shortPath.toLowerCase() !== aliasPaths.longPath.toLowerCase();
  if (hasNativeAlias) {
    assert.match(aliasPaths.shortPath, /~/, 'Expected a native DOS short alias.');
    summary.results.push(await run('short-path', aliasPaths.shortPath));
  } else {
    summary.shortPathSkipped = 'GetShortPathName returned the long path; no native short alias is available on this host.';
    console.log('[portable-startup] short-path SKIP: ' + summary.shortPathSkipped);
  }
  await fs.writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[portable-startup] completed ' + version + '; ' + evidence);
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), fixtureParent);
  assert.ok(path.basename(temporary).startsWith('indiedeck-portable-startup-'));
  assert.equal(path.parse(temporary).root.toLowerCase(), 'c:\\');
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

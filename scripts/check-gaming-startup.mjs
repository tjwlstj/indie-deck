import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LOG_LIMIT = 64 * 1024;
const FIXTURE_PREFIX = 'indiedeck-gaming-startup-';

// This probe must never open an application on the developer's gaming PC.
export function requireHostedRunner(environment, platform, arch) {
  assert.equal(platform, 'win32', 'Packaged startup probe requires hosted Windows.');
  assert.equal(arch, 'x64');
  for (const key of ['GITHUB_ACTIONS', 'CI']) assert.equal(environment[key], 'true', 'Hosted CI is required.');
  assert.equal(environment.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(environment.GITHUB_REPOSITORY, 'tjwlstj/indie-deck');
  assert.equal(environment.INDIEDECK_GAMING_STARTUP_CI, '1');
  assert.equal(typeof environment.RUNNER_TEMP, 'string');
  assert.ok(path.win32.isAbsolute(environment.RUNNER_TEMP), 'RUNNER_TEMP must be absolute.');
  assert.notEqual(environment.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS verification must remain enabled.');
}

export function sanitizedLog(value) {
  return String(value).slice(-LOG_LIMIT)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)\b/gi, '[redacted credential]')
    .replace(/\b(token|password|secret|authorization|api[_-]?key)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[redacted]');
}

export function startupEnvironment(environment, fixture, screenshot) {
  // Windows runtime essentials only. CI tokens, signing credentials, Node and
  // Electron flags, mirrors and prior IndieDeck test controls are not inherited.
  const clean = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/^(path|pathext|systemroot|windir|comspec|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?|commonprogramw6432|systemdrive|number_of_processors|processor_architecture|processor_identifier)$/i.test(key)) clean[key] = value;
  }
  return { ...clean, TEMP: path.join(fixture, 'temp'), TMP: path.join(fixture, 'temp'),
    USERPROFILE: path.join(fixture, 'profile'), APPDATA: path.join(fixture, 'roaming'),
    LOCALAPPDATA: path.join(fixture, 'local'), INDIEDECK_HOME: path.join(fixture, 'home'),
    INDIEDECK_SMOKE: '1', INDIEDECK_DISABLE_UPDATES: '1', INDIEDECK_SCREENSHOT: screenshot };
}

async function main() {
  requireHostedRunner(process.env, process.platform, process.arch);
  assert.equal(process.argv.length, 2, 'Packaged startup probe does not accept executable arguments.');
  const executable = path.resolve('release', 'win-unpacked', 'IndieDeck.exe');
  assert.ok((await fs.lstat(executable)).isFile(), 'Fixed packaged executable is missing.');
  const parent = await fs.realpath(process.env.RUNNER_TEMP);
  const fixture = await fs.mkdtemp(path.join(parent, FIXTURE_PREFIX));
  const evidence = path.resolve('out', 'gaming-packaged-startup');
  const screenshot = path.join(evidence, 'gaming-fullscreen.png');
  let stdout = '', stderr = '';
  try {
    await fs.mkdir(evidence, { recursive: true });
    await assert.rejects(fs.lstat(screenshot), { code: 'ENOENT' }, 'Refusing stale screenshot evidence.');
    const environment = startupEnvironment(process.env, fixture, screenshot);
    for (const key of ['TEMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'INDIEDECK_HOME']) await fs.mkdir(environment[key], { recursive: true });
    await fs.writeFile(path.join(environment.INDIEDECK_HOME, 'config.json'), JSON.stringify({
      roots: [], locale: 'en', defaults: { targetLanguage: 'ko', sourceLanguage: 'ja', endpoint: 'GoogleTranslate' },
      scanDepth: 6, externalTools: { mtoolRoot: null },
    }), { flag: 'wx' });
    const started = Date.now();
    const child = spawn(executable, ['--fullscreen', '--updated'], {
      cwd: path.dirname(executable), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-LOG_LIMIT); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-LOG_LIMIT); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Only this probe's own child tree can be terminated. No process search.
      if (Number.isSafeInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null) {
        spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, timeout: 10000, stdio: 'ignore',
        });
      }
    }, 90000);
    let outcome;
    try {
      outcome = await new Promise(resolve => {
        child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(timer); }
    stdout = sanitizedLog(stdout); stderr = sanitizedLog(stderr);
    await fs.writeFile(path.join(evidence, 'stdout.log'), stdout);
    await fs.writeFile(path.join(evidence, 'stderr.log'), stderr);
    const png = await fs.readFile(screenshot).catch(() => Buffer.alloc(0));
    const validPng = png.length >= 24 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      && png.subarray(12, 16).toString('ascii') === 'IHDR' && png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0;
    const marker = stdout.match(/^\[smoke\] startup verified (\{[^\r\n]+\})$/m);
    const startup = marker ? JSON.parse(marker[1]) : null;
    const passed = outcome.code === 0 && !timedOut && validPng && startup?.fullscreenRequested === true
      && startup.nativeFullscreen === true && startup.rendererGamingMode === true
      && stdout.includes('[smoke] bundled browser companion exported and version verified');
    const result = { passed, ...outcome, timedOut, elapsedMs: Date.now() - started,
      args: ['--fullscreen', '--updated'], screenshotBytes: png.length, validPng, startup };
    if (result.error) result.error = sanitizedLog(result.error);
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    if (!passed) {
      console.error('[gaming-startup] stdout:\n' + stdout.slice(-16000));
      console.error('[gaming-startup] stderr:\n' + stderr.slice(-16000));
      throw new Error('Packaged fullscreen startup failed; inspect out/gaming-packaged-startup/result.json.');
    }
    console.log('[gaming-startup] PASS: native fullscreen, renderer, bundled extension and PNG verified.');
  } finally {
    const resolved = path.resolve(fixture);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase(), 'Cleanup target must stay in RUNNER_TEMP.');
    assert.ok(path.basename(resolved).startsWith(FIXTURE_PREFIX));
    assert.equal((await fs.realpath(resolved)).toLowerCase(), resolved.toLowerCase(), 'Cleanup target cannot be a link.');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error('[gaming-startup] ' + sanitizedLog(error.message)); process.exitCode = 1; });
}

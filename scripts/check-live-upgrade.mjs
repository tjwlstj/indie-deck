import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

// This is a manual, disposable-hosted-runner diagnostic. It intentionally
// never calls updates.install(), launches a game or changes the update feed.
const EXPECTED_INSTALLER_SHA256 = '93d0725b28b7c787ef2bd630c99b25a7c6a85e173d34dbd22e0c66895d61ad99';
const EXPECTED_INSTALLER_SIZE = 105037331;
const EXPECTED_TARGET_SHA256 = '144dcdb21a1d80cd380bcbdaddad271248ee1a1b389f27c9f586d607223775e1';
const EXPECTED_TARGET_SIZE = 105047412;
const EXPECTED_LATEST_SHA256 = '69880ebdea57041aa0c445c0003e166b35539264e486456b699c5bf0ae09b093';
const OLD_VERSION = '0.1.11', TARGET_VERSION = '0.1.14';
const OLD_ASSET = `https://github.com/tjwlstj/indie-deck/releases/download/v${OLD_VERSION}/IndieDeck-Setup-${OLD_VERSION}-x64.exe`;
const API_LATEST = 'https://api.github.com/repos/tjwlstj/indie-deck/releases/latest';
const MAX_TIME = 180000;
let phase = 'runner-guard', fixture, ownedChild, socket;
const fail = (reason) => { throw new Error(reason); };

function requireRunner() {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
      !['workflow_dispatch', 'pull_request'].includes(process.env.GITHUB_EVENT_NAME) || process.env.CI !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.GITHUB_REPOSITORY !== 'tjwlstj/indie-deck' ||
      process.env.INDIEDECK_LIVE_REPRO_CI !== '1' || !process.env.RUNNER_TEMP ||
      !path.isAbsolute(process.env.RUNNER_TEMP) || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('runner-guard');
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    if (process.env.GITHUB_HEAD_REF !== 'codex/update-error-classification' || process.env.GITHUB_BASE_REF !== 'main' ||
        !process.env.GITHUB_EVENT_PATH || fs.statSync(process.env.GITHUB_EVENT_PATH).size > 4 * 1024 * 1024) fail('runner-guard');
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (event.pull_request?.head?.repo?.full_name !== 'tjwlstj/indie-deck' ||
        event.pull_request?.base?.repo?.full_name !== 'tjwlstj/indie-deck') fail('runner-guard');
  }
}

export async function response(url, accept = 'application/octet-stream', timeout = 30000) {
  const result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': 'IndieDeck-upgrade-check', Accept: accept } });
  return result;
}

/** The diagnostic token is used only for this literal API URL. Manual redirect
 * handling prevents forwarding it to a different origin or a signed CDN URL. */
export async function latestResponse() {
  const token = process.env.INDIEDECK_GITHUB_API_TOKEN;
  if (typeof token !== 'string' || token.length < 1 || token.length > 4096 || /[\u0000-\u0020\u007f]/.test(token)) fail('api-token-unavailable');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let result;
    try {
      result = await fetch(API_LATEST, { redirect: 'manual', signal: AbortSignal.timeout(30000),
        headers: { 'User-Agent': 'IndieDeck-upgrade-check', Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` } });
    } catch {
      if (attempt === 2) fail('latest-metadata-transport');
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    if (result.status === 200) return result;
    console.error(`[live-upgrade] latest HTTP status=${result.status}`);
    void result.body?.cancel().catch(() => {});
    if (attempt === 2 || ![403, 429, 500, 502, 503, 504].includes(result.status)) fail('latest-metadata-unavailable');
    const retryAfter = result.headers.get('retry-after');
    const seconds = /^\d{1,3}$/.test(retryAfter ?? '') ? Math.min(5, Math.max(1, Number(retryAfter))) : attempt + 1;
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }
  fail('latest-metadata-unavailable');
}

async function getLatest() {
  const result = await latestResponse();
  const length = Number(result.headers.get('content-length') || 0);
  if (length > 2 * 1024 * 1024) fail('latest-metadata-invalid');
  if (!result.body) fail('latest-metadata-invalid');
  const reader = result.body.getReader(); let total = 0; const chunks = [];
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength; if (total > 2 * 1024 * 1024) fail('latest-metadata-invalid');
      chunks.push(Buffer.from(item.value));
    }
  } finally { reader.releaseLock(); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('latest-metadata-invalid'); }
  if (data.tag_name !== `v${TARGET_VERSION}` || data.draft !== false || data.prerelease !== false || !Array.isArray(data.assets) || data.assets.length > 1000) fail('latest-not-target');
  const targets = data.assets.filter(asset => asset.name === `IndieDeck-Setup-${TARGET_VERSION}-x64.exe`);
  const manifests = data.assets.filter(asset => asset.name === 'latest.yml');
  if (targets.length !== 1 || targets[0].state !== 'uploaded' || targets[0].size !== EXPECTED_TARGET_SIZE || targets[0].digest !== `sha256:${EXPECTED_TARGET_SHA256}` ||
      manifests.length !== 1 || manifests[0].state !== 'uploaded' || manifests[0].digest !== `sha256:${EXPECTED_LATEST_SHA256}`) fail('latest-not-target');
}

async function downloadOld(destination) {
  const first = await response(OLD_ASSET);
  if (![301, 302, 303, 307, 308].includes(first.status)) fail('old-installer-unavailable');
  const location = first.headers.get('location');
  let cdn;
  try { cdn = new URL(location); } catch { fail('old-installer-redirect'); }
  if (cdn.protocol !== 'https:' || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(cdn.hostname) ||
      cdn.username || cdn.password || cdn.port || cdn.hash) fail('old-installer-redirect');
  void first.body?.cancel().catch(() => {});
  const payload = await response(cdn.href, 'application/octet-stream', MAX_TIME);
  if (payload.status !== 200 || !payload.body) fail('old-installer-unavailable');
  let count = 0;
  const hash = crypto.createHash('sha256');
  const verify = new Transform({ transform(chunk, _encoding, done) {
    count += chunk.length; if (count > EXPECTED_INSTALLER_SIZE) return done(new Error('size'));
    hash.update(chunk); done(null, chunk);
  } });
  await pipeline(Readable.fromWeb(payload.body), verify, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  if (count !== EXPECTED_INSTALLER_SIZE || hash.digest('hex') !== EXPECTED_INSTALLER_SHA256) fail('old-installer-integrity');
  const diskHash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(destination)) diskHash.update(chunk);
  if (diskHash.digest('hex') !== EXPECTED_INSTALLER_SHA256) fail('old-installer-integrity');
}

export function cleanEnvironment(base) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(INDIEDECK_|ELECTRON_|NODE_OPTIONS$|GH_TOKEN$|GITHUB_TOKEN$|PORTABLE_)/i.test(key)) delete env[key];
  Object.assign(env, { APPDATA: path.join(base, 'appdata'), LOCALAPPDATA: path.join(base, 'localappdata'),
    USERPROFILE: path.join(base, 'profile'), TEMP: path.join(base, 'temp'), TMP: path.join(base, 'temp'),
    INDIEDECK_HOME: path.join(base, 'launcher') });
  return env;
}

async function runInstaller(file, directory, env) {
  const child = spawn(file, ['/S', `/D=${directory}`], { env, windowsHide: true, stdio: 'ignore', shell: false });
  const timer = setTimeout(() => { if (child.pid && child.exitCode === null) spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); }, MAX_TIME);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  if (exit !== 0) fail('old-installer-failed');
}

async function validateFeed(file) {
  const source = await fsp.readFile(file, 'utf8');
  if (source.length > 8192) fail('old-feed-invalid');
  const fields = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/.exec(line);
    if (!match || fields.has(match[1]) || !['provider', 'owner', 'repo', 'releaseType', 'updaterCacheDirName'].includes(match[1])) fail('old-feed-invalid');
    fields.set(match[1], match[2]);
  }
  if (fields.get('provider') !== 'github' || fields.get('owner') !== 'tjwlstj' || fields.get('repo') !== 'indie-deck' ||
      (fields.has('releaseType') && fields.get('releaseType') !== 'release')) fail('old-feed-invalid');
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function pageSocket(port, child) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (child.exitCode !== null) fail('app-exited');
    try {
      const result = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const pages = await result.json();
      const page = pages.find(item => item.type === 'page' && typeof item.url === 'string' && item.url.startsWith('file:') &&
        /\/app\.asar\/packages\/desktop\/renderer\/index\.html$/i.test(new URL(item.url).pathname));
      if (page) {
        const ws = new URL(page.webSocketDebuggerUrl);
        if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || Number(ws.port) !== port || !/^\/devtools\/page\/[A-Za-z0-9-]+$/.test(ws.pathname) || ws.search || ws.hash) fail('debug-endpoint-invalid');
        return ws.href;
      }
    } catch (error) { if (error.message === 'debug-endpoint-invalid') throw error; }
    await delay(500);
  }
  fail('app-start-timeout');
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('debug-timeout')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('debug-connect')); }, { once: true });
  });
  return ws;
}
function evaluate(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000000), timer = setTimeout(() => { ws.removeEventListener('message', onMessage); reject(new Error('debug-timeout')); }, 120000);
    function onMessage(event) {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer); ws.removeEventListener('message', onMessage);
      if (msg.error || msg.result?.exceptionDetails) reject(new Error('debug-evaluation'));
      else resolve(msg.result?.result?.value);
    }
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

function safeCategory(key) {
  const match = /^ui\.update\.error\.(network|integrity|permission|cancelled|check|download|downloadIncomplete|unavailable|generic)$/.exec(key ?? '');
  return match ? match[1] : 'unclassified';
}

async function verifyDownloadedTarget(localAppData) {
  const pending = path.join(localAppData, 'indie-deck-updater', 'pending');
  const infoPath = path.join(pending, 'update-info.json'), infoStat = await fsp.lstat(infoPath);
  if (!infoStat.isFile() || infoStat.isSymbolicLink() || infoStat.size > 4096) fail('download-cache-invalid');
  const info = JSON.parse(await fsp.readFile(infoPath, 'utf8'));
  if (typeof info.fileName !== 'string' || path.basename(info.fileName) !== info.fileName || !/^[A-Za-z0-9._-]+\.exe$/i.test(info.fileName)) fail('download-cache-invalid');
  const target = path.join(pending, info.fileName), stat = await fsp.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== EXPECTED_TARGET_SIZE) fail('download-cache-invalid');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  if (hash.digest('hex') !== EXPECTED_TARGET_SHA256) fail('download-cache-integrity');
}

async function main() {
try {
  requireRunner();
  phase = 'latest-check'; await getLatest();
  const tempRoot = path.resolve(process.env.RUNNER_TEMP);
  fixture = await fsp.mkdtemp(path.join(tempRoot, 'indiedeck-upgrade-check-'));
  assert.equal(path.dirname(fixture), tempRoot);
  const env = cleanEnvironment(fixture);
  for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE, env.TEMP, env.INDIEDECK_HOME]) await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(env.INDIEDECK_HOME, 'config.json'), JSON.stringify({ roots: [], locale: 'en',
    defaults: { targetLanguage: 'ko', sourceLanguage: 'ja', endpoint: 'GoogleTranslate' }, scanDepth: 2, externalTools: { mtoolRoot: null } }));
  phase = 'old-download'; const installer = path.join(fixture, 'old-setup.exe'); await downloadOld(installer);
  phase = 'old-install'; const directory = path.join(fixture, 'install'); await runInstaller(installer, directory, env);
  const executable = path.join(directory, 'IndieDeck.exe'); if (!(await fsp.stat(executable)).isFile()) fail('old-install-missing');
  await validateFeed(path.join(directory, 'resources', 'app-update.yml'));
  phase = 'app-start'; const port = await allocatePort();
  ownedChild = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${path.join(fixture, 'chromium')}`],
    { env, cwd: directory, windowsHide: true, stdio: 'ignore', shell: false });
  socket = await connect(await pageSocket(port, ownedChild));
  phase = 'app-ready';
  let initial;
  const end = Date.now() + 45000;
  do { initial = await evaluate(socket, `(async()=>window.indiedeck?.updates ? await window.indiedeck.updates.current() : null)()`); if (!initial) await delay(500); } while (!initial && Date.now() < end);
  if (!initial || initial.currentVersion !== OLD_VERSION || initial.mode !== 'installed' || !initial.supported) fail('old-app-mode-invalid');
  phase = 'update-check';
  const checked = await evaluate(socket, `(async()=>{try{return await window.indiedeck.updates.check()}catch{return await window.indiedeck.updates.current()}})()`);
  if (checked?.status !== 'available' || checked.availableVersion !== TARGET_VERSION) fail(`check-${safeCategory(checked?.errorKey)}`);
  phase = 'update-download';
  const downloaded = await evaluate(socket, `(async()=>{try{return await window.indiedeck.updates.download()}catch{return await window.indiedeck.updates.current()}})()`);
  if (downloaded?.status !== 'downloaded' || downloaded.downloadedVersion !== TARGET_VERSION) fail(`download-${safeCategory(downloaded?.errorKey)}`);
  phase = 'download-verification'; await verifyDownloadedTarget(env.LOCALAPPDATA);
  console.log(`[live-upgrade] PASS: installed ${OLD_VERSION}; official latest ${TARGET_VERSION}; update check and verified download completed; no upgrade installation requested.`);
} catch (error) {
  const known = new Set(['runner-guard', 'api-token-unavailable', 'latest-metadata-transport', 'latest-metadata-unavailable', 'latest-metadata-invalid', 'latest-not-target',
    'old-installer-unavailable', 'old-installer-redirect', 'old-installer-integrity', 'old-installer-failed',
    'old-install-missing', 'old-feed-invalid', 'app-exited', 'debug-endpoint-invalid', 'app-start-timeout',
    'debug-timeout', 'debug-connect', 'debug-evaluation', 'old-app-mode-invalid', 'download-cache-invalid', 'download-cache-integrity']);
  const value = error?.message ?? '';
  const safe = known.has(value) || /^(?:check|download)-(?:network|integrity|permission|cancelled|check|download|downloadIncomplete|unavailable|generic|unclassified)$/.test(value)
    ? value : 'unexpected-error';
  console.error(`[live-upgrade] FAILED phase=${phase} category=${safe}`);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (ownedChild?.pid && ownedChild.exitCode === null) spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(ownedChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  if (fixture && path.dirname(fixture) === path.resolve(process.env.RUNNER_TEMP) && path.basename(fixture).startsWith('indiedeck-upgrade-check-')) {
    await fsp.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
  }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

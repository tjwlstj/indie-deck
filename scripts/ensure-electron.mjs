import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 300 * 1024 * 1024, MAX_METADATA = 2 * 1024 * 1024;
const MAX_DEADLINE_MS = 300_000;
const require = createRequire(import.meta.url);

function artifact(version, platform, arch) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['linux', 'win32'].includes(platform) || arch !== 'x64') {
    throw new Error('Unsupported pinned Electron artifact.');
  }
  const file = `electron-v${version}-${platform}-${arch}.zip`;
  const original = `https://github.com/electron/electron/releases/download/v${version}/${file}`;
  const directory = new URL(original); directory.pathname = path.posix.dirname(directory.pathname);
  const cacheKey = crypto.createHash('sha256').update(directory.toString()).digest('hex');
  return { file, cacheKey };
}

function checkedAssetUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/api\.github\.com\/repos\/electron\/electron\/releases\/assets\/[1-9]\d*$/.test(value)) {
    throw new Error('Invalid official release asset reference.');
  }
  return value;
}
function checkedCdnUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/release-assets\.githubusercontent\.com\//.test(value)) throw new Error('Invalid official release redirect.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid official release redirect.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'release-assets.githubusercontent.com' || url.port || url.username || url.password || url.hash) {
    throw new Error('Invalid official release redirect.');
  }
  return value;
}

async function active(promise, signal) {
  if (signal.aborted) throw new Error('Electron transfer timed out.');
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(new Error('Electron transfer timed out.'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', listener); }
}
async function request(fetchImpl, url, accept, signal) {
  try {
    return await active(fetchImpl(url, { redirect: 'manual', signal,
      headers: { Accept: accept, 'User-Agent': 'IndieDeck-CI' } }), signal);
  } catch { throw new Error('Official Electron request failed or timed out.'); }
}
async function consume(response, maximum, signal, write) {
  if (!response.body) throw new Error('Electron response has no body.');
  const header = response.headers.get('content-length');
  if (header && (!/^\d+$/.test(header) || Number(header) > maximum)) throw new Error('Electron response exceeds its byte limit.');
  const reader = response.body.getReader(); let count = 0;
  try {
    while (true) {
      const result = await active(reader.read(), signal);
      if (result.done) break;
      count += result.value.byteLength;
      if (count > maximum) throw new Error('Electron response exceeds its byte limit.');
      await active(write(result.value), signal);
    }
  } catch { void reader.cancel().catch(() => {}); throw new Error('Electron response was interrupted, exceeded its limit or timed out.'); }
  finally { try { reader.releaseLock(); } catch { /* A stalled reader may still be settling. */ } }
  return count;
}
async function digestFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function ordinaryDirectory(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await fsp.mkdir(current); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const stat = await fsp.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Electron cache directory.');
  }
}

/** Copy only the exact, checksum-verified release asset into the two caches
 * used by Electron's installer and the builder. Fetch injection is for tests. */
export async function cacheElectronFromOfficialApi({ version, platform, arch, expectedSha256, cacheRoots,
  fetchImpl = fetch, deadlineMs = MAX_DEADLINE_MS, maxBytes = MAX_BYTES, ci = process.env.GITHUB_ACTIONS === 'true' }) {
  if (ci !== true) throw new Error('Electron API fallback is restricted to GitHub Actions.');
  const { file, cacheKey } = artifact(version, platform, arch);
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256) ||
      !Array.isArray(cacheRoots) || cacheRoots.length < 1 || cacheRoots.length > 2 ||
      cacheRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root)) ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Invalid Electron verification settings.');
  const roots = [...new Set(cacheRoots.map((root) => path.resolve(root)))];
  const scope = new AbortController(), timer = setTimeout(() => scope.abort(), deadlineMs);
  const temporary = [];
  try {
    const metadataUrl = `https://api.github.com/repos/electron/electron/releases/tags/v${version}`;
    const metaResponse = await request(fetchImpl, metadataUrl, 'application/vnd.github+json', scope.signal);
    if (metaResponse.status !== 200) throw new Error('Official Electron release metadata is unavailable.');
    const chunks = [];
    await consume(metaResponse, MAX_METADATA, scope.signal, async (chunk) => { chunks.push(Buffer.from(chunk)); });
    let release;
    try { release = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid official release metadata.'); }
    if (release?.tag_name !== `v${version}` || !Array.isArray(release.assets) || release.assets.length > 1000) throw new Error('Invalid official release metadata.');
    const matches = release.assets.filter((asset) => asset?.name === file);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].size) || matches[0].size < 1 || matches[0].size > maxBytes || matches[0].state !== 'uploaded') {
      throw new Error('Official Electron release asset is missing or invalid.');
    }
    const expectedBytes = matches[0].size;
    const response = await request(fetchImpl, checkedAssetUrl(matches[0].url), 'application/octet-stream', scope.signal);
    if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error('Official Electron asset did not redirect.');
    const cdn = checkedCdnUrl(response.headers.get('location'));
    void response.body?.cancel().catch(() => {});
    // Do not reuse API headers, credentials, or print the temporary signed URL.
    const payload = await request(fetchImpl, cdn, 'application/octet-stream', scope.signal);
    if (payload.status !== 200) throw new Error('Official Electron asset is unavailable.');
    const contentLength = payload.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) !== expectedBytes)) throw new Error('Electron asset size mismatch.');
    const directories = roots.map((root) => path.join(root, cacheKey));
    for (const directory of directories) await ordinaryDirectory(directory);
    const first = path.join(directories[0], `.${file}.${crypto.randomUUID()}.part`); temporary.push(first);
    const handle = await fsp.open(first, 'wx', 0o600), hash = crypto.createHash('sha256');
    let count;
    try {
      count = await consume(payload, maxBytes, scope.signal, async (chunk) => { hash.update(chunk); await handle.writeFile(chunk); });
    } finally { await handle.close(); }
    if (count !== expectedBytes || hash.digest('hex') !== expectedSha256 || await active(digestFile(first), scope.signal) !== expectedSha256) throw new Error('Electron asset checksum or size mismatch.');
    const stages = [first];
    for (let index = 1; index < directories.length; index += 1) {
      const stage = path.join(directories[index], `.${file}.${crypto.randomUUID()}.part`);
      temporary.push(stage); await active(fsp.copyFile(first, stage, fs.constants.COPYFILE_EXCL), scope.signal); stages.push(stage);
    }
    for (let index = 0; index < directories.length; index += 1) {
      const stage = stages[index];
      if (await active(digestFile(stage), scope.signal) !== expectedSha256) throw new Error('Electron staged cache checksum mismatch.');
      const target = path.join(directories[index], file);
      try {
        const stat = await fsp.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe Electron cache entry.');
        if (await active(digestFile(target), scope.signal) === expectedSha256) { await fsp.unlink(stage); continue; }
        await fsp.unlink(target);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await fsp.rename(stage, target);
    }
    return { file, cacheKey };
  } finally {
    clearTimeout(timer);
    await Promise.all(temporary.map((file) => fsp.unlink(file).catch(() => {})));
  }
}

async function runInstaller(installer, cacheRoot) {
  const env = { ...process.env, electron_config_cache: cacheRoot };
  for (const key of Object.keys(env)) {
    if (/^(?:electron_(?:mirror|nightly_mirror|custom_dir|custom_filename|custom_version|use_remote_checksums|install_platform|install_arch|override_dist_path)|npm_config_electron_(?:mirror|nightly_mirror|custom_dir|custom_filename|custom_version|use_remote_checksums)|npm_config_(?:arch|platform)|force_no_cache|node_options)$/i.test(key)) delete env[key];
  }
  const child = spawn(process.execPath, [installer], { env, stdio: 'ignore', windowsHide: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  return code === 0 && !timedOut;
}
async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Electron CI installation is restricted to GitHub Actions.');
  const electronDir = path.dirname(require.resolve('electron'));
  const packageInfo = JSON.parse(await fsp.readFile(path.join(electronDir, 'package.json'), 'utf8'));
  const rootInfo = JSON.parse(await fsp.readFile(path.resolve('package.json'), 'utf8'));
  const version = rootInfo.devDependencies?.electron;
  if (typeof version !== 'string' || version !== packageInfo.version) throw new Error('Electron dependency is not pinned consistently.');
  const { file } = artifact(version, process.platform, process.arch);
  const checksums = JSON.parse(await fsp.readFile(path.join(electronDir, 'checksums.json'), 'utf8'));
  const expectedSha256 = checksums[file];
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('Pinned Electron checksum is missing.');
  const getRequire = createRequire(require.resolve('@electron/get'));
  const envPaths = (await import(pathToFileURL(getRequire.resolve('env-paths')).href)).default;
  const defaultCache = path.resolve(envPaths('electron', { suffix: '' }).cache);
  const installerCache = path.resolve(process.env.electron_config_cache || defaultCache);
  const installer = path.join(electronDir, 'install.js');
  console.log('[electron-install] Checking the pinned Electron installer.');
  if (await runInstaller(installer, installerCache)) return;
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Electron install failed; automatic API fallback is restricted to GitHub Actions.');
  console.log('[electron-install] Official release download failed; checking the official GitHub asset API.');
  await cacheElectronFromOfficialApi({ version, platform: process.platform, arch: process.arch, expectedSha256,
    cacheRoots: [installerCache, defaultCache] });
  if (!await runInstaller(installer, installerCache)) throw new Error('Pinned Electron installer rejected the verified cached artifact.');
  console.log('[electron-install] Verified pinned Electron artifact installed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[electron-install] ${error.message}`); process.exitCode = 1; });
}

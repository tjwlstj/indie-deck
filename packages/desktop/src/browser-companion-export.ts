import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const COMMON = ['store-link.js', 'popup-controller.js', 'popup.js', 'popup.html', 'popup.css'];
const SOURCE = ['manifest.json', 'manifest.firefox.json', ...COMMON, 'README.md'];
const MARKER = '.indiedeck-companion.json';
function fail(): never { throw new Error('ui.stores.error.companionExportFailed'); }
async function directory(target: string, create = false): Promise<void> {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  const paths = [root, ...absolute.slice(root.length).split(path.sep).filter(Boolean).map((part) => { current = path.join(current, part); return current; })];
  for (const item of paths) {
    let stat;
    try { stat = await fsp.lstat(item); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fsp.mkdir(item); stat = await fsp.lstat(item);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
}
async function boundedFile(file: string): Promise<Buffer> {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) fail();
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(128 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes > 128 * 1024 || bytes !== stat.size || (await handle.stat()).size !== stat.size) fail();
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}

/** Export only bundled, fixed-name extension assets. Never inspects a browser
 * profile, installs an extension, registers a host or overwrites a prior copy. */
export async function exportBrowserCompanion(appPath: string, dataDir: string, version: string): Promise<string> {
  try {
    if (!/^\d+\.\d+\.\d+$/.test(version)) fail();
    const source = new Map(await Promise.all(SOURCE.map(async (name) =>
      [name, await boundedFile(path.join(appPath, 'extensions', 'browser-companion', name))] as const)));
    for (const name of ['manifest.json', 'manifest.firefox.json']) {
      const manifest = JSON.parse(source.get(name)!.toString('utf8'));
      if (manifest.version !== version || manifest.manifest_version !== 3 ||
        JSON.stringify(manifest.permissions) !== JSON.stringify(['activeTab']) || manifest.host_permissions?.length) fail();
    }
    const files = new Map<string, Buffer>([['README.md', source.get('README.md')!]]);
    for (const browser of ['chromium', 'firefox']) {
      files.set(`${browser}/manifest.json`, source.get(browser === 'chromium' ? 'manifest.json' : 'manifest.firefox.json')!);
      for (const name of COMMON) files.set(`${browser}/${name}`, source.get(name)!);
    }
    const hashes = Object.fromEntries([...files].map(([name, data]) => [name, crypto.createHash('sha256').update(data).digest('hex')]));
    const marker = Buffer.from(JSON.stringify({ schemaVersion: 1, version, files: hashes }, null, 2));
    files.set(MARKER, marker);
    const base = path.join(path.resolve(dataDir), 'browser-companion'), destination = path.join(base, version);
    await directory(base, true);
    let exists = false;
    try { await fsp.lstat(destination); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) {
      await directory(destination);
      const expected = new Set(files.keys());
      const walk = async (root: string, prefix = ''): Promise<void> => {
        for (const name of await fsp.readdir(root)) {
          const relative = prefix + name, target = path.join(root, name), stat = await fsp.lstat(target);
          if (stat.isSymbolicLink()) fail();
          if (stat.isDirectory()) {
            if (!['chromium', 'firefox'].includes(relative)) fail();
            await walk(target, relative + '/');
          } else {
            if (!expected.delete(relative) || !(await boundedFile(target)).equals(files.get(relative)!)) fail();
          }
        }
      };
      await walk(destination);
      if (expected.size) fail();
      return destination;
    }
    const stage = path.join(base, `.staging-${crypto.randomUUID()}`);
    await fsp.mkdir(stage);
    for (const browser of ['chromium', 'firefox']) await fsp.mkdir(path.join(stage, browser));
    for (const [name, bytes] of files) await fsp.writeFile(path.join(stage, ...name.split('/')), bytes, { flag: 'wx' });
    await directory(base); await directory(stage);
    // A failed export retains its small stage for inspection. No recursive
    // cleanup or replacement can remove user-edited extension directories.
    await fsp.rename(stage, destination);
    return destination;
  } catch { fail(); }
}

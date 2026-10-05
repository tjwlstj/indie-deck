import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { loadRegistry, refreshLibrary, saveConfig } from '../packages/core/dist/index.js';

// End-to-end desktop verification against disposable games and mocked release
// downloads. No real executable is launched and no external service is called.
const locale = process.argv[2] ?? 'ko';
const screenshot = path.resolve('out', `desktop-flow-${locale}.png`);
const progressScreenshot = path.resolve('out', `desktop-progress-${locale}.png`);
const tempParent = path.resolve(os.tmpdir());
const temp = await fs.mkdtemp(path.join(tempParent, 'indiedeck-desktop-flow-'));
const dataDir = path.join(temp, 'data');
const gamesRoot = path.join(temp, 'games');
const archive = path.join(temp, 'translator.zip');
const fontArchive = path.join(temp, 'fonts.7z');
const registry = loadRegistry();
const version = registry.translators.find((t) => t.id === 'xunity-autotranslator').versions[0].version;

function fakeExe() {
  const buffer = Buffer.alloc(512);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x4550, 0x80);
  buffer.writeUInt16LE(0x8664, 0x84);
  return buffer;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30 + nameBytes.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(header, 30);
    const entry = Buffer.alloc(46 + nameBytes.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBytes.copy(entry, 46);
    chunks.push(header, data);
    central.push(entry);
    offset += header.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

try {
  for (const name of ['Aster Test Game', 'Birch Test Game']) {
    const game = path.join(gamesRoot, name);
    const files = {
      'Game.exe': fakeExe(), 'UnityPlayer.dll': 'stub',
      'Game_Data/globalgamemanagers': '2019.4.0f1',
      'Game_Data/Managed/Assembly-CSharp.dll': 'stub',
      'Game_Data/Managed/Unity.TextMeshPro.dll': 'stub',
      'BepInEx/core/BepInEx.dll': Buffer.from('ProductVersion5.4.23.5\0', 'utf16le'),
    };
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(game, file)), { recursive: true });
      await fs.writeFile(path.join(game, file), content);
    }
  }
  await fs.writeFile(archive, zip([
    ['BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.dll', Buffer.from(`ProductVersion${version}\0`, 'utf16le')],
    ['BepInEx/plugins/XUnity.AutoTranslator/smoke.bin', crypto.randomBytes(4 * 1024 * 1024)],
  ]));
  const fontDir = path.join(temp, 'font-source');
  await fs.mkdir(fontDir);
  for (const bundle of registry.fonts.bundles) await fs.writeFile(path.join(fontDir, bundle.file), `offline atlas fixture ${bundle.id}`);
  // A real libarchive-written 7z fixture exercises the local extractor; these
  // bytes are NOT a Unity atlas or a rendering/real-upstream compatibility test.
  const tarCommand = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
  const packed = spawnSync(tarCommand, ['--format=7zip', '-cf', fontArchive, '-C', fontDir, '.'], { windowsHide: true, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`Cannot create the offline 7z font fixture: ${packed.stderr || packed.error}`);
  await saveConfig({ roots: [gamesRoot], locale, defaults: {
    targetLanguage: 'ko', sourceLanguage: 'ja', endpoint: 'GoogleTranslate',
  }, scanDepth: 2 }, dataDir);
  const index = await refreshLibrary(registry, { dataDir });
  if (index.games.length !== 2) throw new Error('The disposable game fixtures did not detect.');
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  const appDir = path.join(temp, 'app');
  await fs.mkdir(appDir);
  const packageInfo = JSON.parse(await fs.readFile('package.json', 'utf8'));
  await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'indiedeck-flow-smoke', version: packageInfo.version,
    main: path.resolve('scripts/desktop-flow-bootstrap.mjs'),
  }));
  const electron = createRequire(import.meta.url)('electron');
  const child = spawn(electron, [appDir], {
    cwd: path.resolve('.'), windowsHide: true, stdio: 'inherit',
    env: { ...process.env, INDIEDECK_HOME: dataDir, INDIEDECK_SMOKE: '1', INDIEDECK_SMOKE_FLOW: '1',
      INDIEDECK_SMOKE_ARCHIVE: archive, INDIEDECK_SMOKE_VERSION: version,
      INDIEDECK_SMOKE_FONT_ARCHIVE: fontArchive, INDIEDECK_SMOKE_FONT_ASSET: registry.fonts.source.asset,
      INDIEDECK_FLOW_SCREENSHOT: screenshot, INDIEDECK_FLOW_PROGRESS_SCREENSHOT: progressScreenshot,
      INDIEDECK_FONT_SCREENSHOT: path.resolve('out', `desktop-fonts-${locale}.png`),
      INDIEDECK_DISABLE_UPDATES: '1',
      INDIEDECK_REGISTRY: path.resolve('registry') },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  if (exitCode !== 0) throw new Error(`Desktop flow failed with exit code ${exitCode}.`);
  console.log(`[desktop-flow] ${locale} passed; screenshot: ${screenshot}`);
} finally {
  if (path.dirname(path.resolve(temp)) !== tempParent || !path.basename(temp).startsWith('indiedeck-desktop-flow-')) {
    throw new Error('Refusing to clean up a fixture directory outside the expected temporary scope.');
  }
  await fs.rm(temp, { recursive: true, force: true });
}

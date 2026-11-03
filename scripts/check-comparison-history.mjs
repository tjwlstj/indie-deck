import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { detectGame, loadRegistry, refreshLibrary, saveConfig } from '../packages/core/dist/index.js';
import { buildTranslationConfigComparison } from '../packages/desktop/dist/translation-config-comparison.js';
import { TranslationConfigHistory } from '../packages/desktop/dist/translation-config-history.js';

// Separate Electron processes exercise durable history rather than retaining a
// main-process Map across a renderer reload. Every path and executable is a
// disposable fixture; this check never starts a game, MTool or browser session.
const locale = process.argv[2] ?? 'ko';
const packaged = process.argv.includes('--packaged');
assert.ok(['ko', 'en'].includes(locale), 'Choose ko or en for the history flow.');
const parent = path.resolve('out');
await fs.mkdir(parent, { recursive: true });
const temporary = await fs.mkdtemp(path.join(parent, 'comparison-history-'));
const dataDir = path.join(temporary, 'data');
const gamesRoot = path.join(temporary, 'games');
const game = path.join(gamesRoot, 'History Test Game');
const dll = path.join(game, 'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll');
const historyFile = path.join(dataDir, 'translation-option-history.json');
const screenshot = path.resolve('out', `desktop-history-${locale}${packaged ? '-packaged' : ''}.png`);
const registry = loadRegistry();
const schema = registry.configSchemas.get('xunity-autotranslator');
assert.ok(schema, 'The registered comparison schema is required.');
const history = new TranslationConfigHistory(dataDir, schema);
const gameId = crypto.createHash('sha1').update(path.resolve(game).toLowerCase()).digest('hex').slice(0, 16);
const electron = packaged ? path.resolve('release/win-unpacked/IndieDeck.exe') : createRequire(import.meta.url)('electron');

function fakeExe() {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

async function snapshot(directory, relative = '') {
  const values = [];
  for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, item.name);
    if (item.isDirectory()) values.push(...await snapshot(directory, name));
    else {
      assert.equal(item.isFile(), true, 'Fixture snapshots accept regular files only.');
      values.push([name, crypto.createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')]);
    }
  }
  return values.sort(([a], [b]) => a.localeCompare(b));
}

async function run(mode) {
  const env = {
    ...process.env, INDIEDECK_HOME: dataDir, INDIEDECK_SMOKE: '1',
    INDIEDECK_SMOKE_HISTORY: mode, INDIEDECK_HISTORY_SCREENSHOT: screenshot,
    INDIEDECK_DISABLE_UPDATES: '1', INDIEDECK_REGISTRY: path.resolve('registry'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.INDIEDECK_SMOKE_FLOW;
  delete env.INDIEDECK_SCREENSHOT;
  const child = spawn(electron, packaged ? [] : [path.resolve('packages/desktop')], {
    cwd: path.resolve('.'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '', timedOut = false;
  child.stdout.on('data', (data) => { output = (output + data).slice(-128 * 1024); });
  child.stderr.on('data', (data) => { errors = (errors + data).slice(-32 * 1024); });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally { clearTimeout(timeout); }
  await fs.writeFile(path.join(temporary, `${mode}.log`), output + errors);
  assert.equal(timedOut, false, `History ${mode} process exceeded its bounded timeout.`);
  assert.equal(code, 0, `History ${mode} failed.\n${output}\n${errors}`);
  assert.ok(output.includes(`[smoke] comparison history ${mode} passed`), `History ${mode} exited without its completion marker.`);
  console.log(`[comparison-history] ${locale}: fresh ${mode} process passed`);
}

try {
  const files = {
    'Game.exe': fakeExe(), 'UnityPlayer.dll': 'offline Unity marker',
    'Game_Data/globalgamemanagers': '2019.4.0f1',
    'Game_Data/Managed/Assembly-CSharp.dll': 'offline managed assembly marker',
    'BepInEx/core/BepInEx.dll': Buffer.from('ProductVersion5.4.23.5\0', 'utf16le'),
    'BepInEx/config/AutoTranslatorConfig.ini': '[Service]\nEndpoint=GoogleTranslate\n[General]\nLanguage=ko\nFromLanguage=ja\n[Files]\nDirectory=C:\\SyntheticPrivate\\secret-directory\n[Unknown]\nPrivateValue=never-copy-this-private-value\n',
  };
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(game, name)), { recursive: true });
    await fs.writeFile(path.join(game, name), contents);
  }
  await fs.mkdir(path.dirname(dll), { recursive: true });
  await fs.writeFile(dll, Buffer.from('ProductVersion5.4.0\0', 'utf16le'));
  await saveConfig({ roots: [gamesRoot], locale, defaults: {
    targetLanguage: 'ko', sourceLanguage: 'ja', endpoint: 'GoogleTranslate',
  }, scanDepth: 2, externalTools: { mtoolRoot: null } }, dataDir);
  const profile = detectGame(registry, game);
  assert.equal(profile?.engineId, 'unity');
  const version = registry.translators.find((item) => item.id === 'xunity-autotranslator').versions[0].version;
  const comparison = await buildTranslationConfigComparison(registry, profile, {
    version, variantId: 'bepinex', currentVersions: ['5.4.0'],
  });
  assert.equal(comparison.available, true);
  assert.equal(comparison.rows.find((row) => row.id === 'xunity.targetLanguage')?.currentValue, 'ko');
  const record = await history.save(gameId, comparison);
  assert.ok(record.hiddenValueIds.includes('xunity.translationDirectory'));
  const stored = await fs.readFile(historyFile, 'utf8');
  assert.doesNotMatch(stored, /SyntheticPrivate|secret-directory|never-copy-this-private-value/);

  // The saved report remains usable after payload removal. This is not a test
  // of removing a user's translator and no launcher install operation is run.
  await fs.unlink(dll);
  const index = await refreshLibrary(registry, { dataDir });
  assert.equal(index.games.length, 1);
  assert.equal(index.games[0].installedTranslators.length, 0);
  const before = await snapshot(game);

  await run('view');
  assert.equal((await history.get(gameId)).record?.recordedAt, record.recordedAt);
  assert.ok((await fs.stat(screenshot)).size > 0, 'The history view screenshot was not written.');
  await run('clear');
  assert.equal((await history.get(gameId)).record, undefined);
  await run('empty');
  assert.equal((await history.get(gameId)).record, undefined);

  const damaged = '{"schemaVersion":1,"records":[';
  await fs.writeFile(historyFile, damaged);
  await run('damaged');
  assert.equal(await fs.readFile(historyFile, 'utf8'), damaged, 'Damaged history bytes were overwritten.');
  assert.deepEqual(await snapshot(game), before, 'History review/deletion changed game or config bytes.');
  console.log(`[comparison-history] ${locale} passed: 4 separate app processes, persisted review, explicit deletion, damaged-data preservation and unchanged game bytes; screenshot: ${screenshot}`);
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), parent, 'Refusing cleanup outside the fixture parent.');
  assert.ok(path.basename(temporary).startsWith('comparison-history-'));
  await fs.rm(temporary, { recursive: true, force: true });
}

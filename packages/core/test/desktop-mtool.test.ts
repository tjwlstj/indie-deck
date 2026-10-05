import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import type { GameProfile } from '../src/types.ts';
import { configPath, loadConfig, saveConfig } from '../src/library/index.ts';
import { getMToolStatus, getMToolGameExecutable, isMToolGame, mtoolLaunchSpec } from '../../desktop/src/mtool.ts';

const tempParent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(tempParent, 'indiedeck-mtool-'));
after(() => {
  assert.ok(temp.startsWith(tempParent + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
});

function fakePE(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

function write(target: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function bundle(name: string, nested = true): { root: string; tool: string; exe: string } {
  const root = path.join(temp, name);
  const tool = nested ? path.join(root, 'Tool') : root;
  const exe = path.join(tool, 'MTool.exe');
  write(exe, fakePE());
  write(path.join(tool, 'package.json'), JSON.stringify({ name: 'MToolClient_1790160470469483691631', main: 'www/index.html' }));
  write(path.join(tool, 'www', 'index.html'), '<html>isolated fixture; never executed</html>');
  return { root, tool, exe };
}

function game(name: string, engineId = 'rpgmaker-mv', executable = 'Game.exe'): GameProfile {
  const root = path.join(temp, 'games', name);
  write(path.join(root, executable), fakePE());
  return {
    path: root, name, engineId, engineName: engineId, confidence: 100,
    alternatives: [], executable, arch: 'x64', captures: {},
    installedLoaders: [], installedTranslators: [], installedFontBundles: [],
    notes: [], scannedAt: new Date(0).toISOString(),
  };
}

function junction(target: string, link: string, ctx: TestContext): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      ctx.skip('this host does not permit isolated symlink/junction fixtures');
      return false;
    }
    throw error;
  }
}

test('MTool distinguishes missing, disabled and unsupported hosts without guessing commands', async () => {
  const missing = await getMToolStatus(path.join(temp, 'absent'), { platform: 'win32' });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.source, 'configured');
  assert.equal(missing.reasonKey, 'ui.mtool.reason.notFound');
  const disabled = await getMToolStatus(null);
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.source, 'disabled');
  assert.equal(disabled.root, undefined);
  assert.equal((await getMToolStatus(undefined, { platform: 'linux' })).reasonKey, 'ui.mtool.reason.unsupportedPlatform');
  assert.equal((await getMToolStatus('relative/tool', { platform: 'win32' })).reasonKey, 'ui.mtool.reason.invalidRoot');
});

test('the fixed default probe and explicit bundle/Tool selection recognise the same MTool package', async () => {
  const fixture = bundle('valid-default');
  const defaultStatus = await getMToolStatus(undefined, { platform: 'win32', defaultRoot: fixture.root });
  assert.equal(defaultStatus.status, 'ready');
  assert.equal(defaultStatus.source, 'default');
  assert.equal(defaultStatus.executable, fixture.exe);
  assert.equal(defaultStatus.toolDirectory, fixture.tool);
  assert.equal((await getMToolStatus(fixture.root, { platform: 'win32' })).status, 'ready');
  assert.equal((await getMToolStatus(fixture.tool, { platform: 'win32' })).executable, fixture.exe);
  const flat = bundle('valid-flat', false);
  assert.equal((await getMToolStatus(flat.root, { platform: 'win32' })).executable, flat.exe);
});

test('MTool requires its public manifest identity and exact application entry point', async () => {
  const wrongName = bundle('wrong-name');
  write(path.join(wrongName.tool, 'package.json'), JSON.stringify({ name: 'AnotherClient', main: 'www/index.html' }));
  assert.equal((await getMToolStatus(wrongName.root, { platform: 'win32' })).reasonKey, 'ui.mtool.reason.invalidPackage');
  const wrongEntry = bundle('wrong-entry');
  write(path.join(wrongEntry.tool, 'package.json'), JSON.stringify({ name: 'MToolClient_test', main: '../outside.html' }));
  assert.equal((await getMToolStatus(wrongEntry.root, { platform: 'win32' })).reasonKey, 'ui.mtool.reason.invalidPackage');
  const noEntry = bundle('missing-entry');
  fs.unlinkSync(path.join(noEntry.tool, 'www', 'index.html'));
  assert.equal((await getMToolStatus(noEntry.root, { platform: 'win32' })).reasonKey, 'ui.mtool.reason.invalidPackage');
  const hugeManifest = bundle('huge-manifest');
  write(path.join(hugeManifest.tool, 'package.json'), ' '.repeat(65537));
  assert.equal((await getMToolStatus(hugeManifest.root, { platform: 'win32' })).reasonKey, 'ui.mtool.reason.invalidPackage');
});

test('MTool refuses scripts/non-PE executables and does not fall back to nw.exe or batch launchers', async () => {
  const fake = bundle('non-pe');
  write(fake.exe, '@echo off\necho not a Windows executable');
  assert.equal((await getMToolStatus(fake.root, { platform: 'win32' })).reasonKey, 'ui.mtool.reason.invalidExecutable');
  const fallback = bundle('fallback');
  fs.renameSync(fallback.exe, path.join(fallback.tool, 'nw.exe'));
  write(path.join(fallback.root, 'Use me to open the Tool.bat'), '@echo off\nstart Tool\\nw.exe');
  assert.equal((await getMToolStatus(fallback.root, { platform: 'win32' })).status, 'missing');
});

test('a present invalid nested tool never silently falls through to a different root executable', async () => {
  const fixture = bundle('no-fallthrough');
  write(fixture.exe, 'not PE');
  write(path.join(fixture.root, 'MTool.exe'), fakePE());
  write(path.join(fixture.root, 'package.json'), JSON.stringify({ name: 'MToolClient_root', main: 'www/index.html' }));
  write(path.join(fixture.root, 'www', 'index.html'), 'root fixture');
  assert.equal((await getMToolStatus(fixture.root, { platform: 'win32' })).reasonKey, 'ui.mtool.reason.invalidExecutable');
});

test('MTool rejects linked bundle ancestry and linked application content', async (ctx) => {
  const fixture = bundle('linked-target');
  const link = path.join(temp, 'linked-bundle');
  if (!junction(fixture.root, link, ctx)) return;
  assert.equal((await getMToolStatus(link, { platform: 'win32' })).reasonKey, 'ui.mtool.reason.linkedPath');
  assert.equal((await getMToolStatus(path.join(link, 'Tool'), { platform: 'win32' })).reasonKey, 'ui.mtool.reason.linkedPath');
  const contents = bundle('linked-content');
  fs.renameSync(path.join(contents.tool, 'www'), path.join(contents.tool, 'www-original'));
  if (!junction(path.join(contents.tool, 'www-original'), path.join(contents.tool, 'www'), ctx)) return;
  assert.equal((await getMToolStatus(contents.root, { platform: 'win32' })).reasonKey, 'ui.mtool.reason.linkedPath');
});

test('RPG Maker gating excludes generic NW.js, Wolf and Unity rather than overpromising support', () => {
  for (const engineId of ['rpgmaker-mv', 'rpgmaker-mz', 'rpgmaker-rgss']) assert.equal(isMToolGame({ engineId }), true);
  for (const engineId of ['nwjs', 'wolf-rpg', 'unity', 'unknown', '']) assert.equal(isMToolGame({ engineId }), false);
});

test('game handoff rejects unsupported profiles, non-PE payloads and escaped executable paths', async () => {
  const profile = game('safe-target');
  assert.equal(await getMToolGameExecutable(profile), path.join(profile.path, 'Game.exe'));
  await assert.rejects(getMToolGameExecutable({ ...profile, engineId: 'unity' }), /unsupportedGame/);
  for (const executable of ['../Outside.exe', 'sub/../../Outside.exe', 'Game.bat', path.join(temp, 'Outside.exe'), 'Game.exe:stream']) {
    await assert.rejects(getMToolGameExecutable({ ...profile, executable }), /invalidGameExecutable/);
  }
  write(path.join(profile.path, 'Game.exe'), 'not PE');
  await assert.rejects(getMToolGameExecutable(profile), /invalidGameExecutable/);
});

test('game handoff rejects game-directory junctions', async (ctx) => {
  const profile = game('game-link-target');
  const link = path.join(temp, 'game-link');
  if (!junction(profile.path, link, ctx)) return;
  await assert.rejects(getMToolGameExecutable({ ...profile, path: link }), /linkedPath/);
});

test('launch specs use one unquoted absolute game argument and tool cwd without executing anything', async (ctx) => {
  if (process.platform !== 'win32') { ctx.skip('production launch specs intentionally require a Windows host'); return; }
  const fixture = bundle('tool with spaces & parentheses');
  const profile = game('한글 Game & echo (test)^ %value%', 'rpgmaker-mz', 'Play & test.exe');
  const status = await getMToolStatus(fixture.root);
  const standalone = await mtoolLaunchSpec(status);
  assert.deepEqual(standalone, { executable: fixture.exe, args: [], cwd: fixture.tool });
  const handoff = await mtoolLaunchSpec(status, profile);
  assert.deepEqual(handoff.args, [path.join(profile.path, 'Play & test.exe')]);
  assert.equal(handoff.executable, fixture.exe);
  assert.equal(handoff.cwd, fixture.tool);
  assert.equal(Object.hasOwn(handoff, 'shell'), false, 'the caller must spawn with shell:false; this module never spawns');
});

test('launch spec revalidates an old ready status instead of trusting stale executable paths', async (ctx) => {
  if (process.platform !== 'win32') { ctx.skip('production launch specs intentionally require a Windows host'); return; }
  const fixture = bundle('stale-tool');
  const status = await getMToolStatus(fixture.root);
  assert.equal(status.status, 'ready');
  write(fixture.exe, 'replaced non-PE file');
  await assert.rejects(mtoolLaunchSpec(status), /invalidExecutable/);
  const disabled = await getMToolStatus(null);
  await assert.rejects(mtoolLaunchSpec(disabled), /disabled/);
  const forged = { ...status, executable: path.join(temp, 'arbitrary.exe') };
  write(fixture.exe, fakePE());
  await assert.rejects(mtoolLaunchSpec(forged), /invalidExecutable/);
});

test('MTool config round-trips alongside legacy roots, defaults and locale; null disables the default probe', async () => {
  const data = path.join(temp, 'config-roundtrip');
  const legacy = await loadConfig(data);
  assert.equal(legacy.externalTools, undefined);
  const configured = { ...legacy, roots: ['D:\\Games'], locale: 'ko', defaults: { ...legacy.defaults, targetLanguage: 'ko' }, externalTools: { mtoolRoot: 'D:\\MTool' } };
  await saveConfig(configured, data);
  assert.deepEqual(await loadConfig(data), configured);
  const disabled = { ...configured, externalTools: { mtoolRoot: null } };
  await saveConfig(disabled, data);
  assert.deepEqual(await loadConfig(data), disabled);
  const malformed = { ...configured, externalTools: { mtoolRoot: { executable: 'cmd.exe' } } };
  write(configPath(data), JSON.stringify(malformed));
  const loaded = await loadConfig(data);
  assert.equal(loaded.externalTools, undefined);
  assert.deepEqual(loaded.roots, configured.roots);
  assert.deepEqual(loaded.defaults, configured.defaults);
  assert.equal(loaded.locale, 'ko');
});

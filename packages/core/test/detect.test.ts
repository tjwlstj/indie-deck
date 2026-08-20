import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { detectGame, scanLibrary } from '../src/detect/index.ts';
import { loadRegistry } from '../src/registry/index.ts';
import { peArchFromBuffer } from '../src/util/pe.ts';

const reg = loadRegistry();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-detect-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Builds a PE header with the given machine type, enough for peArch. */
function fakeExe(machine: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80);
  buf.writeUInt16LE(machine, 0x84);
  return buf;
}

function makeGame(name: string, files: Record<string, string | Buffer>): string {
  const root = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

test('reads the machine type out of a PE header', () => {
  assert.equal(peArchFromBuffer(fakeExe(0x8664)), 'x64');
  assert.equal(peArchFromBuffer(fakeExe(0x014c)), 'x86');
  assert.equal(peArchFromBuffer(Buffer.from('not an exe')), 'unknown');
});

test('detects a Mono Unity game and its version', () => {
  const root = makeGame('unity-mono', {
    'Game.exe': fakeExe(0x8664),
    'UnityPlayer.dll': 'stub',
    'UnityCrashHandler64.exe': 'stub',
    'Game_Data/globalgamemanagers': Buffer.concat([Buffer.alloc(48), Buffer.from('2021.3.16f1\0')]),
    'Game_Data/Managed/Assembly-CSharp.dll': 'stub',
    'MonoBleedingEdge/x86_64/mono-2.0-bdwgc.dll': 'stub',
  });

  const profile = detectGame(reg, root);
  assert.ok(profile);
  assert.equal(profile.engineId, 'unity');
  assert.equal(profile.unity?.backend, 'mono');
  assert.equal(profile.unity?.version, '2021.3.16f1');
  assert.equal(profile.unity?.versionSource, 'globalgamemanagers');
  assert.equal(profile.arch, 'x64');
  assert.equal(profile.executable, 'Game.exe', 'the exe paired with _Data wins over helpers');
});

test('detects an IL2CPP Unity game, including a Unity China build string', () => {
  const root = makeGame('unity-il2cpp', {
    'Yog.exe': fakeExe(0x8664),
    'UnityPlayer.dll': 'stub',
    'GameAssembly.dll': 'stub',
    'Yog_Data/globalgamemanagers': Buffer.concat([Buffer.alloc(48), Buffer.from('2021.3.23f1c1\0')]),
    'Yog_Data/il2cpp_data/Metadata/global-metadata.dat': 'TMProUnityEngine.InputSystem',
  });

  const profile = detectGame(reg, root, { deep: true });
  assert.ok(profile);
  assert.equal(profile.unity?.backend, 'il2cpp');
  assert.equal(profile.unity?.version, '2021.3.23f1c1');
  assert.equal(profile.unity?.usesTextMeshPro, true);
  assert.equal(profile.unity?.usesNewInputSystem, true);
});

test("detects Ren'Py and reads its version", () => {
  const root = makeGame('renpy', {
    'Eternum.exe': fakeExe(0x8664),
    'Eternum.py': 'import renpy',
    'renpy/__init__.py': '# renpy',
    'renpy/vc_version.py': "branch = 'fix'\nversion = '8.3.2.24090902'\n",
    'game/script.rpa': 'archive',
    'lib/py3-windows-x86_64/python.exe': 'stub',
  });

  const profile = detectGame(reg, root);
  assert.ok(profile);
  assert.equal(profile.engineId, 'renpy');
  assert.equal(profile.engineVersion, '8.3.2.24090902');
  assert.equal(profile.captures['renpyOnlyCompiled'], 'true', 'an .rpa-only build is flagged for offline translators');
});

test('separates RPG Maker MV from MZ and reads the game title', () => {
  const mv = makeGame('rpg-mv', {
    'Game.exe': fakeExe(0x8664),
    'nw.dll': 'stub',
    'package.json': '{"name":"mv"}',
    'js/rpg_core.js': '//',
    'data/System.json': JSON.stringify({ gameTitle: 'Old School', locale: 'ja_JP' }),
  });
  const mz = makeGame('rpg-mz', {
    'Game.exe': fakeExe(0x8664),
    'nw.dll': 'stub',
    'package.json': '{"name":"mz"}',
    'js/rmmz_core.js': '//',
    'data/System.json': JSON.stringify({ gameTitle: 'New School' }),
  });

  assert.equal(detectGame(reg, mv)?.engineId, 'rpgmaker-mv');
  assert.equal(detectGame(reg, mv)?.title, 'Old School');
  assert.equal(detectGame(reg, mz)?.engineId, 'rpgmaker-mz');
  assert.equal(detectGame(reg, mz)?.title, 'New School');
});

test('distinguishes BepInEx 5 from BepInEx 6 by its negative marker', () => {
  const five = makeGame('bep5', {
    'Game.exe': fakeExe(0x8664),
    'UnityPlayer.dll': 'stub',
    'Game_Data/Managed/Assembly-CSharp.dll': 'stub',
    'BepInEx/core/BepInEx.dll': 'stub',
    'BepInEx/core/BepInEx.Preloader.dll': 'stub',
    'winhttp.dll': 'stub',
  });
  const six = makeGame('bep6', {
    'Game.exe': fakeExe(0x8664),
    'UnityPlayer.dll': 'stub',
    'Game_Data/Managed/Assembly-CSharp.dll': 'stub',
    'BepInEx/core/BepInEx.dll': 'stub',
    'BepInEx/core/BepInEx.Core.dll': 'stub',
    'BepInEx/core/BepInEx.Unity.Mono.dll': 'stub',
    'winhttp.dll': 'stub',
  });

  assert.deepEqual(
    detectGame(reg, five)?.installedLoaders.map((l) => l.loaderId),
    ['bepinex5'],
  );
  assert.deepEqual(
    detectGame(reg, six)?.installedLoaders.map((l) => l.loaderId),
    ['bepinex6-mono'],
    'BepInEx 6 must not also report as BepInEx 5',
  );
});

test('a bare mods/ folder is not mistaken for an installed translator', () => {
  const root = makeGame('godot-mods', {
    'game.exe': fakeExe(0x8664),
    'game.console.exe': fakeExe(0x8664),
    'game.pck': Buffer.concat([Buffer.from('GDPC'), Buffer.alloc(16)]),
    'mods/readme.txt': 'community mods live here',
    'Mods/whatever.txt': 'not a plugin',
  });
  const profile = detectGame(reg, root);
  assert.equal(profile?.engineId, 'godot');
  assert.deepEqual(profile?.installedTranslators, []);
});

test('finds installed TMP font bundles in the game root', () => {
  const root = makeGame('fonts', {
    'Game.exe': fakeExe(0x8664),
    'UnityPlayer.dll': 'stub',
    'Game_Data/globalgamemanagers': Buffer.concat([Buffer.alloc(48), Buffer.from('2022.3.10f1\0')]),
    'Game_Data/Managed/Assembly-CSharp.dll': 'stub',
    arialuni_sdf_u2018: 'bundle',
    arialuni_sdf_u2019: 'bundle',
  });
  assert.deepEqual(detectGame(reg, root)?.installedFontBundles, ['arialuni_sdf_u2018', 'arialuni_sdf_u2019']);
});

test('scan finds games nested one level down and does not descend into a match', () => {
  const outer = path.join(tmp, 'nested');
  makeGame('nested/Release_v1/Game_Data/x', { placeholder: 'x' });
  makeGame('nested/Release_v1', {
    'Game.exe': fakeExe(0x8664),
    'UnityPlayer.dll': 'stub',
    'Game_Data/globalgamemanagers': Buffer.concat([Buffer.alloc(48), Buffer.from('2019.4.1f1\0')]),
    'Game_Data/Managed/Assembly-CSharp.dll': 'stub',
  });

  const found = scanLibrary(reg, [outer], { depth: 2 });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.name, 'Release_v1');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectGame } from '../src/detect/index.ts';
import { loadRegistry } from '../src/registry/index.ts';

const registry = loadRegistry();

test('direct detection can refuse a linked executable independently of bulk scan limits', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-detect-links-'));
  try {
    const root = path.join(base, 'game'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'UnityPlayer.dll'), 'marker');
    fs.mkdirSync(path.join(root, 'Game_Data'));
    fs.writeFileSync(path.join(root, 'Game_Data', 'globalgamemanagers'), '2021.3.16f1');
    const external = path.join(base, 'external.exe'); fs.writeFileSync(external, 'MZ harmless fixture');
    try { fs.symlinkSync(external, path.join(root, 'Game.exe'), 'file'); }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('host does not permit file symlinks'); return; } throw error; }
    assert.equal(detectGame(registry, root)?.executable, 'Game.exe');
    assert.equal(detectGame(registry, root, { rejectLinks: true })?.executable, undefined);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('direct detection with rejectLinks does not read an engine marker through a directory junction', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-detect-links-'));
  try {
    const root = path.join(base, 'game'), external = path.join(base, 'external');
    fs.mkdirSync(root); fs.mkdirSync(external);
    fs.writeFileSync(path.join(root, 'Game.exe'), 'MZ harmless fixture');
    fs.writeFileSync(path.join(root, 'UnityPlayer.dll'), 'marker');
    fs.writeFileSync(path.join(external, 'globalgamemanagers'), '2021.3.16f1');
    fs.symlinkSync(external, path.join(root, 'Game_Data'), process.platform === 'win32' ? 'junction' : 'dir');
    const markerRegistry = { ...registry, engines: [{ ...registry.engines[0]!, minScore: 60,
      rules: [{ kind: 'file' as const, value: 'Game_Data/globalgamemanagers', score: 60 }], probes: [] }] };
    assert.equal(detectGame(markerRegistry, root)?.engineId, registry.engines[0]!.id);
    assert.equal(detectGame(markerRegistry, root, { rejectLinks: true }), undefined);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

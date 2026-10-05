import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { detectGame } from '../src/detect/index.ts';
import { installModFromFile } from '../src/mods/index.ts';
import { loadRegistry } from '../src/registry/index.ts';
import { readSafeRemovalReceipts } from '../../desktop/src/receipt-guard.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-receipt-guard-'));
const HASH = 'a'.repeat(64);
const reg = loadRegistry();
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function root(name: string): string {
  const value = path.join(tmp, name);
  fs.mkdirSync(path.join(value, '.indiedeck/receipts'), { recursive: true });
  return value;
}

function rawReceipt(componentId = 'demo', entries: unknown[] = [{ path: 'plugin.dll', operation: 'create', sha256: HASH }]) {
  return {
    id: `receipt-${componentId}`,
    schemaVersion: 2,
    gamePath: 'untrusted-recorded-path',
    kind: 'translator',
    componentId,
    version: '1.0.0',
    installedAt: new Date(0).toISOString(),
    entries,
  };
}

async function writeRaw(gameRoot: string, name: string, value: unknown): Promise<string> {
  const file = path.join(gameRoot, '.indiedeck/receipts', name);
  await fsp.writeFile(file, JSON.stringify(value), 'utf8');
  return file;
}

function executable(): Buffer {
  const value = Buffer.alloc(512);
  value.writeUInt16LE(0x5a4d, 0);
  value.writeUInt32LE(0x80, 0x3c);
  value.writeUInt32LE(0x4550, 0x80);
  value.writeUInt16LE(0x8664, 0x84);
  return value;
}

test('accepts an actual loose-mod receipt with a Korean spaced component ID and copy hash', async () => {
  const gameRoot = root('actual-korean-mod');
  const gameFiles: Record<string, string | Buffer> = {
    'Game.exe': executable(),
    'nw.dll': 'stub',
    'package.json': '{"name":"demo"}',
    'js/rmmz_core.js': '//',
    'js/plugins.js': 'var $plugins = [];',
    'data/System.json': '{"gameTitle":"Demo"}',
  };
  for (const [relative, contents] of Object.entries(gameFiles)) {
    const target = path.join(gameRoot, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, contents);
  }
  const source = path.join(tmp, '한글 플러그인.js');
  await fsp.writeFile(source, '// translated mod payload');
  const profile = detectGame(reg, gameRoot);
  assert.ok(profile);

  const installed = await installModFromFile(reg, profile, source, { name: '한글 번역 모드' });
  assert.equal(installed.receipt?.componentId, '한글 번역 모드');

  const guarded = await readSafeRemovalReceipts(gameRoot, ['Game.exe']);
  const receipt = guarded.find((item) => item.componentId === '한글 번역 모드');
  assert.ok(receipt, 'the producer receipt is accepted by the strict removal guard');
  const copied = receipt.entries.find((entry) => entry.path.endsWith('/한글 플러그인.js'));
  assert.match(copied?.sha256 ?? '', /^[a-f0-9]{64}$/);
});

test('returns the same sanitised object it validated instead of reading the receipt twice', async () => {
  const gameRoot = root('one-read');
  const file = await writeRaw(gameRoot, 'translator-demo.json', rawReceipt());

  const receipts = await readSafeRemovalReceipts(gameRoot, ['Game.exe']);
  await fsp.writeFile(
    file,
    JSON.stringify(rawReceipt('demo', [{ path: 'Game.exe', operation: 'create', sha256: HASH }])),
    'utf8',
  );

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.gamePath, path.resolve(gameRoot), 'the trusted caller root replaces the recorded path');
  assert.deepEqual(receipts[0]?.entries, [{ path: 'plugin.dll', operation: 'create', sha256: HASH }]);
});

test('blocks a canonical receipt from deleting the protected main executable', async () => {
  const gameRoot = root('protected-exe');
  await writeRaw(
    gameRoot,
    'translator-demo.json',
    rawReceipt('demo', [{ path: 'Game.exe', operation: 'create', sha256: HASH }]),
  );
  await assert.rejects(() => readSafeRemovalReceipts(gameRoot, ['Game.exe']), /protected game executable/);
});

test('blocks a directory target that would recursively remove a protected executable', async () => {
  const gameRoot = root('protected-ancestor');
  await writeRaw(
    gameRoot,
    'translator-demo.json',
    rawReceipt('demo', [{ path: 'bin', operation: 'create', sha256: HASH }]),
  );
  await assert.rejects(() => readSafeRemovalReceipts(gameRoot, ['bin/Game.exe']), /protected game executable/);
});

test('requires hashes for every v2 create and modify operation', async () => {
  const gameRoot = root('hash-required');
  await writeRaw(gameRoot, 'translator-demo.json', rawReceipt('demo', [{ path: 'plugin.dll', operation: 'create' }]));
  await assert.rejects(() => readSafeRemovalReceipts(gameRoot, []), /sha256 must be a 64-digit hash/);
});

test('rejects traversal and entries without an explicit operation', async () => {
  const traversalRoot = root('entry-traversal');
  await writeRaw(
    traversalRoot,
    'translator-demo.json',
    rawReceipt('demo', [{ path: '../Game.exe', operation: 'create', sha256: HASH }]),
  );
  await assert.rejects(() => readSafeRemovalReceipts(traversalRoot, []), /unsafe path segment/);

  const operationRoot = root('entry-operation');
  await writeRaw(operationRoot, 'translator-demo.json', rawReceipt('demo', [{ path: 'plugin.dll', sha256: HASH }]));
  await assert.rejects(() => readSafeRemovalReceipts(operationRoot, []), /operation is missing or unsupported/);
});

test('requires modify and snapshot backups to stay under the dedicated backup directory', async () => {
  const gameRoot = root('backup-scope');
  await writeRaw(
    gameRoot,
    'translator-demo.json',
    rawReceipt('demo', [{ path: 'plugin.dll', operation: 'modify', sha256: HASH, backup: 'readme.txt' }]),
  );
  await assert.rejects(() => readSafeRemovalReceipts(gameRoot, []), /inside \.indiedeck\/backups/);
});

test('rejects legacy v1 evidence instead of guessing destructive operations', async () => {
  const gameRoot = root('legacy-v1');
  const raw = rawReceipt();
  raw.schemaVersion = 1;
  delete (raw as { entries?: unknown }).entries;
  Object.assign(raw, { files: ['plugin.dll'], backups: [] });
  await writeRaw(gameRoot, 'translator-demo.json', raw);
  await assert.rejects(() => readSafeRemovalReceipts(gameRoot, []), /legacy v1 receipts cannot be removed automatically/);
});

test('requires the storage filename to match kind and componentId exactly', async () => {
  const gameRoot = root('canonical-name');
  await writeRaw(gameRoot, 'translator-other.json', rawReceipt('demo'));
  await assert.rejects(() => readSafeRemovalReceipts(gameRoot, []), /file name does not match/);
});

test('blocks a target whose existing ancestor is a symlink or junction', async (context) => {
  const gameRoot = root('target-link');
  const outside = path.join(tmp, 'target-link-outside');
  await fsp.mkdir(outside, { recursive: true });
  const linked = path.join(gameRoot, 'linked');
  try {
    await fsp.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((err as NodeJS.ErrnoException).code ?? '')) {
      context.skip('this host does not permit symlink/junction fixtures');
      return;
    }
    throw err;
  }
  await writeRaw(
    gameRoot,
    'translator-demo.json',
    rawReceipt('demo', [{ path: 'linked/plugin.dll', operation: 'create', sha256: HASH }]),
  );
  await assert.rejects(() => readSafeRemovalReceipts(gameRoot, []), /symbolic link or junction/);
});

test('blocks a backup whose existing ancestor is a symlink or junction', async (context) => {
  const gameRoot = root('backup-link');
  const outside = path.join(tmp, 'backup-link-outside');
  await fsp.mkdir(path.join(gameRoot, '.indiedeck/backups'), { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  const linked = path.join(gameRoot, '.indiedeck/backups/stamp');
  try {
    await fsp.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((err as NodeJS.ErrnoException).code ?? '')) {
      context.skip('this host does not permit symlink/junction fixtures');
      return;
    }
    throw err;
  }
  await writeRaw(
    gameRoot,
    'translator-demo.json',
    rawReceipt('demo', [
      { path: 'plugin.dll', operation: 'modify', sha256: HASH, backup: '.indiedeck/backups/stamp/plugin.dll' },
    ]),
  );
  await assert.rejects(() => readSafeRemovalReceipts(gameRoot, []), /symbolic link or junction/);
});

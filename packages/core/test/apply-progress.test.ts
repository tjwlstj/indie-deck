import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import { applyPlan, type ApplyProgress, type ApplyResult } from '../src/install/apply.ts';
import { downloadAsset } from '../src/install/download.ts';
import type { TranslatorPlan } from '../src/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-apply-progress-'));

function makeZip(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const compressed = zlib.deflateRawSync(data);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, eocd]);
}

const archive = makeZip('plugin.dll', Buffer.from('installed payload'));
const assetUrl = 'https://builds.bepinex.dev/indiedeck-fixture/payload.zip';
const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), assetUrl);
    return new Response(archive, { headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) } });
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function plan(gamePath: string, failAfterExtract = false): TranslatorPlan {
  return {
    gamePath,
    translatorId: 'test-translator',
    translatorName: 'Test Translator',
    variantId: 'test-variant',
    variantName: 'Test Variant',
    version: '1.0.0',
    tag: 'v1.0.0',
    score: 1,
    viable: true,
    findings: [],
    steps: [
      {
        action: 'download',
        description: 'Download payload',
        descriptionKey: 'test.download',
        source: { type: 'url', url: assetUrl },
      },
      { action: 'extract', description: 'Extract payload', descriptionKey: 'test.extract', dest: '.' },
      ...(failAfterExtract
        ? [{ action: 'config' as const, description: 'Write unsafe config', dest: '../outside.ini' }]
        : []),
    ],
    config: failAfterExtract ? { General: { Language: 'ko' } } : {},
  };
}

test('applyPlan emits structured phases with one-based stable step positions', async () => {
  const root = path.join(tmp, 'success');
  await fsp.mkdir(root, { recursive: true });
  const events: ApplyProgress[] = [];
  const legacyBytes: number[] = [];
  const result = await applyPlan(plan(root), {
    cacheDir: path.join(tmp, 'cache-success'),
    force: true,
    onProgress: (received) => legacyBytes.push(received),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.mutationStatus, 'committed');
  assert.equal(result.receiptStatus, 'complete');
  assert.ok(legacyBytes.length > 0, 'the legacy byte callback remains active');
  assert.deepEqual(events.slice(0, 2).map((event) => [event.phase, event.status]), [
    ['preflight', 'started'],
    ['preflight', 'completed'],
  ]);
  for (const phase of ['download', 'verify', 'extract', 'receipt'] as const) {
    assert.ok(events.some((event) => event.phase === phase), `${phase} is observable`);
  }
  assert.ok(events.every((event) => event.stepIndex >= 1 && event.stepIndex <= event.stepCount));
  assert.ok(events.every((event) => event.stepCount === 4), 'preflight and receipt are part of the logical count');
  assert.ok(
    events.some(
      (event) =>
        event.phase === 'download' &&
        event.status === 'progress' &&
        event.assetId === 'payload.zip' &&
        event.received === archive.length,
    ),
    'asset bytes and identity cross the apply boundary',
  );
});

test('a failed step reports the actual step and a verified rollback result', async () => {
  const root = path.join(tmp, 'rollback');
  await fsp.mkdir(root, { recursive: true });
  const events: ApplyProgress[] = [];
  let caught: (Error & { applyResult?: ApplyResult }) | undefined;
  try {
    await applyPlan(plan(root, true), {
      cacheDir: path.join(tmp, 'cache-rollback'),
      force: true,
      onEvent: (event) => events.push(event),
    });
  } catch (err) {
    caught = err as Error & { applyResult?: ApplyResult };
  }

  assert.ok(caught?.applyResult, 'the thrown error carries the structured outcome');
  assert.equal(caught.applyResult.failedStep, 'Write unsafe config');
  assert.equal(caught.applyResult.mutationStatus, 'rolled-back');
  assert.equal(caught.applyResult.rollbackStatus, 'complete');
  assert.deepEqual(caught.applyResult.rollbackFailures, []);
  assert.equal(fs.existsSync(path.join(root, 'plugin.dll')), false, 'the extracted file was removed');
  assert.ok(events.some((event) => event.phase === 'rollback' && event.status === 'started'));
  assert.ok(events.some((event) => event.phase === 'rollback' && event.status === 'completed'));
});

test('receipt failure is reported as committed files, never as rolled back', async () => {
  const root = path.join(tmp, 'receipt-failure');
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, '.indiedeck'), 'blocks the receipt directory');
  let caught: (Error & { applyResult?: ApplyResult }) | undefined;
  try {
    await applyPlan(plan(root), {
      cacheDir: path.join(tmp, 'cache-receipt'),
      force: true,
    });
  } catch (err) {
    caught = err as Error & { applyResult?: ApplyResult };
  }

  assert.ok(caught?.applyResult);
  assert.equal(caught.applyResult.mutationStatus, 'committed');
  assert.equal(caught.applyResult.rollbackStatus, 'not-run');
  assert.equal(caught.applyResult.receiptStatus, 'failed');
  assert.equal(caught.applyResult.failedStep, 'Record install receipts');
  assert.deepEqual(caught.applyResult.filesWritten, ['plugin.dll']);
  assert.equal(await fsp.readFile(path.join(root, 'plugin.dll'), 'utf8'), 'installed payload');
});

test('a failed plan never claims complete rollback for tools-directory writes', async () => {
  const root = path.join(tmp, 'external-write-failure');
  const toolsDir = path.join(tmp, 'tools');
  await fsp.mkdir(root, { recursive: true });
  const toolPlan = plan(root, true);
  toolPlan.steps[1]!.dest = '$toolsDir/test-tool';
  let caught: (Error & { applyResult?: ApplyResult }) | undefined;
  try {
    await applyPlan(toolPlan, {
      cacheDir: path.join(tmp, 'cache-external'),
      toolsDir,
      force: true,
    });
  } catch (err) {
    caught = err as Error & { applyResult?: ApplyResult };
  }

  assert.ok(caught?.applyResult);
  assert.equal(caught.applyResult.mutationStatus, 'partial');
  assert.equal(caught.applyResult.rollbackStatus, 'partial');
  assert.equal(caught.applyResult.rollbackFailures[0]?.scope, 'external');
  assert.equal(fs.existsSync(path.join(toolsDir, 'test-tool/plugin.dll')), true, 'the untracked external write is disclosed');
});

test('an informational loader-reuse step completes without false user action', async () => {
  const root = path.join(tmp, 'loader-reuse');
  await fsp.mkdir(root, { recursive: true });
  const reusePlan = plan(root);
  reusePlan.steps = [
    {
      action: 'manual',
      description: 'Reuse the installed loader',
      descriptionKey: 'core.step.loader-reuse',
      details: { informational: true },
    },
  ];

  const result = await applyPlan(reusePlan);
  assert.deepEqual(result.pendingUserActions, []);
  assert.equal(result.performed[0]?.status, 'skipped');
  assert.equal(result.performed[0]?.detail, 'informational');
  assert.equal(result.mutationStatus, 'committed');
});

for (const cached of [false, true]) test(`a rejected ${cached ? 'cached' : 'fresh'} asset security gate prevents extraction, setup and config writes`, async () => {
  const root = path.join(tmp, `security-gate-${cached ? 'cache' : 'fresh'}`), cacheDir = path.join(tmp, `security-cache-${cached ? 'cache' : 'fresh'}`);
  await fsp.mkdir(root, { recursive: true });
  const original = new Map([
    ['plugin.dll', Buffer.from('previous user-owned plugin')],
    ['options.ini', Buffer.from('[General]\nLanguage=ja\nKeep=original\n')],
    ['readme.txt', Buffer.from('user notes stay unchanged')],
  ]);
  for (const [name, contents] of original) await fsp.writeFile(path.join(root, name), contents);
  const gated = plan(root);
  gated.config = { General: { Language: 'ko' } };
  gated.steps.push(
    { action: 'run', description: 'Start translator setup', details: { exe: 'not-created-setup.exe' } },
    { action: 'config', description: 'Update game options', dest: 'options.ini' },
  );
  if (cached) await downloadAsset(gated.steps[0]!.source!, { cacheDir });
  const events: ApplyProgress[] = [];
  let called = 0, caught: (Error & { applyResult?: ApplyResult }) | undefined;
  try {
    await applyPlan(gated, {
      cacheDir, allowRun: true, onEvent: (event) => events.push(event),
      beforeUseAsset: async (asset) => {
        called += 1;
        assert.equal(asset.fromCache, cached);
        assert.deepEqual(await fsp.readFile(asset.path), archive);
        assert.match(asset.sha256, /^[0-9a-f]{64}$/);
        for (const [name, contents] of original) assert.deepEqual(await fsp.readFile(path.join(root, name)), contents);
        throw new Error('ui.security.block.attention');
      },
    });
  } catch (error) { caught = error as Error & { applyResult?: ApplyResult }; }
  assert.equal(called, 1, 'cached bytes must pass the security gate again');
  assert.match(caught?.message ?? '', /ui.security.block.attention/);
  assert.equal(caught?.applyResult?.mutationStatus, 'rolled-back');
  assert.equal(caught?.applyResult?.receiptStatus, 'not-run');
  assert.deepEqual(caught?.applyResult?.filesWritten, []);
  assert.deepEqual(caught?.applyResult?.pendingUserActions, []);
  assert.equal(events.some((event) => ['extract', 'run', 'config', 'receipt'].includes(event.phase)), false);
  for (const [name, contents] of original) assert.deepEqual(await fsp.readFile(path.join(root, name)), contents);
  assert.equal(fs.existsSync(path.join(root, 'not-created-setup.exe')), false);
  assert.equal(fs.existsSync(path.join(root, '.indiedeck', 'receipts')), false);
});

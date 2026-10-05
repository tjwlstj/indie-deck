import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import { applyPlan, type ApplyProgress, type ApplyResult } from '../src/install/apply.ts';
import type { TranslatorPlan } from '../src/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-apply-progress-'));

function makeZip(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const compressed = zlib.deflateRawSync(data);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
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
let server: http.Server;
let assetUrl = '';

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.length) });
    res.end(archive);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assetUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/payload.zip`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

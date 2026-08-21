/**
 * Regressions found by the structural audit. Each test failed before its fix.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { normaliseReceipt, uninstallReceipt, writeReceipt } from '../src/install/apply.ts';
import { withTransaction } from '../src/install/transaction.ts';
import { applyIni, parseIni } from '../src/util/ini.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-reg-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeDir(name: string, files: Record<string, string> = {}): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

/* ------------------------------------------------------------------- ini */

test('inserting keys into two different sections puts each in its own section', () => {
  const source = ['[Alpha]', 'existing=1', '', '[Beta]', 'other=2', '', '[Gamma]', 'third=3', '', '[Delta]', 'fourth=4'].join(
    '\n',
  );

  // The trigger is an insertion into an earlier section shifting the recorded
  // line numbers of every later one. Three keys into Alpha shifted Gamma's
  // insertion point by three lines, which landed it inside [Beta].
  const updated = applyIni(source, {
    Gamma: { addedToGamma: 'c' },
    Alpha: { addedToAlpha: 'a', extra1: 'x', extra2: 'y' },
  });
  const parsed = parseIni(updated);

  assert.equal(parsed['Alpha']?.['addedToAlpha'], 'a');
  assert.equal(parsed['Alpha']?.['extra2'], 'y');
  assert.equal(parsed['Gamma']?.['addedToGamma'], 'c', 'the Gamma key is in Gamma');
  assert.equal(parsed['Beta']?.['addedToGamma'], undefined, 'and not in the section that follows Alpha');
  assert.equal(parsed['Alpha']?.['existing'], '1');
  assert.equal(parsed['Gamma']?.['third'], '3');
  assert.equal(parsed['Delta']?.['fourth'], '4');
});

test('a config key named __proto__ cannot reach Object.prototype', () => {
  const hostile = ['[Behaviour]', '__proto__=polluted', 'constructor=nope', 'Real=1'].join('\n');
  const parsed = parseIni(hostile);

  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'nothing was written to Object.prototype');
  assert.equal(parsed['Behaviour']?.['Real'], '1', 'the rest of the section still parses');
  // The dangerous keys are either dropped or held as own properties - never
  // applied to the prototype chain.
  assert.equal(Object.getPrototypeOf(parsed['Behaviour'] ?? {}), null);
});

/* ----------------------------------------------------------- transaction */

test('writing the same file twice keeps the pristine backup, not the intermediate', async () => {
  const root = makeDir('tx-double-write', { 'config.ini': 'ORIGINAL' });

  const { entries } = await withTransaction({ root, backupDir: '.indiedeck/backups' }, async (tx) => {
    await tx.write('config.ini', 'FIRST PASS');
    await tx.write('config.ini', 'SECOND PASS');
    return undefined;
  });

  const backups = entries.filter((e) => e.path === 'config.ini' && e.backup);
  assert.ok(backups.length > 0, 'a backup was recorded');
  for (const entry of backups) {
    assert.equal(
      await fsp.readFile(path.join(root, entry.backup!), 'utf8'),
      'ORIGINAL',
      'every recorded backup still holds the file as it was before the transaction',
    );
  }
});

test('rollback after two writes to one file restores the original', async () => {
  const root = makeDir('tx-double-rollback', { 'config.ini': 'ORIGINAL' });

  await assert.rejects(() =>
    withTransaction({ root, backupDir: '.indiedeck/backups' }, async (tx) => {
      await tx.write('config.ini', 'FIRST PASS');
      await tx.write('config.ini', 'SECOND PASS');
      throw new Error('boom');
    }),
  );

  assert.equal(await fsp.readFile(path.join(root, 'config.ini'), 'utf8'), 'ORIGINAL');
});

/* --------------------------------------------------------------- receipts */

test('a receipt cannot delete outside the game folder', async () => {
  const root = makeDir('receipt-escape', {});
  const outside = path.join(tmp, 'receipt-escape-victim.txt');
  await fsp.writeFile(outside, 'do not delete me');

  const hostile = {
    id: 'hostile',
    schemaVersion: 2,
    gamePath: root,
    kind: 'mod' as const,
    componentId: 'Hostile',
    version: '1',
    installedAt: new Date(0).toISOString(),
    entries: [
      { path: '../receipt-escape-victim.txt', operation: 'create' as const },
      { path: 'C:/Windows/System32/nope.dll', operation: 'create' as const },
    ],
  };

  const result = await uninstallReceipt(hostile);
  assert.equal(fs.existsSync(outside), true, 'the file outside the game folder survives');
  assert.deepEqual(result.removed, [], 'nothing outside the root is reported as removed');
});

test('a receipt whose gamePath was tampered with is ignored in favour of the folder it was read from', async () => {
  const root = makeDir('receipt-gamepath', {});
  await fsp.writeFile(path.join(root, 'mod.dll'), 'installed');
  const elsewhere = makeDir('receipt-gamepath-other', {});
  await fsp.writeFile(path.join(elsewhere, 'mod.dll'), 'someone elses file');

  const receipt = await writeReceipt(root, {
    kind: 'mod',
    componentId: 'Thing',
    version: '1',
    entries: [{ path: 'mod.dll', operation: 'create' }],
  });

  // Simulate the receipt being edited on disk to point at another folder.
  await uninstallReceipt({ ...receipt, gamePath: elsewhere }, { root });

  assert.equal(fs.existsSync(path.join(elsewhere, 'mod.dll')), true, 'the other folder is untouched');
  assert.equal(fs.existsSync(path.join(root, 'mod.dll')), false, 'the real folder is cleaned');
});

test('normaliseReceipt drops entries that escape the root', () => {
  const clean = normaliseReceipt({
    id: 'x',
    gamePath: 'C:/games/Demo',
    kind: 'mod',
    componentId: 'x',
    version: '1',
    installedAt: '',
    entries: [],
    files: ['ok.dll', '../escape.dll', 'C:/absolute.dll', 'nested/fine.dll'],
    backups: [],
  });

  assert.deepEqual(
    clean.entries.map((e) => e.path),
    ['ok.dll', 'nested/fine.dll'],
  );
});

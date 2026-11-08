import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const { hasMagic } = require('app-builder-lib/out/util/filter');

test('electron-builder file filtering preserves inclusion, exclusion and partial directory matching', () => {
  const root = path.join(os.tmpdir(), 'indiedeck-builder-pattern-fixture');
  const matcher = new FileMatcher(root, root, (value: string) => value,
    ['**/*', '!**/*.map', '!secrets/**', '!**/*.test.js']);
  const filter = matcher.createFilter();
  const accepted = (name: string, directory = false) =>
    filter(path.join(root, ...name.split('/')), { isDirectory: () => directory });
  assert.equal(accepted('app/main.js'), true);
  assert.equal(accepted('app/.settings'), true, 'builder uses dot: true');
  assert.equal(accepted('app/main.js.map'), false);
  assert.equal(accepted('app/main.test.js'), false);
  assert.equal(accepted('secrets/key.txt'), false);
  assert.equal(accepted('node_modules', true), false, 'root dependencies are handled separately');

  // FileMatcher converts Windows-style pattern separators even on POSIX hosts.
  const selected = new FileMatcher(root, root, (value: string) => value, ['assets\\sprites']);
  const selectedFilter = selected.createFilter();
  const selectedEntry = (name: string, directory = false) =>
    selectedFilter(path.join(root, ...name.split('/')), { isDirectory: () => directory });
  assert.equal(selectedEntry('assets', true), true, 'parent directory must be traversable');
  assert.equal(selectedEntry('assets/sprites/avatar.png'), true);
  assert.equal(selectedEntry('assets/other/avatar.png'), false);
  const parsed: unknown[] = [];
  selected.computeParsedPatterns(parsed);
  assert.ok(parsed.some((pattern: any) => hasMagic(pattern)), 'directory pattern includes descendants');
});

test('electron universal matcher keeps basename and allowlist behavior', () => {
  const universalRequire = createRequire(require.resolve('@electron/universal'));
  const { minimatch } = universalRequire('minimatch');
  assert.equal(minimatch('assets/arm-only.node', '*.node', { matchBase: true }), true);
  assert.equal(minimatch('assets/arm-only.dll', '*.node', { matchBase: true }), false);
  assert.equal(minimatch('assets/.private.node', '*.node', { matchBase: true }), false);
  assert.equal(minimatch('assets/arm-only.node', '!*.node', { matchBase: true }), false);
});

test('electron universal ASAR merger honors its single-architecture allowlist', {
  skip: process.platform === 'win32' ? 'Upstream merger expects POSIX archive paths; exercised on Linux CI.' : false,
}, async () => {
  const universalEntry = require.resolve('@electron/universal');
  const universalRequire = createRequire(universalEntry);
  const asar = universalRequire('@electron/asar');
  const { mergeASARs } = universalRequire('./asar-utils.js');
  const tempRoot = path.resolve(os.tmpdir());
  const fixture = await fs.mkdtemp(path.join(tempRoot, 'indiedeck-builder-compat-'));
  try {
    const x64Dir = path.join(fixture, 'x64'), armDir = path.join(fixture, 'arm64');
    for (const directory of [x64Dir, armDir]) {
      await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
      await fs.writeFile(path.join(directory, 'assets', 'common.txt'), 'same harmless content');
    }
    await fs.writeFile(path.join(armDir, 'assets', 'arm-only.node'), 'synthetic unique file');
    const x64 = path.join(fixture, 'x64.asar'), arm = path.join(fixture, 'arm.asar');
    await asar.createPackage(x64Dir, x64);
    await asar.createPackage(armDir, arm);
    const output = path.join(fixture, 'merged.asar');
    await assert.rejects(() => mergeASARs({ x64AsarPath: x64, arm64AsarPath: arm,
      outputAsarPath: output, singleArchFiles: '*.dll' }), /not covered by/);
    await mergeASARs({ x64AsarPath: x64, arm64AsarPath: arm,
      outputAsarPath: output, singleArchFiles: '*.node' });
    assert.equal(asar.extractFile(output, 'assets/arm-only.node').toString(), 'synthetic unique file');
    assert.equal(asar.extractFile(output, 'assets/common.txt').toString(), 'same harmless content');
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), tempRoot);
    assert.ok(path.basename(fixture).startsWith('indiedeck-builder-compat-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

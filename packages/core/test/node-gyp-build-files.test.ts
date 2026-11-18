import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const fromRebuild = createRequire(require.resolve('@electron/rebuild'));
const fromGyp = createRequire(fromRebuild.resolve('node-gyp/package.json'));

test('the installed node-gyp uses exactly the two supported Windows lookups', async () => {
  assert.equal(fromGyp('./package.json').version, '12.4.0');
  assert.equal(fromGyp('tinyglobby/package.json').name, '@indiedeck/node-gyp-build-files');
  const source = await fs.readFile(fromGyp.resolve('./lib/build.js'), 'utf8');
  assert.match(source, /const \{ glob \} = require\('tinyglobby'\)/);
  const calls = [...source.matchAll(/\bglob\(([^)\r\n]+)\)/g)].map(match => match[1]);
  assert.deepEqual(calls, [
    "'build/*.sln', { expandDirectories: false }",
    "'build/*.mk', { expandDirectories: false }",
  ]);
});

test('node-gyp finds immediate non-hidden solution and make files', async () => {
  const { glob } = fromGyp('tinyglobby');
  const previous = process.cwd();
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'indiedeck-build-files-'));
  try {
    process.chdir(fixture);
    const options = { expandDirectories: false };
    assert.deepEqual(await glob('build/*.sln', options), []);
    await fs.mkdir('build/nested.sln', { recursive: true });
    for (const file of ['binding.sln', 'with space.sln', '.hidden.sln', 'upper.SLN', 'binding.mk', 'nested.sln/sub.sln']) {
      await fs.writeFile(path.join('build', file), '');
    }
    const expected = ['build/binding.sln', 'build/with space.sln'];
    if (process.platform !== 'win32') {
      await fs.symlink('binding.sln', 'build/linked.sln');
      await fs.symlink('missing.sln', 'build/dangling.sln');
      expected.push('build/linked.sln');
    }
    assert.deepEqual((await glob('build/*.sln', options)).sort(), expected.sort());
    assert.deepEqual(await glob('build/*.mk', options), ['build/binding.mk']);
    await assert.rejects(glob('**/*.sln', options), /Unsupported/);
    await assert.rejects(glob('build/*.sln', { cwd: fixture }), /Unsupported/);
  } finally {
    process.chdir(previous);
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('Electron rebuild compiles and loads an optional native addon on Windows', {
  skip: process.env.INDIEDECK_NATIVE_REBUILD_CI !== '1',
  timeout: 5 * 60_000,
}, async () => {
  assert.equal(process.platform, 'win32');
  const { rebuild } = await import('@electron/rebuild');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'indiedeck-native-'));
  const moduleName = 'indiedeck-native-probe';
  const modulePath = path.join(fixture, 'node_modules', moduleName);
  try {
    await fs.mkdir(modulePath, { recursive: true });
    await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({
      name: 'indiedeck-native-app', version: '1.0.0', optionalDependencies: { [moduleName]: '1.0.0' },
    }));
    await fs.writeFile(path.join(modulePath, 'package.json'), JSON.stringify({
      name: moduleName, version: '1.0.0', main: './build/Release/probe.node', gypfile: true,
    }));
    await fs.writeFile(path.join(modulePath, 'binding.gyp'), JSON.stringify({
      targets: [{ target_name: 'probe', sources: ['probe.cc'] }],
    }));
    await fs.writeFile(path.join(modulePath, 'probe.cc'), [
      '#include <node_api.h>',
      'NAPI_MODULE_INIT() {',
      '  napi_value value;',
      '  napi_create_int32(env, 42, &value);',
      '  napi_set_named_property(env, exports, "value", value);',
      '  return exports;',
      '}',
    ].join('\n'));
    await rebuild({
      buildPath: fixture, projectRootPath: fixture,
      electronVersion: require('electron/package.json').version,
      buildFromSource: true, types: ['optional'],
    });
    const result = spawnSync(require('electron'), [
      '-e', 'process.exitCode = require(process.argv[1]).value === 42 ? 0 : 1', modulePath,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

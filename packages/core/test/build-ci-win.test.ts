import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { makeBuilderOptions, parseBuilderArgs, sanitizedBuilderEnvironment } from '../../../scripts/build-ci-win.mjs';

test('a builder failure remains nonzero through earlier shutdown listeners', () => {
  const script = new URL('../../../scripts/build-ci-win.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { reportBuildFailure } from ${JSON.stringify(script)}; process.on('exit', () => {process.exitCode = 0}); reportBuildFailure(new Error('synthetic failure'));`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
});

const require = createRequire(import.meta.url);
const version = '43.8.7';
const filename = `electron-v${version}-win32-x64.zip`;
const bytes = Buffer.from('synthetic electron fixture');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
function input() {
  return { environment: { GITHUB_ACTIONS: 'true' }, platform: 'win32', arch: 'x64',
    rootManifest: { devDependencies: { electron: version } }, electronManifest: { version },
    lockfile: { packages: { '': { devDependencies: { electron: version } }, 'node_modules/electron': { version } } },
    checksums: { [filename]: digest }, yamlConfig: { appId: 'fixture' } };
}

test('CI builder uses pinned checksums and preserves target and publish restrictions', () => {
  const options = makeBuilderOptions(input());
  assert.deepEqual(options.win, ['nsis', 'portable']);
  assert.equal(options.x64, true);
  assert.equal(options.publish, 'never');
  assert.deepEqual(options.config.electronDownload, { force: false, checksums: { [filename]: digest } });
  assert.equal('mirrorOptions' in options.config.electronDownload, false);
  assert.equal('unsafelyDisableChecksums' in options.config.electronDownload, false);
  for (const overrides of [
    { environment: {} }, { platform: 'linux' }, { arch: 'arm64' },
    { electronManifest: { version: '1.0.0' } }, { checksums: {} },
    { lockfile: { packages: {} } }, { yamlConfig: { electronDownload: { mirrorOptions: {} } } },
    { yamlConfig: { electronDist: '/elsewhere' } }, { yamlConfig: { electronVersion: '1.0.0' } },
  ]) assert.throws(() => makeBuilderOptions({ ...input(), ...overrides }));
});

test('unsafe TLS and inherited Electron download mirrors cannot affect the CI child', () => {
  assert.throws(() => sanitizedBuilderEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /TLS/);
  const safe = sanitizedBuilderEnvironment({ PATH: 'preserve', GITHUB_ACTIONS: 'true', NODE_OPTIONS: 'synthetic',
    ELECTRON_MIRROR: 'https://not-used.invalid', npm_config_electron_customdir: 'other',
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR: 'https://not-used.invalid', ELECTRON_BUILDER_BINARIES_ALLOW_HTTP: 'true' });
  assert.deepEqual(safe, { PATH: 'preserve', GITHUB_ACTIONS: 'true' });
});

test('runtime-only CI mode creates only a Windows directory target with identical pinned hashes', () => {
  assert.deepEqual(parseBuilderArgs([]), { runtimeOnly: false });
  assert.deepEqual(parseBuilderArgs(['--runtime-only']), { runtimeOnly: true });
  for (const args of [['--publish', 'always'], ['--runtime-only', '--runtime-only'], ['--runtime-only=1'], ['dir'], [null]]) {
    assert.throws(() => parseBuilderArgs(args));
  }
  const options = makeBuilderOptions({ ...input(), runtimeOnly: true });
  assert.deepEqual(options.win, []); assert.equal(options.dir, true);
  assert.equal(options.publish, 'never');
  assert.deepEqual(options.config.electronDownload.checksums, input().checksums);
  const { normalizeOptions } = require('electron-builder/out/builder.js');
  const normalized = normalizeOptions(options);
  assert.equal(normalized.targets.size, 1);
  const arches = [...normalized.targets.values()][0] as Map<unknown, string[]>;
  assert.equal(arches.size, 1);
  assert.deepEqual([...arches.values()], [['dir']]);
  assert.throws(() => makeBuilderOptions({ ...input(), runtimeOnly: '--runtime-only' }));
});

test('real builder configuration preserves YAML and accepts the checksum option', async () => {
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
  const baseline = await getConfig(process.cwd(), undefined);
  const options = makeBuilderOptions(input());
  const configured = await getConfig(process.cwd(), undefined, options.config);
  await validateConfiguration(configured, { isEnabled: false });
  assert.deepEqual(configured.electronDownload, { force: false, checksums: { [filename]: digest } });
  delete configured.electronDownload;
  assert.deepEqual(configured, baseline);
});

test('real builder download wiring validates injected bytes without requesting remote checksums', async () => {
  const out = path.resolve('out'); await fs.mkdir(out, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(out, 'indiedeck-ci-builder-'));
  const calls: string[] = [];
  try {
    const { downloadElectronArtifactZip } = require('app-builder-lib/out/util/electronGet.js');
    const result = await downloadElectronArtifactZip({ electronDownload: { force: false, checksums: { [filename]: digest },
      downloader: { download: async (url: string, destination: string) => {
        calls.push(url);
        if (!url.endsWith('/' + filename)) throw new Error('Unexpected remote checksum request.');
        await fs.writeFile(destination, bytes);
      } } }, version, platformName: 'win32', arch: 'x64', artifactName: 'electron', cacheDir: fixture });
    assert.deepEqual(await fs.readFile(result), bytes);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('/' + filename));
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), out);
    assert.ok(path.basename(fixture).startsWith('indiedeck-ci-builder-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

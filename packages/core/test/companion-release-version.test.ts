import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('release validation allows independent extension versions while requiring browser manifests to agree', async () => {
  const parent = path.resolve(os.tmpdir()), fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-release-companion-'));
  try {
    const rootVersion = '0.1.20';
    const manifests = ['package.json', 'packages/core/package.json', 'packages/cli/package.json', 'packages/desktop/package.json'];
    for (const name of manifests) {
      await fs.mkdir(path.dirname(path.join(fixture, name)), { recursive: true });
      await fs.writeFile(path.join(fixture, name), JSON.stringify({ version: rootVersion }));
    }
    await fs.mkdir(path.join(fixture, 'scripts')); await fs.copyFile(new URL('../../../scripts/check-release.mjs', import.meta.url), path.join(fixture, 'scripts/check-release.mjs'));
    await fs.writeFile(path.join(fixture, 'package-lock.json'), JSON.stringify({ version: rootVersion,
      packages: Object.fromEntries(['', 'packages/core', 'packages/cli', 'packages/desktop'].map(name => [name, { version: rootVersion }])) }));
    const folder = path.join(fixture, 'extensions/browser-companion'); await fs.mkdir(folder, { recursive: true });
    for (const name of ['manifest.json', 'manifest.firefox.json']) await fs.writeFile(path.join(folder, name), JSON.stringify({ manifest_version: 3, version: '0.2.0' }));
    const run = () => spawnSync(process.execPath, [path.join(fixture, 'scripts/check-release.mjs'), 'v' + rootVersion], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(run().status, 0);
    await fs.writeFile(path.join(folder, 'manifest.firefox.json'), JSON.stringify({ manifest_version: 3, version: '0.2.1' }));
    assert.equal(run().status, 1);
    await fs.writeFile(path.join(folder, 'manifest.firefox.json'), JSON.stringify({ manifest_version: 3, version: '0.2.0' }));
    await fs.writeFile(path.join(fixture, 'packages/core/package.json'), JSON.stringify({ version: '0.1.19' }));
    assert.equal(run().status, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-release-companion-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

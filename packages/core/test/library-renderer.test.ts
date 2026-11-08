import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('favorites, sorting and same-name candidate controls persist across renderer processes', {
  skip: process.env.GITHUB_ACTIONS !== 'true' ? 'Isolated GitHub CI fixture only.' : false,
  timeout: 30_000,
}, async () => {
  const parent = path.resolve(os.tmpdir());
  const fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-library-ui-'));
  const script = fileURLToPath(new URL('../../../scripts/library-renderer-fixture.mjs', import.meta.url));
  const run = (phase: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', script, fixture, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16_384); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-16_384); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${phase} failed: ${output}`)));
  });
  try {
    await run('write');
    await run('reload');
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-library-ui-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

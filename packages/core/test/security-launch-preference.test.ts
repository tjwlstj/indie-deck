import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, saveConfig } from '../src/library/index.ts';
import { scanLaunchTarget } from '../../desktop/src/security-launch-policy.ts';

test('launch scanning defaults on, persists an explicit choice, and treats malformed values as on', async () => {
  const base = path.resolve('out');
  await fs.mkdir(base, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(base, 'launch-scan-config-'));
  try {
    const initial = await loadConfig(fixture);
    assert.equal(initial.scanOnLaunch, true);
    await saveConfig({ ...initial, scanOnLaunch: false }, fixture);
    assert.equal((await loadConfig(fixture)).scanOnLaunch, false);
    const raw = JSON.parse(await fs.readFile(path.join(fixture, 'config.json'), 'utf8'));
    raw.scanOnLaunch = 'false';
    await fs.writeFile(path.join(fixture, 'config.json'), JSON.stringify(raw));
    assert.equal((await loadConfig(fixture)).scanOnLaunch, true);
  } finally {
    assert.equal(path.dirname(fixture), base);
    assert.ok(path.basename(fixture).startsWith('launch-scan-config-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('only explicit off skips the launch scan and scan errors still block launch', async () => {
  let calls = 0;
  const scan = async () => { calls += 1; };
  await scanLaunchTarget(false, scan);
  assert.equal(calls, 0);
  for (const value of [true, undefined, null, 'false', 0]) await scanLaunchTarget(value, scan);
  assert.equal(calls, 5);
  await assert.rejects(() => scanLaunchTarget(true, async () => { throw new Error('scan rejected'); }), /scan rejected/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FsProbe } from '../src/util/fsx.ts';

test('a differently-cased directory lookup cannot poison the probe cache', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-fsprobe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'System.json'), '{"gameTitle":"Old School"}');

  const probe = new FsProbe(root);
  assert.deepEqual(probe.namesIn('Data'), ['System.json']);
  assert.equal(path.basename(probe.list('Data').dir), 'data');
  assert.equal(probe.readText('data/System.json'), '{"gameTitle":"Old School"}');
});

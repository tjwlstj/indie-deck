import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { readGamingPreferences, saveGamingPreferences } from '../../desktop/src/gaming-preferences.ts';

test('gaming preferences persist explicit choices and reject extra process controls', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gaming-preferences-'));
  try {
    assert.deepEqual(await readGamingPreferences(temp), { minimizeOnLaunch: true, restoreOnExit: false });
    const selected = { minimizeOnLaunch: false, restoreOnExit: true };
    await saveGamingPreferences(temp, selected);
    assert.deepEqual(await readGamingPreferences(temp), selected);
    await assert.rejects(saveGamingPreferences(temp, { ...selected, priority: 'realtime' }));
    assert.deepEqual(await readGamingPreferences(temp), selected);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('corrupt gaming preferences are preserved and never silently reset by a save', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gaming-preferences-'));
  try {
    const file = path.join(temp, 'gaming-preferences.json');
    await fs.writeFile(file, '{broken');
    await assert.rejects(readGamingPreferences(temp));
    await assert.rejects(saveGamingPreferences(temp, { minimizeOnLaunch: true, restoreOnExit: false }));
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
    await fs.writeFile(file, 'x'.repeat(4097));
    await assert.rejects(readGamingPreferences(temp));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

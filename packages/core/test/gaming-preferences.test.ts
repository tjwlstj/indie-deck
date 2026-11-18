import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { readGamingPreferences, saveGamingPreferences, clearLaunchChoice, readLaunchChoice,
  resolveGameLaunchTarget, saveLaunchChoice } from '../../desktop/src/gaming-preferences.ts';

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

test('manual executable survives fresh reads and only explicit reset returns to detection', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'indiedeck-executable-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'Game');
  const data = path.join(temp, 'settings');
  const id = '0123456789abcdef';
  const relative = path.join('bin', 'Story.exe');
  const chosen = path.join(root, relative);
  await fs.mkdir(path.dirname(chosen), { recursive: true });
  await fs.writeFile(chosen, 'inert game fixture');
  await fs.writeFile(path.join(root, 'Game.exe'), 'inert detected fixture');
  assert.equal(await readLaunchChoice(data, id), null);
  assert.equal((await resolveGameLaunchTarget(data, id, root, 'Game.exe')).relativeExecutable, 'Game.exe');
  assert.equal(await saveLaunchChoice(data, id, root, chosen), relative);
  assert.equal(await readLaunchChoice(data, '1123456789abcdef'), null);
  assert.equal((await resolveGameLaunchTarget(data, id, root)).executable, chosen);
  await fs.unlink(chosen);
  await assert.rejects(resolveGameLaunchTarget(data, id, root, 'Game.exe'), /chosenExecutableUnavailable/);
  await clearLaunchChoice(data, id);
  assert.equal((await resolveGameLaunchTarget(data, id, root, 'Game.exe')).relativeExecutable, 'Game.exe');
});

test('invalid choices cannot overwrite a saved target and malformed choices require explicit reset', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'indiedeck-executable-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'game'), data = path.join(temp, 'data'), id = '0123456789abcdef';
  await fs.mkdir(root);
  const chosen = path.join(root, 'Game.exe');
  await fs.writeFile(chosen, 'inert fixture');
  await saveLaunchChoice(data, id, root, chosen);
  for (const invalid of [path.join(temp, 'Other.exe'), path.join(root, 'Setup.exe'), path.join(root, '.indiedeck', 'Other.exe'),
    path.join(root, 'Game.cmd'), path.join(root, 'Missing.exe'), 'Game.exe']) {
    await assert.rejects(saveLaunchChoice(data, id, root, invalid));
    assert.equal(await readLaunchChoice(data, id), 'Game.exe');
  }
  const alias = path.join(root, 'Alias.exe');
  await fs.link(chosen, alias);
  await assert.rejects(saveLaunchChoice(data, id, root, alias));
  await fs.unlink(alias);
  const file = path.join(data, 'launch-choices', id + '.json');
  await fs.writeFile(file, '{invalid');
  await assert.rejects(resolveGameLaunchTarget(data, id, root, 'Game.exe'), /unreadableExecutableChoice/);
  await assert.rejects(saveLaunchChoice(data, id, root, chosen), /unreadableExecutableChoice/);
  await clearLaunchChoice(data, id);
  assert.equal(await readLaunchChoice(data, id), null);
});

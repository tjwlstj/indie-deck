import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readLibraryPreferences, saveLibraryPreferences } from '../../desktop/src/library-preferences.ts';
import { duplicateNameCounts, sortedLibraryGames } from '../../desktop/renderer/library-preferences.js';

const first = '0123456789abcdef', second = 'fedcba9876543210', third = 'aaaaaaaaaaaaaaaa';
const initial = { sort: 'name-asc' as const, favoritesOnly: false, duplicatesOnly: false, favorites: [] as string[] };

test('preferences persist independently of renderer path and serialize quick changes', async () => {
  const parent = path.resolve(os.tmpdir()), fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-library-prefs-'));
  try {
    assert.deepEqual(await readLibraryPreferences(fixture), initial);
    const a = { ...initial, favorites: [first] }, b = { ...a, sort: 'favorites' as const, duplicatesOnly: true };
    await Promise.all([saveLibraryPreferences(a, fixture), saveLibraryPreferences(b, fixture)]);
    assert.deepEqual(await readLibraryPreferences(fixture), b);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixture, 'library-preferences.json'), 'utf8')), b);
    assert.throws(() => saveLibraryPreferences({ ...b, favorites: ['../arbitrary'] }, fixture), /Invalid/);
    assert.deepEqual(await readLibraryPreferences(fixture), b);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-library-prefs-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('invalid preference storage is preserved and never overwritten', async () => {
  const parent = path.resolve(os.tmpdir()), fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-library-prefs-'));
  try {
    const file = path.join(fixture, 'library-preferences.json');
    await fs.writeFile(file, '{damaged data');
    await assert.rejects(() => readLibraryPreferences(fixture), /Invalid/);
    await assert.rejects(() => saveLibraryPreferences(initial, fixture), /Invalid/);
    assert.equal(await fs.readFile(file, 'utf8'), '{damaged data');
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-library-prefs-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('same-name candidates and sorting never merge entries or invent game versions', () => {
  const games = [
    { id: first, name: 'Demo', path: 'C:/A/Demo', engineName: 'Unity', installedTranslators: [] },
    { id: second, name: ' demo  ', path: 'C:/B/Demo', engineName: 'RPG Maker', installedTranslators: [{ translatorId: 'test' }] },
    { id: third, name: 'Other', path: 'C:/C/Other', engineName: 'Unity', installedTranslators: [] },
  ];
  const duplicates = duplicateNameCounts(games);
  assert.equal(duplicates.get(first), 2);
  assert.equal(duplicates.get(second), 2);
  assert.equal(duplicates.has(third), false);
  const favoriteSorted = sortedLibraryGames(games, { ...initial, sort: 'favorites', favorites: [third] }, duplicates);
  assert.equal(favoriteSorted[0]?.id, third);
  const translatedSorted = sortedLibraryGames(games, { ...initial, sort: 'translated' }, duplicates);
  assert.equal(translatedSorted[0]?.id, second);
  assert.equal(sortedLibraryGames(games, { ...initial, sort: 'duplicates' }, duplicates).at(-1)?.id, third);
  assert.equal(new Set(favoriteSorted.map((game) => game.id)).size, games.length);
  assert.equal(games[0]?.id, first, 'sorting must not mutate the library');
});

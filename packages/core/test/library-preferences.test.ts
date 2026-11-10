import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readLibraryPreferences, saveLibraryPreferences, defaultLibraryPreferences } from '../../desktop/src/library-preferences.ts';
import {
  duplicateNameCounts, sortedLibraryGames, defaultLibraryPreferences as rendererDefaults, normaliseLibraryPreferences,
  gameLibrarySettings, filterLibraryGames,
} from '../../desktop/renderer/library-preferences.js';

const first = '0123456789abcdef', second = 'fedcba9876543210', third = 'aaaaaaaaaaaaaaaa';
const initial = defaultLibraryPreferences();
const legacy = { sort: 'name-asc' as const, favoritesOnly: false, duplicatesOnly: false, favorites: [] as string[] };

test('legacy preferences gain display defaults in memory without rewriting their existing file', async () => {
  const parent = path.resolve(os.tmpdir()), fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-library-prefs-'));
  try {
    const file = path.join(fixture, 'library-preferences.json'), bytes = JSON.stringify(legacy);
    await fs.writeFile(file, bytes);
    assert.deepEqual(await readLibraryPreferences(fixture), initial);
    assert.deepEqual(normaliseLibraryPreferences(legacy), initial);
    assert.deepEqual(rendererDefaults(), initial);
    assert.equal(await fs.readFile(file, 'utf8'), bytes, 'reading an older file must not migrate it on disk');
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-library-prefs-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

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

test('explicit game labels, list-image suppression and filter choices persist without retaining input aliases', async () => {
  const parent = path.resolve(os.tmpdir()), fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-library-prefs-'));
  try {
    const stores = ['itch', 'dlsite'];
    const input = { ...initial, previewMode: 'context', adultFilter: 'exclude', purchaseFilter: 'dlsite', gameSettings: {
      [first]: { hideThumbnail: true, adult: 'adult', purchaseStores: stores }, [second]: { adult: 'general' },
    } };
    const expected = normaliseLibraryPreferences(input);
    const pending = saveLibraryPreferences(input, fixture);
    stores.push('steam'); input.gameSettings[first]!.hideThumbnail = false;
    assert.deepEqual(await pending, expected);
    const read = await readLibraryPreferences(fixture);
    assert.deepEqual(read, expected);
    assert.deepEqual(read.gameSettings[second], { hideThumbnail: false, adult: 'general', purchaseStores: [] });
    const setting = gameLibrarySettings(read, first); setting.purchaseStores.push('other');
    assert.deepEqual(read.gameSettings[first]?.purchaseStores, ['itch', 'dlsite']);
    assert.deepEqual(gameLibrarySettings(read, third), { hideThumbnail: false, adult: 'unclassified', purchaseStores: [] });
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-library-prefs-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('new preference validation rejects hidden fields, invalid labels, duplicate stores and excessive metadata before creating storage', async () => {
  const parent = path.resolve(os.tmpdir()), fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-library-prefs-'));
  try {
    const data = path.join(fixture, 'not-created');
    const invalid = [
      { ...initial, arbitraryUrl: 'https://private.invalid/' }, { ...initial, previewMode: 'automatic-download' },
      { ...initial, adultFilter: 'guess' }, { ...initial, purchaseFilter: 'https://private.invalid/' },
      { ...initial, gameSettings: null }, { ...initial, gameSettings: [] },
      { ...initial, gameSettings: { '../outside': { hideThumbnail: true } } },
      ...[{ adult: '18+' }, { adult: null }, { hideThumbnail: 1 }, { purchaseStores: ['dlsite', 'dlsite'] },
        { purchaseStores: ['unknown'] }, { purchaseStores: 'steam' }, { path: 'C:/outside.exe' }, new Date()]
        .map(setting => ({ ...initial, gameSettings: { [first]: setting } })),
      { ...initial, gameSettings: Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [index.toString(16).padStart(16, '0'), {}])) },
    ];
    for (const value of invalid) {
      assert.throws(() => saveLibraryPreferences(value, data), /Invalid/);
      assert.throws(() => normaliseLibraryPreferences(value), /Invalid/);
    }
    await assert.rejects(fs.stat(data), { code: 'ENOENT' });
    const file = path.join(fixture, 'library-preferences.json');
    await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    await assert.rejects(readLibraryPreferences(fixture), /Unsafe/);
    await assert.rejects(saveLibraryPreferences(initial, fixture), /Unsafe/);
    assert.equal((await fs.stat(file)).size, 2 * 1024 * 1024 + 1);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-library-prefs-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('linked preference directories and hardlinked files cannot redirect label reads or writes', async context => {
  const parent = path.resolve(os.tmpdir()), fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-library-prefs-'));
  try {
    const outside = path.join(fixture, 'outside'), data = path.join(fixture, 'data');
    await fs.mkdir(outside); await fs.mkdir(data);
    const target = path.join(outside, 'keep.json'), bytes = JSON.stringify(initial);
    await fs.writeFile(target, bytes);
    try { await fs.link(target, path.join(data, 'library-preferences.json')); }
    catch { context.skip('Host does not support file hardlinks'); return; }
    await assert.rejects(readLibraryPreferences(data), /Unsafe/);
    await assert.rejects(saveLibraryPreferences(initial, data), /Unsafe/);
    assert.equal(await fs.readFile(target, 'utf8'), bytes);
    const link = path.join(fixture, 'linked');
    try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { context.skip('Host does not support directory links'); return; }
    await assert.rejects(readLibraryPreferences(link), /Unsafe/);
    await assert.rejects(saveLibraryPreferences(initial, link), /Unsafe/);
    assert.equal(await fs.readFile(target, 'utf8'), bytes);
    assert.deepEqual(await fs.readdir(outside), ['keep.json']);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-library-prefs-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('adult and purchase filters use only explicit per-game metadata, including unclassified and multi-store copies', () => {
  const games = [
    { id: first, name: 'A', path: 'C:/DLsite/R18/A', provider: 'dlsite', adult: true },
    { id: second, name: 'B', storeLinks: [{ provider: 'steam' }] },
    { id: third, name: 'C', purchasedAt: 'gog' },
  ];
  assert.deepEqual(filterLibraryGames(games, { ...initial, adultFilter: 'only' }), [], 'names, paths and store links cannot label content');
  assert.deepEqual(filterLibraryGames(games, { ...initial, purchaseFilter: 'dlsite' }), [], 'a linked site is not a purchase assertion');
  const preferences = { ...initial, gameSettings: {
    [first]: { adult: 'adult', hideThumbnail: true, purchaseStores: ['dlsite', 'itch'] },
    [second]: { adult: 'general', hideThumbnail: false, purchaseStores: ['steam'] },
  } };
  const ids = (options: Record<string, unknown>) => filterLibraryGames(games, { ...preferences, ...options }).map((game: { id: string }) => game.id);
  assert.deepEqual(ids({ adultFilter: 'all' }), [first, second, third]);
  assert.deepEqual(ids({ adultFilter: 'exclude' }), [second, third]);
  assert.deepEqual(ids({ adultFilter: 'only' }), [first]);
  assert.deepEqual(ids({ adultFilter: 'unclassified' }), [third]);
  assert.deepEqual(ids({ purchaseFilter: 'itch' }), [first]);
  assert.deepEqual(ids({ purchaseFilter: 'dlsite' }), [first]);
  assert.deepEqual(ids({ purchaseFilter: 'unassigned' }), [third]);
  assert.deepEqual(ids({ adultFilter: 'exclude', purchaseFilter: 'dlsite' }), []);
  assert.equal(games[0]?.adult, true, 'filtering must not mutate detected profile data');
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

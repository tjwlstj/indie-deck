import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { readThumbnailPreferences, saveThumbnailPreference } from '../../desktop/src/thumbnail-preferences.ts';
import { fetchSteamCover, getGameThumbnail } from '../../desktop/src/thumbnails.ts';
import { createThumbnailLoader } from '../../desktop/renderer/thumbnail-model.js';

const parent = path.resolve(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(parent, 'indiedeck-thumb-integration-'));
after(() => {
  assert.equal(path.dirname(fixture), parent);
  assert.ok(path.basename(fixture).startsWith('indiedeck-thumb-integration-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});
const first = '0123456789abcdef', second = 'fedcba9876543210';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=', 'base64');

test('selected official image persists across reads, is scoped by game, and refresh cannot restore an older choice', async () => {
  const dataDir = path.join(fixture, 'saved');
  const fetches: string[] = [];
  const mockFetch = (async (input: string | URL | Request) => {
    fetches.push(String(input)); return new Response(png);
  }) as typeof fetch;
  const preferred = await fetchSteamCover('440', { fetch: mockFetch });
  assert.ok(preferred);
  await saveThumbnailPreference(dataDir, first, '440');
  await saveThumbnailPreference(dataDir, second, '570');
  assert.deepEqual([...await readThumbnailPreferences(dataDir)], [[first, '440'], [second, '570']]);
  assert.deepEqual(fetches, ['https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg']);

  let finishOld: (value: unknown) => void = () => {};
  const loader = createThumbnailLoader(() => new Promise((resolve) => { finishOld = resolve; }));
  const staleLoad = loader.load(first);
  await Promise.resolve();
  assert.deepEqual(loader.prime(first, preferred), preferred);
  finishOld({ source: 'local', dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal((await staleLoad).current, false);
  assert.deepEqual((await loader.load(first)).value, preferred);
  assert.equal((await readThumbnailPreferences(dataDir)).get(first), '440');
});

test('damaged preference data is preserved when a replacement is attempted', async () => {
  const dataDir = path.join(fixture, 'damaged'); await fsp.mkdir(dataDir);
  const target = path.join(dataDir, 'thumbnail-preferences.json');
  const damaged = '{ incomplete user selection'; await fsp.writeFile(target, damaged);
  await assert.rejects(readThumbnailPreferences(dataDir));
  await assert.rejects(saveThumbnailPreference(dataDir, first, '440'));
  assert.equal(await fsp.readFile(target, 'utf8'), damaged);
  assert.deepEqual(await fsp.readdir(dataDir), ['thumbnail-preferences.json']);
});

test('invalid opaque ids and injected app IDs cannot create thumbnail preference files', async () => {
  const dataDir = path.join(fixture, 'invalid');
  for (const [id, appId] of [['../game', '440'], [first, '../440'], [first, '440?evil'], [first, '0']]) {
    await assert.rejects(saveThumbnailPreference(dataDir, id!, appId!), /Invalid thumbnail selection/);
  }
  await assert.rejects(fsp.stat(dataDir), { code: 'ENOENT' });
});

test('GOG selection preserves legacy Steam entries and remains scoped after restart and replacement', async () => {
  const dataDir = path.join(fixture, 'providers'); await fsp.mkdir(dataDir);
  const file = path.join(dataDir, 'thumbnail-preferences.json');
  const hash = 'a'.repeat(64), gog = `gog:1234567890:${hash}`;
  await fsp.writeFile(file, JSON.stringify({ [first]: '440', [second]: '570' }));
  assert.equal((await readThumbnailPreferences(dataDir)).get(first), '440');
  await saveThumbnailPreference(dataDir, first, gog);
  assert.deepEqual([...await readThumbnailPreferences(dataDir)], [[first, gog], [second, '570']]);
  const stored = await fsp.readFile(file, 'utf8');
  for (const bad of [`gog:1:https://evil.test/${hash}`, `gog:../1:${hash}`, `gog:1:${hash}?x`, `gog:1:${hash.toUpperCase()}`]) {
    await assert.rejects(saveThumbnailPreference(dataDir, first, bad), /Invalid thumbnail selection/);
  }
  assert.equal(await fsp.readFile(file, 'utf8'), stored);
  await saveThumbnailPreference(dataDir, first, '440');
  assert.deepEqual([...await readThumbnailPreferences(dataDir)], [[first, '440'], [second, '570']]);
});

test('offline store fallback leaves game files untouched after a saved preference exists', async () => {
  const gameDir = path.join(fixture, 'offline-game'), dataDir = path.join(fixture, 'offline-data');
  await fsp.mkdir(gameDir); await fsp.writeFile(path.join(gameDir, 'steam_appid.txt'), '440');
  await saveThumbnailPreference(dataDir, first, '440');
  const before = await fsp.readdir(gameDir);
  const offline = (async () => { throw new Error('offline fixture'); }) as typeof fetch;
  assert.equal(await fetchSteamCover((await readThumbnailPreferences(dataDir)).get(first)!, { fetch: offline }), null);
  assert.equal(await getGameThumbnail(gameDir, { fetch: offline }), null);
  assert.deepEqual(await fsp.readdir(gameDir), before);
  assert.equal((await readThumbnailPreferences(dataDir)).get(first), '440');
});

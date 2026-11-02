import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fetchSteamCover, getGameThumbnail, imageMime, searchSteamCovers } from '../../desktop/src/thumbnails.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-thumb-'));
after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=', 'base64');
const fakeFetch = (run: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(run(String(input), init))) as typeof fetch;
function directory(relative: string): string { const dir = path.join(root, relative); fs.mkdirSync(dir, { recursive: true }); return dir; }

test('local cover takes priority and never contacts a store', async () => {
  const game = directory('local');
  fs.writeFileSync(path.join(game, 'CoVeR.PNG'), png);
  fs.writeFileSync(path.join(game, 'steam_appid.txt'), '440');
  const result = await getGameThumbnail(game, { fetch: fakeFetch(() => { throw Error('unexpected network request'); }) });
  assert.equal(result?.source, 'local'); assert.ok(result?.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(result?.steamAppId, undefined);
});

test('Steam hint and official CDN use numeric app IDs only; paths and redirects cannot be injected', async () => {
  const game = directory('steam-hint'); fs.writeFileSync(path.join(game, 'steam_appid.txt'), '440\n');
  const calls: string[] = [];
  const request = fakeFetch((url, init) => {
    calls.push(url); assert.equal(init?.redirect, 'error'); return new Response(png, { status: 200 });
  });
  const result = await getGameThumbnail(game, { fetch: request });
  assert.equal(result?.source, 'steam'); assert.equal(result?.steamAppId, '440');
  assert.deepEqual(calls, ['https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg']);
  for (const id of ['../440', '440?x=1', '0', '-1', '1/../../a', '12345678901']) assert.equal(await fetchSteamCover(id, { fetch: request }), null);
  assert.equal(calls.length, 1);
});

test('Steam install manifest matches exact install directory and supports nested game builds', async () => {
  const game = directory('steam-test/steamapps/common/My Game/Release/Windows');
  fs.writeFileSync(path.join(root, 'steam-test/steamapps/appmanifest_123.acf'), '"AppState" { "appid" "123" "installdir" "My Game" }');
  fs.writeFileSync(path.join(root, 'steam-test/steamapps/appmanifest_456.acf'), '"AppState" { "appid" "456" "installdir" "Other" }');
  const result = await getGameThumbnail(game, { fetch: fakeFetch((url) => {
    assert.equal(url, 'https://cdn.cloudflare.steamstatic.com/steam/apps/123/header.jpg'); return new Response(png);
  }) });
  assert.equal(result?.steamAppId, '123');
});

test('conflicting manifests and links do not silently identify a Steam title', async (context) => {
  const game = directory('steam-conflict/steamapps/common/Same');
  for (const id of ['100','101']) fs.writeFileSync(path.join(root, `steam-conflict/steamapps/appmanifest_${id}.acf`), `"appid" "${id}" "installdir" "Same"`);
  let requests = 0;
  assert.equal(await getGameThumbnail(game, { fetch: fakeFetch(() => { requests++; return new Response(png); }) }), null);
  assert.equal(requests, 0);
  const external = path.join(root, 'external.png'), linked = path.join(game, 'cover.png'); fs.writeFileSync(external, png);
  try { fs.symlinkSync(external, linked, 'file'); }
  catch (error) { if (['EPERM','EACCES','ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip('host does not allow file symlinks'); return; } throw error; }
  assert.equal(await getGameThumbnail(game, { fetch: fakeFetch(() => { requests++; return new Response(png); }) }), null);
  assert.equal(requests, 0);
});

test('corrupt, giant or non-image data is rejected before exposing data URLs', async () => {
  assert.equal(imageMime(png), 'image/png');
  assert.equal(imageMime(Buffer.from('<svg onload="alert(1)"/>')), null);
  const giant = Buffer.from(png); giant.writeUInt32BE(9000, 16);
  assert.equal(imageMime(giant), null);
  assert.equal(await fetchSteamCover('440', { fetch: fakeFetch(() => new Response('<html>error</html>')) }), null);
  assert.equal(await fetchSteamCover('440', { fetch: fakeFetch(() => new Response(png, { headers: { 'content-length': String(3 * 1024 * 1024) } })) }), null);
});

test('explicit store search is bounded, returns names and IDs only, and does not fetch images', async () => {
  const requests: string[] = [];
  const request = fakeFetch((url, init) => {
    requests.push(url); assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({ items: [{ id: 440, name: 'Team Fortress 2', tiny_image: 'https://evil.test/x' },
      { id: '440', name: 'duplicate' }, { id: '../oops', name: 'invalid' }, { id: 570, name: '<img src=x>' }] }));
  });
  assert.deepEqual(await searchSteamCovers('Team Fortress', { fetch: request }), [{ appId: '440', name: 'Team Fortress 2' }, { appId: '570', name: '<img src=x>' }]);
  assert.equal(new URL(requests[0]!).hostname, 'store.steampowered.com');
  assert.equal(new URL(requests[0]!).searchParams.get('term'), 'Team Fortress');
  assert.deepEqual(await searchSteamCovers('a', { fetch: request }), []);
  assert.deepEqual(await searchSteamCovers('test\nheader', { fetch: request }), []);
  assert.equal(requests.length, 1);
});

test('offline or failed official requests quietly fall back without writing to game folders', async () => {
  const game = directory('offline'); await fsp.writeFile(path.join(game, 'steam_appid.txt'), '440');
  const before = await fsp.readdir(game);
  assert.equal(await getGameThumbnail(game, { fetch: fakeFetch(() => { throw Error('offline'); }) }), null);
  assert.deepEqual(await fsp.readdir(game), before);
  await assert.rejects(searchSteamCovers('offline game', { fetch: fakeFetch(() => new Response('', { status: 500 })) }), /unavailable/);
  await assert.rejects(searchSteamCovers('invalid response', { fetch: fakeFetch(() => new Response('not json')) }), /invalid response/);
});

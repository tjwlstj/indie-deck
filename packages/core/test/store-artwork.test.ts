import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { normalizeArtworkUrl, downloadStoreArtwork, createStoreArtworkPreviews } from '../../desktop/src/store-artwork.ts';
import { normalizeArtworkUrl as extensionPolicy } from '../../../extensions/browser-companion/artwork.js';
import { parseStoreLink } from '../../desktop/src/store-connections.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=', 'base64');
const steam = 'https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg';
const fixtures = [
  ['steam', '440', steam + '?t=12345'],
  ['steam', '440', 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/440/abcd/capsule_616x353.jpg?t=123'],
  ['gog', 'example_game', 'https://images.gog-statics.com/' + 'a'.repeat(64) + '.jpg'],
  ['epic', 'example-game', 'https://cdn1.epicgames.com/spt-assets/prod/game.png?h=720&w=1280&quality=medium&resize=1'],
  ['itch', 'creator/example-game', 'https://img.itch.zone/aW1nLzEyMzQ=/315x250%23c/fixture.png'],
  ['booth', '1234567', 'https://booth.pximg.net/c/620x620/uuid/i/1234567/uuid_base_resized.jpg'],
  ['dlsite', 'home:RJ123456', 'https://img.dlsite.jp/modpub/images2/work/doujin/RJ124000/RJ123456_img_main.jpg'],
];
test('extension and desktop agree on bounded public CDN policy and schema version compatibility', () => {
  for (const [provider, productId, url] of fixtures) {
    const expected = url!.split('?')[0];
    assert.equal(normalizeArtworkUrl(provider, productId, url), expected);
    assert.equal(extensionPolicy(provider, productId, url), expected);
    const link = parseStoreLink({ schemaVersion: 2, kind: 'indiedeck-store-link', provider, productId, artwork: { url } });
    assert.deepEqual(link.artwork, { url: expected });
    assert.equal(link.schemaVersion, 2);
    assert.throws(() => parseStoreLink({ ...link, schemaVersion: 1 }), /invalidLink/);
    assert.throws(() => parseStoreLink({ ...link, artwork: { url, headers: { Cookie: 'private' } } }), /invalidLink/);
    const { artwork, ...plain } = link;
    assert.throws(() => parseStoreLink(plain), /invalidLink/);
    assert.equal(parseStoreLink({ ...plain, schemaVersion: 1 }).schemaVersion, 1);
  }
});

test('artwork imports reject arbitrary hosts, signed URLs, active formats, path tricks and mismatched products', () => {
  const bad = [
    steam.replace('https:', 'http:'), steam + '#secret', steam + '#', steam + '?token=secret', steam + '?t=1&t=2',
    steam.replace('cdn.cloudflare.steamstatic.com', 'cdn.cloudflare.steamstatic.com.evil.invalid'),
    steam.replace('cdn.cloudflare.steamstatic.com', 'user:password@cdn.cloudflare.steamstatic.com'),
    steam.replace('cdn.cloudflare.steamstatic.com', 'cdn.cloudflare.steamstatic.com:443'),
    steam.replace('cdn.cloudflare.steamstatic.com', '127.0.0.1'), steam.replace('440', '441'),
    steam.replace('header.jpg', '../440/header.jpg'), steam.replace('header.jpg', '%2e%2e/header.jpg'),
    steam.replace('header.jpg', 'folder%2fheader.jpg'), steam.replace('.jpg', '.svg'),
    'file:///C:/private.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/440/' + 'x'.repeat(2048) + '.jpg',
  ];
  for (const url of bad) {
    assert.equal(normalizeArtworkUrl('steam', '440', url), null, url);
    assert.equal(extensionPolicy('steam', '440', url), null, url);
  }
  assert.equal(normalizeArtworkUrl('booth', '1234567', fixtures[5]![2]!.replace('/i/1234567/', '/i/7654321/')), null);
  assert.equal(normalizeArtworkUrl('dlsite', 'home:RJ123456', fixtures[6]![2]!.replace('_img_main', '_download')), null);
});

test('preview downloads are credential-free, bounded, no-redirect and content-checked', async () => {
  let calls = 0;
  const good: typeof fetch = async (input, init) => {
    calls += 1; assert.equal(input, steam); assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.deepEqual(init?.headers, { Accept: 'image/png,image/jpeg,image/webp' });
    return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
  };
  assert.deepEqual(await downloadStoreArtwork('steam', '440', steam + '?t=123', good), png);
  await assert.rejects(downloadStoreArtwork('steam', '440', 'http://127.0.0.1/private', good), /artwork.invalid/);
  assert.equal(calls, 1, 'invalid metadata cannot initiate a request');
  for (const response of [
    new Response('redirect', { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    new Response(png, { headers: { 'content-type': 'image/jpeg' } }),
    new Response(png, { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    new Response(Buffer.alloc(2 * 1024 * 1024 + 1)),
    new Response('not an image'),
  ]) await assert.rejects(downloadStoreArtwork('steam', '440', steam, async () => response), /artwork.unavailable/);
  await assert.rejects(downloadStoreArtwork('steam', '440', steam, async () => { throw new Error('https://private.invalid/?token=secret'); }),
    error => error instanceof Error && error.message === 'ui.stores.artwork.unavailable');
});

test('only matching unexpired preview bytes can be applied; cache is bounded and cannot refetch on apply', async () => {
  let clock = 100, calls = 0;
  const controller = createStoreArtworkPreviews({ now: () => clock, request: async () => { calls += 1; return new Response(png); } });
  const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID();
  const first = await controller.preview(a, 'steam', '440', steam);
  assert.equal(first.thumbnail.source, 'manual');
  assert.deepEqual(controller.get(a, first.previewId), png);
  assert.throws(() => controller.get(b, first.previewId), /artwork.stale/);
  const second = await controller.preview(b, 'steam', '440', steam);
  const third = await controller.preview(c, 'steam', '440', steam);
  assert.throws(() => controller.get(a, first.previewId), /artwork.stale/);
  assert.deepEqual(controller.get(c, third.previewId), png); assert.equal(calls, 3);
  const mutated = controller.get(c, third.previewId); mutated.fill(0);
  assert.deepEqual(controller.get(c, third.previewId), png);
  controller.revoke(b); assert.throws(() => controller.get(b, second.previewId), /artwork.stale/);
  clock += 300001; assert.throws(() => controller.get(c, third.previewId), /artwork.stale/);
});

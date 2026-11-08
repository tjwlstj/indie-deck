import assert from 'node:assert/strict';
import test from 'node:test';
import { createRawgArtworkExperiment } from '../../../experiments/rawg/artwork.ts';

const fakeKey = 'synthetic-rawg-test-key';
const image = 'https://media.rawg.io/media/games/abc/abc123.jpg';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=', 'base64');
const transport = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(fn(String(input), init))) as typeof fetch;

test('RAWG experiment searches only on demand and selects a returned image with attribution', async () => {
  let calls = 0;
  const instance = createRawgArtworkExperiment(fakeKey, { fetch: transport((value, init) => {
    calls += 1;
    const url = new URL(value);
    assert.equal(init?.redirect, 'error');
    if (url.hostname === 'api.rawg.io') {
      assert.equal(url.pathname, '/api/games');
      assert.equal(url.searchParams.get('key'), fakeKey);
      assert.equal(url.searchParams.get('search'), 'Test Game');
      return new Response(JSON.stringify({ results: [{ id: 12, name: 'Test Game', background_image: image }] }));
    }
    assert.equal(value, image);
    return new Response(png);
  }) });
  assert.equal(calls, 0);
  assert.equal(await instance.select('12'), null, 'a renderer-supplied ID alone has no search authority');
  assert.deepEqual(await instance.search('Test Game'), [{ id: '12', name: 'Test Game', attribution: { label: 'RAWG', href: 'https://rawg.io/' } }]);
  const result = await instance.select('12');
  assert.equal(result?.source, 'rawg');
  assert.match(result?.dataUrl ?? '', /^data:image\/png;base64,/);
  assert.deepEqual(result?.attribution, { label: 'RAWG', href: 'https://rawg.io/' });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-rawg-test-key|media\.rawg\.io/);
  assert.equal(await instance.select('99'), null);
  instance.clear(); assert.equal(await instance.select('12'), null);
  assert.equal(calls, 2);
});

test('RAWG candidates cannot introduce arbitrary or disguised image URLs', async () => {
  const urls = [
    'https://media.rawg.io.evil.invalid/media/games/abc/a.jpg',
    'https://user@media.rawg.io/media/games/abc/a.jpg',
    'https://media.rawg.io:443/media/games/abc/a.jpg',
    'http://media.rawg.io/media/games/abc/a.jpg',
    'https://127.0.0.1/media/games/abc/a.jpg',
    'https://media.rawg.io/media/games/abc/a.jpg?token=private',
    'https://media.rawg.io/media/games/abc/%2e%2e.jpg',
    'https://media.rawg.io/media/games/abc/a.svg',
  ];
  const fetchMock = transport(() => new Response(JSON.stringify({ results: urls.map((value, index) => ({ id: index + 1, name: 'Game', background_image: value })) })));
  const instance = createRawgArtworkExperiment(fakeKey, { fetch: fetchMock });
  assert.deepEqual(await instance.search('Test'), []);
  assert.equal(await instance.select('1'), null);
});

test('a server response cannot reflect the key into public candidate names', async () => {
  const instance = createRawgArtworkExperiment(fakeKey, { fetch: transport(() => new Response(JSON.stringify({
    results: [{ id: 1, name: `unsafe ${fakeKey}`, background_image: image }],
  }))) });
  assert.deepEqual(await instance.search('Test'), []);
});

test('network, JSON, and size failures never expose the API key or request URL', async () => {
  for (const fetchMock of [
    transport((url) => { throw new Error(`private request ${url}`); }),
    transport(() => new Response('{invalid')),
    transport(() => new Response('ignored', { headers: { 'content-length': '999999999' } })),
    transport(() => new Response(Buffer.alloc(512 * 1024 + 1))),
  ]) {
    const instance = createRawgArtworkExperiment(fakeKey, { fetch: fetchMock });
    await assert.rejects(() => instance.search('Test'), (error: Error) =>
      error.message === 'RAWG artwork search failed.' && !error.message.includes(fakeKey));
  }
  assert.throws(() => createRawgArtworkExperiment('bad\nkey'), /Invalid RAWG key/);
});

test('a later search invalidates earlier selections and late search responses', async () => {
  let finishFirst!: (response: Response) => void;
  let count = 0;
  const instance = createRawgArtworkExperiment(fakeKey, { fetch: transport(() => {
    count += 1;
    if (count === 1) return new Promise<Response>((resolve) => { finishFirst = resolve; });
    return new Response(JSON.stringify({ results: [{ id: 2, name: 'Later', background_image: image }] }));
  }) });
  const first = instance.search('First');
  assert.deepEqual(await instance.search('Later'), [{ id: '2', name: 'Later', attribution: { label: 'RAWG', href: 'https://rawg.io/' } }]);
  finishFirst(new Response(JSON.stringify({ results: [{ id: 1, name: 'First', background_image: image }] })));
  assert.deepEqual(await first, []);
  assert.equal(await instance.select('1'), null);
});

test('a new search invalidates an image download already in flight', async () => {
  let finishImage!: (response: Response) => void;
  let count = 0;
  const instance = createRawgArtworkExperiment(fakeKey, { fetch: transport(() => {
    count += 1;
    if (count === 1) return new Response(JSON.stringify({ results: [{ id: 1, name: 'First', background_image: image }] }));
    if (count === 2) return new Promise<Response>((resolve) => { finishImage = resolve; });
    return new Response(JSON.stringify({ results: [{ id: 2, name: 'Second', background_image: image }] }));
  }) });
  await instance.search('First');
  const selected = instance.select('1');
  await instance.search('Second');
  finishImage(new Response(png));
  assert.equal(await selected, null);
});

test('image bytes must pass the existing bounded image validation', async () => {
  let calls = 0;
  const instance = createRawgArtworkExperiment(fakeKey, { fetch: transport(() => {
    calls += 1;
    return calls === 1 ? new Response(JSON.stringify({ results: [{ id: 1, name: 'Test', background_image: image }] })) : new Response('<svg>not an image</svg>');
  }) });
  await instance.search('Test');
  assert.equal(await instance.select('1'), null);
});

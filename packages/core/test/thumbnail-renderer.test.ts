import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createThumbnailLoader, normaliseThumbnail } from '../../desktop/renderer/thumbnail-model.js';

const local = { source: 'local', dataUrl: 'data:image/png;base64,AAAA' };
const manual = { source: 'manual', dataUrl: 'data:image/png;base64,AAAA' };
const steam = { source: 'steam', dataUrl: 'data:image/jpeg;base64,AABB', steamAppId: '123' };
const gog = { source: 'gog', dataUrl: 'data:image/jpeg;base64,AABB', gogProductId: '1234567890' };

test('thumbnail presentation accepts only bounded image data from an expected source', () => {
  assert.deepEqual(normaliseThumbnail(local), local);
  assert.deepEqual(normaliseThumbnail(manual), manual);
  assert.deepEqual(normaliseThumbnail(steam), steam);
  assert.deepEqual(normaliseThumbnail(gog), gog);
  for (const bad of [null, {}, { source: 'remote', dataUrl: local.dataUrl },
    { source: 'steam', dataUrl: 'https://evil.example/tracker.png' },
    { source: 'local', dataUrl: 'data:image/svg+xml;base64,AAAA' },
    { source: 'local', dataUrl: 'data:image/png;base64,AA\nAA' }]) {
    assert.equal(normaliseThumbnail(bad), null);
  }
});

test('thumbnail lookups are deduplicated, capped and negative-cached', async () => {
  const waiting = new Map<string, (value: unknown) => void>();
  let active = 0, peak = 0, calls = 0;
  const loader = createThumbnailLoader((id: string) => {
    calls += 1; active += 1; peak = Math.max(peak, active);
    return new Promise((resolve) => waiting.set(id, (value) => { active -= 1; resolve(value); }));
  }, { concurrency: 2, limit: 3 });
  const a = loader.load('a'), duplicate = loader.load('a');
  const b = loader.load('b'), c = loader.load('c');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(peak, 2); assert.equal(a, duplicate);
  waiting.get('a')!(null); await a;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  waiting.get('b')!(local); waiting.get('c')!(steam);
  await Promise.all([b, c]);
  assert.equal((await loader.load('a')).value, null);
  assert.equal(calls, 3, 'missing image must not trigger repeated requests');
  assert.equal(peak, 2);
});

test('an explicit choice wins over a stale outstanding automatic lookup', async () => {
  let finish: (value: unknown) => void = () => {};
  const loader = createThumbnailLoader(() => new Promise((resolve) => { finish = resolve; }));
  const old = loader.load('game');
  await Promise.resolve();
  assert.deepEqual(loader.prime('game', steam), steam);
  finish(local);
  assert.equal((await old).current, false);
  assert.deepEqual((await loader.load('game')).value, steam);
});

test('hidden launcher defers new and queued automatic image work until visibility returns', async () => {
  let visible = true, calls = 0, finish: (value: unknown) => void = () => {};
  const loader = createThumbnailLoader(() => { calls += 1; return new Promise(resolve => { finish = resolve; }); },
    { concurrency: 1, canStart: () => visible });
  const first = loader.load('first'), second = loader.load('second');
  visible = false;
  await Promise.resolve(); assert.equal(calls, 0, 'hide between admission and IPC must defer the call');
  visible = true; loader.resume(); await Promise.resolve(); assert.equal(calls, 1);
  visible = false; finish(local); await first; await Promise.resolve(); assert.equal(calls, 1, 'finishing one request cannot start the hidden queued request');
  assert.deepEqual((await loader.load('first')).value, local, 'existing image remains available while hidden');
  visible = true; loader.resume(); await Promise.resolve(); assert.equal(calls, 2);
  finish(steam); await second;
});

test('a manual image selected while hidden cancels obsolete queued automatic work', async () => {
  let visible = false, calls = 0;
  const loader = createThumbnailLoader(() => { calls += 1; return local; }, { canStart: () => visible });
  const queued = loader.load('selected'); loader.prime('selected', manual);
  visible = true; loader.resume();
  assert.equal((await queued).current, false); assert.equal(calls, 0);
  assert.deepEqual((await loader.load('selected')).value, manual);
});

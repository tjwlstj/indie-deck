import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { downloadAsset } from '../src/install/download.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-dl-'));
const cacheDir = path.join(tmp, 'cache');

// A payload big enough that streaming actually streams (several chunks).
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024, 'indiedeck');
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

let server: http.Server;
let base = '';
let requests = 0;

before(async () => {
  server = http.createServer((req, res) => {
    requests += 1;
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
      return;
    }
    if (req.url === '/truncated') {
      // Claims more than it sends - the classic half-finished download.
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD.subarray(0, 1024));
      return;
    }
    if (req.url === '/tampered') {
      const evil = Buffer.concat([PAYLOAD.subarray(0, PAYLOAD.length - 4), Buffer.from('evil')]);
      res.writeHead(200, { 'content-length': String(evil.length) });
      res.end(evil);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a download with no pinned checksum still reports its hash', async () => {
  const result = await downloadAsset({ type: 'url', url: `${base}/ok` }, { cacheDir });
  assert.equal(result.integrity, 'unverified');
  assert.equal(result.sha256, PAYLOAD_SHA);
  assert.equal(result.bytes, PAYLOAD.length);
  assert.deepEqual(await fsp.readFile(result.path), PAYLOAD);
});

test('a matching pinned checksum is reported as verified', async () => {
  const result = await downloadAsset({ type: 'url', url: `${base}/ok`, sha256: PAYLOAD_SHA }, { cacheDir, force: true });
  assert.equal(result.integrity, 'verified');
});

test('a tampered payload is rejected and never lands in the cache', async () => {
  const before = fs.readdirSync(cacheDir);
  await assert.rejects(
    () => downloadAsset({ type: 'url', url: `${base}/tampered`, sha256: PAYLOAD_SHA }, { cacheDir }),
    /Checksum mismatch/,
  );
  const after = fs.readdirSync(cacheDir);
  assert.deepEqual(after, before, 'no new file was kept');
  assert.equal(
    after.some((f) => f.endsWith('.part')),
    false,
    'the partial file is cleaned up',
  );
});

test('a truncated transfer never lands in the cache', async () => {
  // The HTTP layer usually aborts a short body itself; when it does not, the
  // explicit byte-count check catches it. Either way nothing is cached, and no
  // .part file is left behind for the next run to trip over.
  await assert.rejects(() => downloadAsset({ type: 'url', url: `${base}/truncated` }, { cacheDir }));
  const entries = fs.readdirSync(cacheDir);
  assert.equal(entries.some((f) => f.includes('truncated')), false, 'nothing was cached under that name');
  assert.equal(entries.some((f) => f.endsWith('.part')), false, 'no partial file survives');
});

test('a cached file is reused without hitting the network', async () => {
  await downloadAsset({ type: 'url', url: `${base}/ok` }, { cacheDir, force: true });
  const countBefore = requests;
  const second = await downloadAsset({ type: 'url', url: `${base}/ok` }, { cacheDir });
  assert.equal(second.fromCache, true);
  assert.equal(requests, countBefore, 'no request was made');
  assert.equal(second.sha256, PAYLOAD_SHA);
});

test('a cached file that no longer matches its checksum is re-fetched', async () => {
  const first = await downloadAsset({ type: 'url', url: `${base}/ok`, sha256: PAYLOAD_SHA }, { cacheDir, force: true });
  await fsp.writeFile(first.path, Buffer.from('corrupted on disk'));
  const countBefore = requests;

  const second = await downloadAsset({ type: 'url', url: `${base}/ok`, sha256: PAYLOAD_SHA }, { cacheDir });
  assert.equal(second.fromCache, false, 'the corrupted cache entry was not trusted');
  assert.equal(second.integrity, 'verified');
  assert.ok(requests > countBefore, 'it went back to the network');
});

test('progress is reported while streaming', async () => {
  const seen: number[] = [];
  await downloadAsset(
    { type: 'url', url: `${base}/ok` },
    { cacheDir, force: true, onProgress: (received) => seen.push(received) },
  );
  assert.ok(seen.length > 0, 'onProgress fired');
  assert.equal(seen.at(-1), PAYLOAD.length, 'the last report is the full size');
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'progress is monotonic');
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { downloadAsset, resolveAssetUrl, type DownloadProgressEvent } from '../src/install/download.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-dl-'));
const cacheDir = path.join(tmp, 'cache');
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024, 'indiedeck');
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const base = 'https://builds.bepinex.dev/indiedeck-fixture';
let requests = 0;
const originalFetch = globalThis.fetch;
let fetchFixture: typeof fetch;
before(() => {
  fetchFixture = async (input) => {
    requests += 1;
    const url = String(input);
    if (url === base + '/ok') {
      let offset = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          const end = Math.min(offset + 64 * 1024, PAYLOAD.length);
          controller.enqueue(PAYLOAD.subarray(offset, end)); offset = end;
          if (offset === PAYLOAD.length) controller.close();
        },
      }), { headers: { 'content-type': 'application/zip', 'content-length': String(PAYLOAD.length) } });
    }
    if (url === base + '/truncated') return new Response(PAYLOAD.subarray(0, 1024), { headers: { 'content-length': String(PAYLOAD.length) } });
    if (url === base + '/tampered') {
      const modified = Buffer.concat([PAYLOAD.subarray(0, PAYLOAD.length - 4), Buffer.from('evil')]);
      return new Response(modified, { headers: { 'content-length': String(modified.length) } });
    }
    throw new Error('Unexpected fixture network request.');
  };
  globalThis.fetch = (input, init) => fetchFixture(input, init);
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
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

test('structured lifecycle distinguishes transfer, verification, and cache reuse', async () => {
  const networkEvents: DownloadProgressEvent[] = [];
  const source = { type: 'url' as const, url: `${base}/ok`, sha256: PAYLOAD_SHA };
  await downloadAsset(source, {
    cacheDir,
    force: true,
    onDownloadEvent: (event) => networkEvents.push(event),
  });

  assert.equal(networkEvents[0]?.phase, 'download');
  assert.equal(networkEvents[0]?.status, 'started');
  const byteEvents = networkEvents.filter((event) => event.phase === 'download' && event.status === 'progress');
  assert.ok(byteEvents.length > 0, 'network bytes are structured events');
  assert.equal(byteEvents.at(-1)?.received, PAYLOAD.length);
  assert.ok(
    networkEvents.some(
      (event) => event.phase === 'verify' && event.status === 'completed' && event.integrity === 'verified',
    ),
    'network payload verification completes explicitly',
  );

  const cachedEvents: typeof networkEvents = [];
  await downloadAsset(source, { cacheDir, onDownloadEvent: (event) => cachedEvents.push(event) });
  assert.ok(
    cachedEvents.some(
      (event) => event.phase === 'download' && event.status === 'completed' && event.fromCache === true,
    ),
    'a cache hit emits a download completion instead of disappearing',
  );
  assert.ok(
    cachedEvents.some(
      (event) =>
        event.phase === 'verify' &&
        event.status === 'completed' &&
        event.fromCache === true &&
        event.integrity === 'verified',
    ),
    'the cached file is visibly verified',
  );
});

async function withFetch<T>(mock: typeof fetch, work: () => Promise<T>): Promise<T> {
  const previous = fetchFixture; fetchFixture = mock;
  try { return await work(); } finally { fetchFixture = previous; }
}
test('unsafe asset names, credential URLs and device cache paths are rejected before transfer', async () => {
  const count = requests;
  for (const leaf of ['..%2Foutside.zip', '%2Foutside.zip', 'CON.zip', 'nul', 'payload.zip%3Asecret', 'trailing.zip.', 'a%5Cb.zip']) {
    await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/' + leaf }, { cacheDir }), /filename/);
  }
  const events: DownloadProgressEvent[] = [];
  await assert.rejects(() => downloadAsset({ type: 'url', url: 'https://user:synthetic-private@github.com/a.zip' }, { cacheDir, onDownloadEvent: (event) => events.push(event) }), /credentials/);
  assert.doesNotMatch(JSON.stringify(events), /synthetic-private/);
  for (const directory of ['\\\\?\\C:\\not-a-cache', '\\\\.\\C:\\not-a-cache']) {
    await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/ok' }, { cacheDir: directory }), /Unsafe.*cache/);
  }
  assert.equal(requests, count);
});
test('both declared and actual streamed byte excess leave no published or temporary asset', async () => {
  for (const declared of [true, false]) {
    const directory = path.join(tmp, 'size-' + declared);
    await withFetch(async () => new Response(Buffer.alloc(65), { headers: declared ? { 'content-length': '65' } : {} }), async () => {
      await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/bounded' }, { cacheDir: directory, maxBytes: 64 }), /byte limit/);
    });
    assert.deepEqual(await fsp.readdir(directory), []);
  }
});
test('stalled fetch and stalled streaming body obey the whole-transfer deadline', { timeout: 5000 }, async (context) => {
  // Advance the real production deadline only after each intended boundary is
  // reached. Filesystem scheduling must not decide which cancellation is tested.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = path.join(tmp, 'deadline');
  try {
    let reachedFetch!: () => void, fetchSignal: AbortSignal | null | undefined;
    const fetchStarted = new Promise<void>((resolve) => { reachedFetch = resolve; });
    await withFetch((_input, init) => {
      fetchSignal = init?.signal; reachedFetch();
      return new Promise<Response>(() => {});
    }, async () => {
      const cleanup = new AbortController();
      const pending = downloadAsset({ type: 'url', url: base + '/never-started' }, { cacheDir: directory, timeoutMs: 25, signal: cleanup.signal });
      const rejected = assert.rejects(pending, /timed out/);
      try {
        await fetchStarted;
        assert.ok(fetchSignal);
        context.mock.timers.tick(24); assert.equal(fetchSignal.aborted, false);
        context.mock.timers.tick(1); assert.equal(fetchSignal.aborted, true);
        await rejected;
      } finally { cleanup.abort(); await pending.catch(() => {}); }
    });
    let reachedBody!: () => void, bodySignal: AbortSignal | null | undefined, cancelled = false;
    const bodyStarted = new Promise<void>((resolve) => { reachedBody = resolve; });
    await withFetch(async (_input, init) => {
      bodySignal = init?.signal;
      return new Response(new ReadableStream({
        pull: () => { reachedBody(); return new Promise<void>(() => {}); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }));
    }, async () => {
      const cleanup = new AbortController();
      const pending = downloadAsset({ type: 'url', url: base + '/never-finished' }, { cacheDir: directory, timeoutMs: 25, signal: cleanup.signal });
      const rejected = assert.rejects(pending, /timed out/);
      try {
        await bodyStarted;
        assert.ok(bodySignal);
        context.mock.timers.tick(24); assert.equal(bodySignal.aborted, false);
        context.mock.timers.tick(1); assert.equal(bodySignal.aborted, true);
        await rejected;
        assert.equal(cancelled, true);
      } finally { cleanup.abort(); await pending.catch(() => {}); }
    });
    assert.deepEqual(await fsp.readdir(directory), []);
  } finally { context.mock.timers.reset(); }
});
test('pre-cancelled requests do not dispatch a transfer', async () => {
  const controller = new AbortController(); controller.abort();
  const before = requests;
  await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/ok' }, { cacheDir, signal: controller.signal }), /cancelled/);
  assert.equal(requests, before);
});
test('oversized and cross-repository GitHub release metadata cannot select an asset', async () => {
  const source = { type: 'github-release' as const, repo: 'Example/Project', tag: 'v1', asset: 'asset.zip' };
  await withFetch(async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)), async () => {
    await assert.rejects(() => resolveAssetUrl(source), /byte limit/);
  });
  for (const url of [
    'https://github.com/Other/Project/releases/download/v1/asset.zip',
    'https://github.com/Example/Project.evil/releases/download/v1/asset.zip',
    'https://127.0.0.1/asset.zip',
  ]) {
    await withFetch(async () => new Response(JSON.stringify({ tag_name: 'v1', assets: [{ name: 'asset.zip', browser_download_url: url, size: 8 }] })), async () => {
      await assert.rejects(() => resolveAssetUrl(source), /policy|repository/);
    });
  }
  await withFetch(async () => new Response(JSON.stringify({ tag_name: 'v2', assets: [] })), async () => {
    await assert.rejects(() => resolveAssetUrl(source), /tag does not match/);
  });
});
test('malformed size metadata and invalid caller ceilings fail closed', async () => {
  for (const size of [-1, NaN, 2 ** 32]) await assert.rejects(() => resolveAssetUrl({ type: 'url', url: base + '/ok', size }), /size/);
  for (const maxBytes of [0, NaN, 2 ** 32]) await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/ok' }, { cacheDir, maxBytes }), /byte limit/);
  await withFetch(async () => new Response('small', { headers: { 'content-length': '-1' } }), async () => {
    await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/invalid-length' }, { cacheDir }), /size/);
  });
});
test('cache directory junctions and hardlinked entries cannot disclose or overwrite an external file', async () => {
  const outside = path.join(tmp, 'outside'); await fsp.mkdir(outside);
  const secret = path.join(outside, 'unrelated.txt'); await fsp.writeFile(secret, 'keep external bytes');
  const linkedCache = path.join(tmp, 'cache-junction');
  await fsp.symlink(outside, linkedCache, process.platform === 'win32' ? 'junction' : 'dir');
  const before = requests;
  await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/ok' }, { cacheDir: linkedCache }), /Linked.*cache/);
  assert.equal(requests, before);
  const directory = path.join(tmp, 'cache-hardlink');
  const first = await downloadAsset({ type: 'url', url: base + '/ok' }, { cacheDir: directory });
  await fsp.unlink(first.path); await fsp.link(secret, first.path);
  await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/ok' }, { cacheDir: directory, force: true }), /Linked.*cache/);
  assert.equal(await fsp.readFile(secret, 'utf8'), 'keep external bytes');
});
test('a pre-existing legacy partial hardlink is not opened or truncated by a new transfer', async () => {
  const directory = path.join(tmp, 'cache-legacy-partial');
  const first = await downloadAsset({ type: 'url', url: base + '/ok' }, { cacheDir: directory });
  const external = path.join(tmp, 'external-partial.txt'); await fsp.writeFile(external, 'keep legacy target');
  await fsp.link(external, first.path + '.part');
  const next = await downloadAsset({ type: 'url', url: base + '/ok' }, { cacheDir: directory, force: true });
  assert.equal(next.sha256, PAYLOAD_SHA);
  assert.equal(await fsp.readFile(external, 'utf8'), 'keep legacy target');
  assert.equal(await fsp.readFile(first.path + '.part', 'utf8'), 'keep legacy target');
});
test('a same-size edit of a staged file cannot be published with the transfer digest', async () => {
  const directory = path.join(tmp, 'stage-tamper');
  let edited = false;
  await assert.rejects(() => downloadAsset({ type: 'url', url: base + '/ok', sha256: PAYLOAD_SHA }, {
    cacheDir: directory,
    onProgress: () => {
      if (edited) return; edited = true;
      const name = fs.readdirSync(directory).find((item) => item.endsWith('.part'));
      assert.ok(name);
      const handle = fs.openSync(path.join(directory, name), 'r+');
      try { fs.writeSync(handle, Buffer.from('x'), 0, 1, 0); } finally { fs.closeSync(handle); }
    },
  }), /differs from transferred bytes/);
  assert.equal(edited, true);
  assert.deepEqual(await fsp.readdir(directory), []);
});
test('registered GitHub metadata resolves its own bounded asset without widening the URL origin', async () => {
  const source = { type: 'github-release' as const, repo: 'Example/Project', tag: 'v1', asset: 'asset.zip', size: 8 };
  await withFetch(async (input) => {
    assert.equal(String(input), 'https://api.github.com/repos/Example/Project/releases/tags/v1');
    return new Response(JSON.stringify({ tag_name: 'v1', assets: [{ name: 'asset.zip', browser_download_url: 'https://github.com/Example/Project/releases/download/v1/asset.zip', size: 8 }] }));
  }, async () => {
    assert.deepEqual(await resolveAssetUrl(source), { name: 'asset.zip', url: 'https://github.com/Example/Project/releases/download/v1/asset.zip', size: 8 });
  });
});

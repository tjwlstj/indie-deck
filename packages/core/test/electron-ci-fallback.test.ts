import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { cacheElectronFromOfficialApi } from '../../../scripts/ensure-electron.mjs';

const parent = path.resolve(os.tmpdir());
const fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-electron-fallback-'));
after(async () => {
  assert.equal(path.dirname(fixture), parent);
  assert.ok(path.basename(fixture).startsWith('indiedeck-electron-fallback-'));
  await fs.rm(fixture, { recursive: true, force: true });
});
const bytes = Buffer.from('small synthetic test fixture');
const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
const filename = 'electron-v43.8.7-linux-x64.zip';
const apiAsset = 'https://api.github.com/repos/electron/electron/releases/assets/1234';
const cdn = 'https://release-assets.githubusercontent.com/asset?signature=synthetic';
function mockFetch({ assetUrl = apiAsset, location = cdn, data = bytes, size = bytes.length, extra = [] }: any = {}) {
  const calls: { url: string; init: any }[] = [];
  const fetcher = (async (input: string | URL | Request, init: any) => {
    const url = String(input); calls.push({ url, init });
    if (url === 'https://api.github.com/repos/electron/electron/releases/tags/v43.8.7') {
      return new Response(JSON.stringify({ tag_name: 'v43.8.7', assets: [
        { name: filename, size, state: 'uploaded', url: assetUrl }, ...extra,
      ] }));
    }
    if (url === apiAsset) return new Response(null, { status: 302, headers: { location } });
    if (url === cdn) return new Response(data);
    throw new Error('Unexpected request');
  }) as typeof fetch;
  return { fetcher, calls };
}
function options(name: string, fetchImpl: typeof fetch, overrides: any = {}) {
  return { version: '43.8.7', platform: 'linux', arch: 'x64', expectedSha256: checksum,
    cacheRoots: [path.join(fixture, name)], fetchImpl, ci: true, ...overrides };
}

test('fallback refuses to issue any request when GitHub Actions is not enabled', async () => {
  const mock = mockFetch();
  await assert.rejects(cacheElectronFromOfficialApi(options('outside-ci', mock.fetcher, { ci: false })), /restricted/);
  assert.equal(mock.calls.length, 0);
  await assert.rejects(fs.stat(path.join(fixture, 'outside-ci')), { code: 'ENOENT' });
});

test('official API fallback hashes exact bytes before publishing to installer and builder caches', async () => {
  const mock = mockFetch();
  const roots = [path.join(fixture, 'installer'), path.join(fixture, 'builder')];
  const result = await cacheElectronFromOfficialApi(options('unused', mock.fetcher, { cacheRoots: roots }));
  const expectedKey = crypto.createHash('sha256').update('https://github.com/electron/electron/releases/download/v43.8.7').digest('hex');
  assert.equal(result.cacheKey, expectedKey);
  for (const root of roots) {
    assert.deepEqual(await fs.readFile(path.join(root, expectedKey, filename)), bytes);
    assert.deepEqual(await fs.readdir(path.join(root, expectedKey)), [filename]);
  }
  assert.equal(mock.calls.length, 3);
  for (const call of mock.calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.deepEqual(Object.keys(call.init.headers).sort(), ['Accept', 'User-Agent']);
    assert.ok(call.init.signal);
  }
});

test('wrong asset hashes, sizes and duplicated assets never publish a cache file', async () => {
  for (const [name, mock, override] of [
    ['bad-hash', mockFetch(), { expectedSha256: 'f'.repeat(64) }],
    ['bad-size', mockFetch({ size: bytes.length + 1 }), {}],
    ['oversize', mockFetch({ size: 1025 }), { maxBytes: 1024 }],
    ['duplicate', mockFetch({ extra: [{ name: filename, size: bytes.length, state: 'uploaded', url: apiAsset }] }), {}],
  ] as const) {
    await assert.rejects(cacheElectronFromOfficialApi(options(name, mock.fetcher, override)));
    const files = await fs.readdir(path.join(fixture, name), { recursive: true }).catch(() => []);
    assert.ok(!files.some((file) => String(file).endsWith('.zip') || String(file).endsWith('.part')));
  }
});

test('untrusted asset URLs and redirects fail before contacting their targets', async () => {
  for (const bad of ['https://evil.example/asset', 'http://release-assets.githubusercontent.com/asset',
    'https://release-assets.githubusercontent.com.evil.example/asset', 'https://user@release-assets.githubusercontent.com/asset']) {
    const mock = mockFetch({ location: bad });
    await assert.rejects(cacheElectronFromOfficialApi(options('redirect', mock.fetcher)));
    assert.equal(mock.calls.length, 2);
  }
  const mock = mockFetch({ assetUrl: 'https://api.github.com.evil.example/repos/electron/electron/releases/assets/1234' });
  await assert.rejects(cacheElectronFromOfficialApi(options('asset-url', mock.fetcher)));
  assert.equal(mock.calls.length, 1);
});

test('stalled requests time out without requiring cooperation from the fetch implementation', async () => {
  const stalled = (() => new Promise<Response>(() => {})) as typeof fetch;
  await assert.rejects(cacheElectronFromOfficialApi(options('stalled', stalled, { deadlineMs: 20 })), /timed out/);
});

test('a failed signed-URL request or body never exposes that URL in the reported error', async () => {
  for (const duringBody of [false, true]) {
    const original = mockFetch();
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== cdn) return original.fetcher(input, init);
      if (!duringBody) throw new Error(`Failed to fetch ${cdn}`);
      return new Response(new ReadableStream({
        pull() { throw new Error(`Failure while reading ${cdn}`); },
      }));
    }) as typeof fetch;
    await assert.rejects(cacheElectronFromOfficialApi(options(`safe-error-${duringBody}`, request)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /signature|release-assets/i);
      return true;
    });
  }
});

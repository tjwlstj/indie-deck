import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAssetUrl, assertAssetRedirect, fetchAssetResponse } from '../src/install/network-policy.ts';

async function withFetch<T>(mock: typeof fetch, work: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch; globalThis.fetch = mock;
  try { return await work(); } finally { globalThis.fetch = previous; }
}
test('registry asset URLs accept only the fixed HTTPS origins and ordinary URL form', () => {
  assert.equal(assertAssetUrl('https://github.com/Owner/Repo/releases/download/v1/asset.zip').hostname, 'github.com');
  assert.equal(assertAssetUrl('https://builds.bepinex.dev/example.zip').hostname, 'builds.bepinex.dev');
  assert.equal(assertAssetUrl('https://api.github.com/repos/Owner/Repo/releases/latest', 'github-api').hostname, 'api.github.com');
  for (const value of [
    'http://github.com/asset.zip', 'file:///C:/private.zip', 'https://localhost/asset.zip',
    'https://127.0.0.1/asset.zip', 'https://2130706433/asset.zip', 'https://0x7f000001/asset.zip',
    'https://10.1.2.3/asset.zip', 'https://169.254.169.254/asset.zip', 'https://[::1]/asset.zip',
    'https://[::ffff:127.0.0.1]/asset.zip', 'https://github.com.evil.test/asset.zip',
    'https://github.com./asset.zip', 'https://github.com:8443/asset.zip',
    'https://user:private@github.com/asset.zip', 'https://github.com/asset.zip#private',
    'https://github.com\\@evil.test/a.zip', 'https://github.com/\nprivate.zip',
    'https://release-assets.githubusercontent.com/asset.zip',
  ]) assert.throws(() => assertAssetUrl(value), /policy|HTTPS/);
});
test('redirects permit same-origin and the fixed GitHub asset CDN chain, with no downgrade or cross-service hop', () => {
  const github = new URL('https://github.com/Owner/Repo/releases/download/v1/a.zip');
  assert.equal(assertAssetRedirect(github, '/Owner/Repo/releases/download/v1/b.zip', 'asset').hostname, 'github.com');
  assert.equal(assertAssetRedirect(github, 'https://release-assets.githubusercontent.com/asset.zip', 'asset').hostname, 'release-assets.githubusercontent.com');
  for (const value of ['http://github.com/a.zip', 'https://127.0.0.1/a.zip', 'https://builds.bepinex.dev/a.zip',
    'https://evil.test/a.zip', 'https://github.com/a.zip\n', '\\\\github.com\\a.zip']) {
    assert.throws(() => assertAssetRedirect(github, value, 'asset'), /policy|HTTPS|redirect/);
  }
  assert.throws(() => assertAssetRedirect(new URL('https://builds.bepinex.dev/a.zip'), github.href, 'asset'), /unapproved origin/);
});
test('manual GitHub CDN requests do not carry an authorization or cookie header', async () => {
  const calls: { url: string; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset.zip' } }) : new Response('asset');
  }, async () => {
    const response = await fetchAssetResponse('https://github.com/O/R/releases/download/v1/a.zip', {
      purpose: 'asset', signal: new AbortController().signal, githubAuthorization: 'Bearer fixture-only',
    });
    assert.equal(await response.text(), 'asset');
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.redirect, 'manual'); assert.equal(call.headers.get('authorization'), null);
    assert.equal(call.headers.get('cookie'), null); assert.equal(call.headers.get('accept-encoding'), 'identity');
  }
});
test('a cross-origin GitHub API redirect is rejected before any token can be forwarded', async () => {
  const calls: { url: string; token: string | null }[] = [];
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), token: new Headers(init?.headers).get('authorization') });
    return new Response(null, { status: 302, headers: { location: 'https://github.com/private' } });
  }, async () => {
    await assert.rejects(() => fetchAssetResponse('https://api.github.com/repos/O/R/releases/latest', {
      purpose: 'github-api', signal: new AbortController().signal, githubAuthorization: 'Bearer fixture-only',
    }), /policy/);
  });
  assert.deepEqual(calls, [{ url: 'https://api.github.com/repos/O/R/releases/latest', token: 'Bearer fixture-only' }]);
});
test('same-origin GitHub API relocation keeps its own authentication without widening origins', async () => {
  const calls: string[] = [];
  await withFetch(async (_input, init) => {
    calls.push(new Headers(init?.headers).get('authorization') ?? '');
    return calls.length === 1 ? new Response(null, { status: 301, headers: { location: '/repositories/1/releases/latest' } }) : new Response('{}');
  }, async () => {
    await fetchAssetResponse('https://api.github.com/repos/O/R/releases/latest', {
      purpose: 'github-api', signal: new AbortController().signal, githubAuthorization: 'Bearer fixture-only',
    });
  });
  assert.deepEqual(calls, ['Bearer fixture-only', 'Bearer fixture-only']);
});
test('redirect loops stop after five inspected hops', async () => {
  let count = 0;
  await withFetch(async () => { count += 1; return new Response(null, { status: 302, headers: { location: '/again.zip' } }); }, async () => {
    await assert.rejects(() => fetchAssetResponse('https://builds.bepinex.dev/again.zip', { purpose: 'asset', signal: new AbortController().signal }), /Too many/);
  });
  assert.equal(count, 6);
});
test('an uninspected automatic redirect and a network error cannot masquerade as an approved response', async () => {
  await withFetch(async () => {
    const response = new Response('private'); Object.defineProperty(response, 'redirected', { value: true }); return response;
  }, async () => {
    await assert.rejects(() => fetchAssetResponse('https://github.com/O/R/releases/download/v1/a.zip', { purpose: 'asset', signal: new AbortController().signal }), /Uninspected/);
  });
  await withFetch(async () => { throw new Error('Synthetic private URL query and headers'); }, async () => {
    await assert.rejects(() => fetchAssetResponse('https://github.com/O/R/releases/download/v1/a.zip?private=value', {
      purpose: 'asset', signal: new AbortController().signal,
    }), (error: Error) => error.message === 'Asset network request failed.');
  });
});
test('an inherited certificate-verification bypass cannot dispatch a download', async () => {
  const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  let requests = 0;
  try {
    await withFetch(async () => { requests += 1; return new Response('unexpected'); }, async () => {
      await assert.rejects(() => fetchAssetResponse('https://github.com/O/R/releases/download/v1/a.zip', {
        purpose: 'asset', signal: new AbortController().signal,
      }), /TLS verification/);
    });
    assert.equal(requests, 0);
  } finally {
    if (previous === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
  }
});

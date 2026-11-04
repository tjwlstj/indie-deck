/** Fixed outbound policy for registry assets. This is a hostname/TLS policy,
 * not DNS pinning or a network sandbox for launched games. */
const INITIAL_ASSET_HOSTS = new Set(['github.com', 'builds.bepinex.dev']);
const GITHUB_ASSET_HOSTS = new Set([
  'github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
]);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
export const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_NETWORK_TIMEOUT_MS = 120_000;
export const MAX_NETWORK_TIMEOUT_MS = 600_000;
export const MAX_METADATA_BYTES = 2 * 1024 * 1024;
export type RequestPurpose = 'asset' | 'github-api';

export function assertAssetUrl(raw: string, purpose: RequestPurpose = 'asset', redirect = false): URL {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(raw)) {
    throw new Error('Asset URL is malformed or outside the network policy.');
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Asset URL is malformed or outside the network policy.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new Error('Asset URL requires HTTPS without credentials, fragments or a custom port.');
  }
  const permitted = purpose === 'github-api' ? url.hostname === 'api.github.com'
    : INITIAL_ASSET_HOSTS.has(url.hostname) || redirect && GITHUB_ASSET_HOSTS.has(url.hostname);
  if (!permitted) throw new Error('Asset host is outside the approved download policy.');
  return url;
}

export function assertAssetRedirect(previous: URL, location: string, purpose: RequestPurpose): URL {
  if (typeof location !== 'string' || location.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(location)) throw new Error('Invalid asset redirect.');
  let destination: string;
  try { destination = new URL(location, previous).href; } catch { throw new Error('Invalid asset redirect.'); }
  const next = assertAssetUrl(destination, purpose, true);
  if (next.origin !== previous.origin &&
    !(purpose === 'asset' && GITHUB_ASSET_HOSTS.has(previous.hostname) && GITHUB_ASSET_HOSTS.has(next.hostname))) {
    throw new Error('Asset redirect crosses an unapproved origin.');
  }
  return next;
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Network request cancelled or timed out.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('Network request cancelled or timed out.')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

/** Redirects are inspected before another request, and auth is kept at the
 * GitHub API origin. No arbitrary header supplied by a registry is accepted. */
export async function fetchAssetResponse(raw: string, options: {
  purpose: RequestPurpose; signal: AbortSignal; githubAuthorization?: string;
}): Promise<Response> {
  if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') throw new Error('TLS verification must remain enabled for asset downloads.');
  let url = assertAssetUrl(raw, options.purpose);
  for (let redirects = 0; ; redirects += 1) {
    const headers: Record<string, string> = { 'user-agent': 'IndieDeck', 'accept-encoding': 'identity' };
    if (options.purpose === 'github-api') {
      headers['accept'] = 'application/vnd.github+json';
      if (options.githubAuthorization) headers['authorization'] = options.githubAuthorization;
    }
    let response: Response;
    try { response = await abortable(fetch(url.href, { headers, redirect: 'manual', signal: options.signal }), options.signal); }
    catch { throw new Error(options.signal.aborted ? 'Network request cancelled or timed out.' : 'Asset network request failed.'); }
    if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error('Uninspected asset redirects are not accepted.'); }
    if (!REDIRECT_CODES.has(response.status)) return response;
    void response.body?.cancel().catch(() => {});
    if (redirects >= 5) throw new Error('Too many asset redirects.');
    const location = response.headers.get('location');
    if (!location) throw new Error('Asset redirect has no destination.');
    url = assertAssetRedirect(url, location, options.purpose);
  }
}

/** Read limits apply to actual streamed bytes, even without Content-Length.
 * The caller decides whether those bytes form metadata or an archive. */
export async function consumeAssetBody(
  response: Response, limit: number, signal: AbortSignal, consume: (chunk: Buffer) => Promise<void> | void,
): Promise<number> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Asset response exceeds its byte limit or has an invalid length.');
  }
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let received = 0, complete = false;
  try {
    for (;;) {
      const value = await abortable(reader.read(), signal);
      if (value.done) { complete = true; return received; }
      if (!(value.value instanceof Uint8Array)) throw new Error('Invalid asset response body.');
      if (value.value.byteLength > limit - received) throw new Error('Asset response exceeds its byte limit.');
      received += value.value.byteLength;
      await consume(Buffer.from(value.value));
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

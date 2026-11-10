import crypto from 'node:crypto';
import { imageMime, type Thumbnail } from './thumbnails.ts';

/** Independently validate imported, untrusted page metadata. The extension's
 * policy is mirrored intentionally; parity tests cover both trust boundaries. */
export function normalizeArtworkUrl(provider: unknown, productId: unknown, input: unknown): string | null {
  if (typeof productId !== 'string' || typeof input !== 'string' || !input || input.length > 2048 ||
      /[\\#\u0000-\u0020\u007f-\u009f]/u.test(input) || /%(?:2f|5c|00|2e)/i.test(input) ||
      /\/\.{1,2}(?:\/|[?#]|$)/.test(input)) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  const authority = /^https:\/\/([^/?#]*)/i.exec(input)?.[1];
  if (url.protocol !== 'https:' || !authority || /[:@]/.test(authority) || url.username || url.password || url.port || url.hash) return null;
  const route = url.pathname;
  if (route.length > 1800 || route.includes('..') || !/^\/[A-Za-z0-9_./=+%-]+$/.test(route) ||
      !/\.(?:png|jpe?g|webp)$/i.test(route)) return null;
  const query = [...url.searchParams];
  if (new Set(query.map(([key]) => key)).size !== query.length) return null;
  let allowed = false;
  if (provider === 'steam' && /^[1-9][0-9]{0,9}$/.test(productId)) {
    allowed = ['cdn.cloudflare.steamstatic.com', 'cdn.akamai.steamstatic.com', 'shared.fastly.steamstatic.com', 'shared.akamai.steamstatic.com'].includes(url.hostname)
      && (route.startsWith(`/steam/apps/${productId}/`) || route.startsWith(`/store_item_assets/steam/apps/${productId}/`))
      && !route.includes('%') && query.every(([key, value]) => key === 't' && /^\d{1,14}$/.test(value));
  } else if (provider === 'gog' && /^[a-z0-9][a-z0-9_-]{0,159}$/.test(productId)) {
    allowed = url.hostname === 'images.gog-statics.com' && /^\/[a-f0-9]{32,128}(?:_[A-Za-z0-9_-]{1,100})?\.(?:png|jpe?g|webp)$/i.test(route) && query.length === 0;
  } else if (provider === 'epic' && /^[a-z0-9][a-z0-9_-]{0,159}$/.test(productId)) {
    allowed = url.hostname === 'cdn1.epicgames.com' && /^\/(?:offer|spt-assets)\//.test(route) && !route.includes('%')
      && query.every(([key, value]) => ['resize', 'w', 'h', 'quality'].includes(key)
        && (/^\d{1,6}$/.test(value) || key === 'quality' && ['low', 'medium', 'high'].includes(value)));
  } else if (provider === 'itch' && /^[a-z0-9-]+\/[a-z0-9][a-z0-9_-]{0,159}$/.test(productId)) {
    allowed = url.hostname === 'img.itch.zone' && route.startsWith('/aW1n') && !/%(?!23)/i.test(route) && query.length === 0;
  } else if (provider === 'booth' && /^[1-9][0-9]{0,11}$/.test(productId)) {
    allowed = url.hostname === 'booth.pximg.net' && route.includes(`/i/${productId}/`) && !route.includes('%') && query.length === 0;
  } else if (provider === 'dlsite' && /^(?:home|maniax|pro|soft|books):(?:RJ|VJ|BJ)[0-9]{6,12}$/.test(productId)) {
    const work = productId.split(':')[1];
    allowed = url.hostname === 'img.dlsite.jp' && route.startsWith('/modpub/images2/work/')
      && new RegExp(`/${work}_img_main\\.(?:png|jpe?g|webp)$`, 'i').test(route) && !route.includes('%') && query.length === 0;
  }
  if (!allowed) return null;
  // Only the reviewed, public identity remains. Accepted cache/resize query
  // values are dropped; signed or unknown query names were rejected above.
  url.search = '';
  return url.href;
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(key: string): never { throw new Error(`ui.stores.artwork.${key}`); }

/** Static public CDN, no redirect, cookies, referrer or account headers. The
 * stream cap applies to decoded response bytes, not just Content-Length. */
export async function downloadStoreArtwork(provider: unknown, productId: unknown, input: unknown,
  request: typeof fetch = fetch): Promise<Buffer> {
  const url = normalizeArtworkUrl(provider, productId, input);
  if (!url) fail('invalid');
  try {
    const response = await request(url, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(8000), headers: { Accept: 'image/png,image/jpeg,image/webp' } });
    if (!response.ok || response.redirected || !response.body) fail('unavailable');
    const length = response.headers.get('content-length');
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES) ||
      type && !['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'].includes(type)) {
      await response.body.cancel(); fail('unavailable');
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > MAX_IMAGE_BYTES) { await reader.cancel(); fail('unavailable'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, size), mime = imageMime(bytes);
    if (!bytes.length || !mime || type && type.startsWith('image/') && mime !== type) fail('unavailable');
    return bytes;
  } catch { fail('unavailable'); }
}

export function artworkThumbnail(bytes: Buffer): Thumbnail {
  const mime = imageMime(bytes);
  if (!mime || !bytes.length || bytes.length > MAX_IMAGE_BYTES) fail('unavailable');
  return { source: 'manual', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
}

/** At most two 2 MiB images live for five minutes. Applying consumes only
 * already-previewed bytes; a mutable CDN cannot substitute a second download. */
export function createStoreArtworkPreviews(options: { request?: typeof fetch; now?: () => number } = {}) {
  const previews = new Map<string, { candidateId: string; bytes: Buffer; expires: number }>();
  const now = options.now ?? Date.now;
  let busy = false;
  const revoke = (candidateId: string) => {
    for (const [id, item] of previews) if (item.candidateId === candidateId || item.expires <= now()) previews.delete(id);
  };
  return {
    revoke,
    async preview(candidateId: string, provider: unknown, productId: unknown, url: unknown) {
      if (!UUID.test(candidateId)) fail('stale');
      if (busy) fail('busy');
      busy = true; revoke(candidateId);
      try {
        const bytes = await downloadStoreArtwork(provider, productId, url, options.request ?? fetch);
        while (previews.size >= 2) previews.delete(previews.keys().next().value!);
        const previewId = crypto.randomUUID();
        previews.set(previewId, { candidateId, bytes, expires: now() + 5 * 60_000 });
        return { candidateId, previewId, thumbnail: artworkThumbnail(bytes) };
      } finally { busy = false; }
    },
    get(candidateId: unknown, previewId: unknown): Buffer {
      const item = typeof previewId === 'string' && previews.get(previewId);
      if (!item || item.candidateId !== candidateId || item.expires <= now()) {
        if (item && item.expires <= now() && typeof previewId === 'string') previews.delete(previewId);
        fail('stale');
      }
      return Buffer.from(item.bytes);
    },
  };
}

/** Public raster artwork only. This module performs no browser or network I/O.
 * The desktop independently applies the same policy before any download. */
export function normalizeArtworkUrl(provider, productId, input) {
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

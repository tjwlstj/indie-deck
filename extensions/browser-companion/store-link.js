/** Shared by the extension popup and its offline tests. No browser or network access. */
import { normalizeArtworkUrl } from './artwork.js';
export const LINK_FILENAME = 'indiedeck-store-link.indiedeck-link.json';
const SLUG = /^[a-z0-9][a-z0-9_-]{0,159}$/;
const CREATOR = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_CREATORS = new Set(['www', 'api', 'static', 'uploads', 'download', 'downloads', 'assets', 'cdn', 'support', 'help', 'status']);
const RESERVED_ITCH_PATHS = new Set(['download', 'downloads', 'purchase', 'purchases', 'my-purchases', 'orders', 'order', 'login', 'logout', 'register', 'oauth', 'api', 'settings', 'profile', 'edit', 'admin', 'dashboard']);
const EPIC_LOCALES = new Set(['en-us', 'ar', 'de', 'es-es', 'es-mx', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'th', 'tr', 'zh-cn', 'zh-hant']);
const GOG_LOCALES = new Set(['en', 'de', 'fr', 'pl', 'ru']);
const PROVIDERS = new Set(['steam', 'epic', 'gog', 'itch', 'booth', 'dlsite']);

export function validProductId(provider, productId) {
  if (typeof productId !== 'string') return false;
  if (provider === 'steam') return /^[1-9][0-9]{0,9}$/.test(productId);
  if (provider === 'booth') return /^[1-9][0-9]{0,11}$/.test(productId);
  if (provider === 'epic' || provider === 'gog') return SLUG.test(productId);
  if (provider === 'dlsite') return /^(home|maniax|pro|soft|books):(?:RJ|VJ|BJ)[0-9]{6,12}$/.test(productId);
  if (provider === 'itch') {
    const parts = productId.split('/');
    return parts.length === 2 && CREATOR.test(parts[0]) && !RESERVED_CREATORS.has(parts[0]) &&
      SLUG.test(parts[1]) && !RESERVED_ITCH_PATHS.has(parts[1]);
  }
  return false;
}

export function cleanDisplayTitle(value) {
  if (typeof value !== 'string') return '';
  // Preserve a bounded, editable display label. Never use it as a provider id.
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 240);
}

function record(provider, productId, title) {
  if (!validProductId(provider, productId)) return null;
  const displayTitle = cleanDisplayTitle(title);
  return { schemaVersion: 1, kind: 'indiedeck-store-link', provider, productId,
    ...(displayTitle ? { title: displayTitle } : {}) };
}

/** Accept public product routes only. Query, fragment and raw URL never leave this function. */
export function metadataFromProductUrl(input, title) {
  if (typeof input !== 'string' || input.length > 8192 || /[\\\u0000-\u0020\u007f]/.test(input)) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  const authority = /^https:\/\/([^/?#]*)/i.exec(input)?.[1];
  if (url.protocol !== 'https:' || !authority || /[:@]/.test(authority) || url.username || url.password || url.port) return null;
  const route = url.pathname;
  if (/%(?:2f|5c|00|2e)/i.test(route)) return null;
  let found;
  if (url.hostname === 'store.steampowered.com') {
    found = /^\/app\/([1-9][0-9]{0,9})(?:\/[^/]+)?\/?$/.exec(route);
    return found ? record('steam', found[1], title) : null;
  }
  if (url.hostname === 'store.epicgames.com') {
    found = /^\/(?:([^/]+)\/)?p\/([a-z0-9][a-z0-9_-]{0,159})\/?$/.exec(route);
    return found && (!found[1] || EPIC_LOCALES.has(found[1].toLowerCase())) ? record('epic', found[2], title) : null;
  }
  if (url.hostname === 'gog.com' || url.hostname === 'www.gog.com') {
    found = /^\/(?:([^/]+)\/)?game\/([a-z0-9][a-z0-9_-]{0,159})\/?$/.exec(route);
    return found && (!found[1] || GOG_LOCALES.has(found[1].toLowerCase())) ? record('gog', found[2], title) : null;
  }
  const itch = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.itch\.io$/.exec(url.hostname);
  if (itch) {
    found = /^\/([a-z0-9][a-z0-9_-]{0,159})\/?$/.exec(route);
    return found ? record('itch', `${itch[1]}/${found[1]}`, title) : null;
  }
  if (url.hostname === 'booth.pm' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.booth\.pm$/.test(url.hostname)) {
    found = /^\/(?:([a-z]{2})\/)?items\/([1-9][0-9]{0,11})\/?$/.exec(route);
    return found && (!found[1] || ['ja', 'en'].includes(found[1])) ? record('booth', found[2], title) : null;
  }
  if (url.hostname === 'www.dlsite.com' || url.hostname === 'dlsite.com') {
    found = /^\/(home|maniax|pro|soft|books)\/work\/=\/product_id\/((?:RJ|VJ|BJ)[0-9]{6,12})\.html\/?$/.exec(route);
    return found ? record('dlsite', `${found[1]}:${found[2]}`, title) : null;
  }
  return null;
}

/** Validate the same narrow schema before export; unknown fields cannot become hidden payloads. */
export function validateStoreLink(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.keys(value).every((key) => ['schemaVersion', 'kind', 'provider', 'productId', 'title', 'artwork'].includes(key)) ||
      !['schemaVersion', 'kind', 'provider', 'productId'].every((key) => Object.hasOwn(value, key)) ||
      ![1, 2].includes(value.schemaVersion) || value.kind !== 'indiedeck-store-link' || !PROVIDERS.has(value.provider) ||
      !validProductId(value.provider, value.productId) ||
      value.title !== undefined && (typeof value.title !== 'string' || !value.title.length || value.title.length > 240 || /[\u0000-\u001f\u007f-\u009f]/.test(value.title))) {
    throw new Error('Unsupported store-link metadata');
  }
  let artwork;
  if (value.schemaVersion === 1 && Object.hasOwn(value, 'artwork')) throw new Error('Unsupported store-link metadata');
  if (value.schemaVersion === 2) {
    if (!Object.hasOwn(value, 'artwork') || !value.artwork || typeof value.artwork !== 'object' || Array.isArray(value.artwork) ||
        Object.keys(value.artwork).length !== 1 || !Object.hasOwn(value.artwork, 'url')) throw new Error('Unsupported store-link metadata');
    const url = normalizeArtworkUrl(value.provider, value.productId, value.artwork.url);
    if (!url) throw new Error('Unsupported store-link metadata');
    artwork = { url };
  }
  return { schemaVersion: value.schemaVersion, kind: 'indiedeck-store-link', provider: value.provider, productId: value.productId,
    ...(value.title !== undefined ? { title: value.title } : {}), ...(artwork ? { artwork } : {}) };
}

export function serializeStoreLink(value) { return `${JSON.stringify(validateStoreLink(value), null, 2)}\n`; }

export function productPageForMetadata(input) {
  const value = validateStoreLink(input), id = value.productId;
  if (value.provider === 'steam') return `https://store.steampowered.com/app/${id}/`;
  if (value.provider === 'epic') return `https://store.epicgames.com/en-US/p/${id}`;
  if (value.provider === 'gog') return `https://www.gog.com/en/game/${id}`;
  if (value.provider === 'itch') { const [creator, game] = id.split('/'); return `https://${creator}.itch.io/${game}`; }
  if (value.provider === 'booth') return `https://booth.pm/ja/items/${id}`;
  const [section, product] = id.split(':');
  return `https://www.dlsite.com/${section}/work/=/product_id/${product}.html`;
}

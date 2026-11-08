import { imageMime } from '../../packages/desktop/src/thumbnails.ts';

export interface RawgArtworkCandidate { id: string; name: string; attribution: { label: 'RAWG'; href: 'https://rawg.io/' } }
export interface RawgExperimentOptions { fetch?: typeof fetch }
export interface RawgArtwork {
  source: 'rawg'; id: string; dataUrl: string;
  attribution: { label: 'RAWG'; href: 'https://rawg.io/' };
}

const MAX_JSON_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const RAWG_BACKLINK = 'https://rawg.io/' as const;

/** The API returns an image URL. Accept a narrow, credential-free RAWG media
 * path only: no other host, redirect, query, fragment or escaped path. */
function imageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 400 ||
      !/^https:\/\/media\.rawg\.io\/media\/games\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,200}\.(?:jpg|jpeg|png|webp)$/.test(value)) return undefined;
  return value;
}

function awaitAbortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Timed out.')); return; }
    const aborted = () => reject(new Error('Timed out.'));
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted)).catch(() => {});
  });
}

async function download(url: string, max: number, request: typeof fetch): Promise<Buffer> {
  const signal = AbortSignal.timeout(8000);
  const response = await awaitAbortable(request(url, { redirect: 'error', signal,
    headers: { Accept: 'application/json, image/*', 'User-Agent': 'IndieDeck-RAWG-Experiment/1.0' } }), signal);
  if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error('Request failed.'); }
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) { void response.body.cancel().catch(() => {}); throw new Error('Response too large.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0, complete = false;
  try {
    while (true) {
      const item = await awaitAbortable(reader.read(), signal);
      if (item.done) { complete = true; break; }
      total += item.value.byteLength;
      if (total > max) throw new Error('Response too large.');
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A cancelled read can still be pending. */ }
  }
}

/** Explicit caller-owned experiment. This module does not persist, log or
 * return the key. RAWG requires it in the request URL, which the transport and
 * upstream service can observe. Do not wire this into the product until all
 * image display surfaces meet RAWG attribution. */
export function createRawgArtworkExperiment(key: unknown, options: RawgExperimentOptions = {}) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(key)) throw new Error('Invalid RAWG key.');
  const request = options.fetch ?? fetch;
  let revision = 0;
  let candidates = new Map<string, { name: string; image: string }>();
  return {
    async search(query: unknown): Promise<RawgArtworkCandidate[]> {
      const current = ++revision;
      candidates = new Map();
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 120 || /[\u0000-\u001f\u007f]/u.test(query)) return [];
      try {
        const params = new URLSearchParams({ key, search: query.trim(), page_size: '10' });
        const bytes = await download(`https://api.rawg.io/api/games?${params}`, MAX_JSON_BYTES, request);
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { results?: unknown }).results)) throw new Error('Invalid response.');
        const found = new Map<string, { name: string; image: string }>();
        for (const item of (parsed as { results: unknown[] }).results.slice(0, 30)) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const { id: rawId, name, background_image: rawImage } = item as { id?: unknown; name?: unknown; background_image?: unknown };
          const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : typeof rawId === 'string' ? rawId : '';
          const image = imageUrl(rawImage);
          if (!/^[1-9]\d{0,15}$/.test(id) || id.includes(key) || typeof name !== 'string' || !name.trim() || name.length > 200 ||
              /[\u0000-\u001f\u007f]/u.test(name) || name.includes(key) || !image || found.has(id)) continue;
          found.set(id, { name: name.trim(), image });
          if (found.size === 10) break;
        }
        if (revision !== current) return [];
        candidates = found;
        return [...found].map(([id, entry]) => ({ id, name: entry.name, attribution: { label: 'RAWG', href: RAWG_BACKLINK } }));
      } catch { throw new Error('RAWG artwork search failed.'); }
    },
    async select(id: unknown): Promise<RawgArtwork | null> {
      const current = revision;
      if (typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id)) return null;
      const candidate = candidates.get(id);
      if (!candidate) return null;
      try {
        const bytes = await download(candidate.image, MAX_IMAGE_BYTES, request);
        const mime = imageMime(bytes);
        if (!mime || revision !== current || candidates.get(id) !== candidate) return null;
        return { source: 'rawg', id, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
          attribution: { label: 'RAWG', href: RAWG_BACKLINK } };
      } catch { throw new Error('RAWG artwork download failed.'); }
    },
    clear(): void { revision += 1; candidates.clear(); },
  };
}

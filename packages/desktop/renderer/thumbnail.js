import { el } from './dom.js';
import { currentLocale, t } from './i18n.js';
import { api } from './store.js';
import { createThumbnailLoader, normaliseThumbnail } from './thumbnail-model.js';

const loader = createThumbnailLoader((id) => typeof api.game.thumbnail === 'function' ? api.game.thumbnail(id) : null,
  { canStart: () => document.hidden !== true });
document.addEventListener?.('visibilitychange', () => { if (document.hidden !== true) loader.resume(); });

function paint(node, thumbnail) {
  const picture = node.querySelector('img'), placeholder = node.querySelector('.thumbnail-placeholder');
  const attribution = node.querySelector('.thumbnail-attribution');
  if (!picture || !placeholder) return;
  picture.hidden = !thumbnail; placeholder.hidden = Boolean(thumbnail);
  if (thumbnail) picture.src = thumbnail.dataUrl;
  else picture.removeAttribute('src');
  if (attribution) attribution.textContent = thumbnail
    ? thumbnail.source === 'steam' ? t('ui.thumbnail.steam', undefined, 'Steam official image')
      : thumbnail.source === 'gog' ? t('ui.thumbnail.gog', undefined, currentLocale().startsWith('ko') ? 'GOG 이미지' : 'GOG image')
        : thumbnail.source === 'manual' ? t('ui.thumbnail.manual', undefined, 'Selected image')
        : t('ui.thumbnail.local', undefined, 'Game folder image')
    : t('ui.thumbnail.missing', undefined, 'No image');
}

function paintAll(id, value) {
  for (const node of document.querySelectorAll('[data-thumbnail-game-id]')) {
    if (node.dataset.thumbnailGameId === id) paint(node, value);
  }
}

async function loadFor(node, refresh = false) {
  const id = node.dataset.thumbnailGameId;
  if (!id) return;
  const result = await loader.load(id, refresh);
  if (result.current) paintAll(id, result.value);
}

const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) {
    observer.unobserve(entry.target);
    void loadFor(entry.target);
  }
}, { rootMargin: '200px' }) : null;

export function thumbnailElement(game, detail = false) {
  const box = el('div', detail ? 'thumbnail thumbnail-detail' : 'thumbnail thumbnail-list');
  box.dataset.thumbnailGameId = game.id;
  const image = document.createElement('img');
  image.alt = detail ? (game.title || game.name || '') : '';
  image.hidden = true;
  const placeholder = el('span', 'thumbnail-placeholder', '▧');
  placeholder.setAttribute('aria-hidden', 'true');
  image.addEventListener('error', () => paint(box, null));
  box.append(image, placeholder);
  if (detail) box.append(el('span', 'thumbnail-attribution', t('ui.thumbnail.loading', undefined, 'Finding image…')));
  if (observer) observer.observe(box); else queueMicrotask(() => { if (box.isConnected) void loadFor(box); });
  return box;
}

/** Updates all visible copies, including the list after a detail selection. */
export function acceptSelectedThumbnail(id, value) {
  const safe = normaliseThumbnail(value);
  if (!safe) return null;
  loader.prime(id, safe); paintAll(id, safe); return safe;
}

/** Removing an override may legitimately leave no automatic image. Prime the
 * negative cache too so old lookups cannot restore the removed override. */
export function acceptResetThumbnail(id, value) {
  const safe = normaliseThumbnail(value);
  loader.prime(id, safe); paintAll(id, safe); return safe;
}

export function retryThumbnail(box) { return loadFor(box, true); }

/** A virtualised/re-rendered list must release observers for detached rows. */
export function releaseThumbnails(container) {
  if (!observer || !container) return;
  for (const node of container.querySelectorAll('[data-thumbnail-game-id]')) observer.unobserve(node);
}

import { el } from './dom.js';
import { t } from './i18n.js';
import { api, mutationBlocked, state } from './store.js';
import { acceptResetThumbnail, acceptSelectedThumbnail, retryThumbnail } from './thumbnail.js';
import { bindThumbnailPreview, releaseThumbnailPreviews } from './thumbnail-preview.js';

// A detail view can be rebuilt while its file picker is open. Keep one image
// action per game across those views, and refresh the replacement controls too.
const pendingGames = new Set();

export function usableThumbnailDrop(file) {
  return Boolean(file && typeof file.name === 'string' && /\.(?:png|jpe?g|webp)$/i.test(file.name) &&
    Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 2 * 1024 * 1024 &&
    (!file.type || ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)));
}

/** Only File objects reach the dropped-file bridge. Electron preload resolves
 * the OS-selected file; no path, URL or image data is supplied by this UI. */
export function appendThumbnailControls(section, profile, cover, dependencies = {}) {
  const gameApi = dependencies.gameApi ?? api.game;
  const blocked = dependencies.blocked ?? mutationBlocked;
  const accept = dependencies.accept ?? acceptSelectedThumbnail;
  const reset = dependencies.reset ?? acceptResetThumbnail;
  const retryImage = dependencies.retry ?? retryThumbnail;
  const bindPreview = dependencies.bindPreview ?? bindThumbnailPreview;
  const controls = el('div', 'thumbnail-controls');
  controls.dataset.thumbnailControlsId = profile.id;
  const status = el('p', 'thumbnail-status'); status.setAttribute('role', 'status');
  const results = el('div', 'thumbnail-results');
  const search = el('button', 'ghost thumbnail-steam-search', t('ui.thumbnail.search'));
  const gogSearch = el('button', 'ghost thumbnail-gog-search', t('ui.thumbnail.searchGog'));
  const retry = el('button', 'ghost thumbnail-retry', t('ui.thumbnail.retry'));
  const actionsRow = el('div', 'thumbnail-actions');
  actionsRow.append(search, gogSearch, retry);
  const manualRow = el('div', 'thumbnail-manual-actions');
  const label = el('label', 'thumbnail-action-label', t('ui.thumbnail.actionLabel'));
  const action = el('select', 'thumbnail-action-select');
  action.setAttribute('aria-label', t('ui.thumbnail.actionLabel'));
  for (const [value, key] of [['file', 'pickFile'], ['folder', 'pickFolder'], ['clear', 'clearManual']]) {
    const option = el('option', null, t(`ui.thumbnail.${key}`)); option.value = value; action.append(option);
  }
  action.value = 'file'; label.append(action);
  const apply = el('button', 'ghost thumbnail-manual-apply', t('ui.thumbnail.runAction'));
  manualRow.append(label, apply);
  const sync = () => {
    const disabled = pendingGames.has(profile.id) || blocked();
    for (const container of [controls, ...document.querySelectorAll('[data-thumbnail-controls-id]')]) {
      if (container.dataset.thumbnailControlsId !== profile.id) continue;
      for (const node of container.querySelectorAll('button, select')) node.disabled = disabled;
    }
  };
  async function run(task, messageKey = 'loading') {
    if (!section.isConnected) return;
    if (pendingGames.has(profile.id) || blocked()) { status.textContent = t('ui.thumbnail.busy'); return; }
    pendingGames.add(profile.id); sync();
    status.textContent = t(`ui.thumbnail.${messageKey}`);
    try { await task(); }
    catch { if (section.isConnected) status.textContent = t('ui.thumbnail.failed'); }
    finally { pendingGames.delete(profile.id); sync(); }
  }
  const selected = (image) => {
    if (!accept(profile.id, image)) throw new Error('No usable image');
    if (section.isConnected) { status.textContent = t('ui.thumbnail.selected'); releaseThumbnailPreviews(results); results.replaceChildren(); }
  };
  async function searchCover(provider) {
    const gog = provider === 'gog';
    const lookup = gog ? gameApi.thumbnailSearchGog : gameApi.thumbnailSearch;
    const choose = gog ? gameApi.thumbnailSelectGog : gameApi.thumbnailSelect;
    if (typeof lookup !== 'function' || typeof choose !== 'function') return;
    await run(async () => {
      releaseThumbnailPreviews(results);
      results.replaceChildren();
      const matches = await lookup(profile.id);
      if (!section.isConnected) return;
      const safe = Array.isArray(matches) ? matches.filter((item) => typeof item?.name === 'string' &&
        typeof (gog ? item?.id : item?.appId) === 'string' &&
        (gog ? /^[1-9]\d{0,19}$/.test(item.id) : /^\d{1,10}$/.test(item.appId))).slice(0, 20) : [];
      status.textContent = safe.length ? t('ui.thumbnail.choose') : t('ui.thumbnail.empty');
      for (const item of safe) {
        const id = gog ? item.id : item.appId;
        const row = el('div', 'thumbnail-result-row');
        const choice = el('button', 'ghost thumbnail-choice', `${item.name} · ${gog ? 'GOG · ' : ''}${id}`);
        choice.type = 'button';
        choice.addEventListener('click', () => void run(async () => selected(await choose(profile.id, id))));
        const preview = el('button', 'ghost thumbnail-preview-toggle', t('ui.thumbnail.preview', undefined, 'Image preview'));
        preview.type = 'button'; preview.setAttribute('aria-label', `${t('ui.thumbnail.preview', undefined, 'Image preview')}: ${item.name}`);
        bindPreview(choice, { toggleButton: preview, label: item.name,
          mode: () => state.libraryPreferences?.previewMode ?? 'hover',
          getThumbnail: async () => typeof gameApi.thumbnailPreview === 'function' ? gameApi.thumbnailPreview(profile.id, provider, id) : null });
        row.append(choice, preview); results.append(row);
      }
    }, 'searching');
  }
  search.addEventListener('click', () => void searchCover('steam'));
  gogSearch.addEventListener('click', () => void searchCover('gog'));
  retry.addEventListener('click', () => void run(async () => {
    await retryImage(cover); if (section.isConnected) status.textContent = '';
  }));
  apply.addEventListener('click', () => void run(async () => {
    if (action.value === 'clear') {
      const image = await gameApi.clearThumbnail(profile.id);
      reset(profile.id, image);
      if (image == null) await retryImage(cover);
      if (section.isConnected) { status.textContent = t('ui.thumbnail.cleared'); releaseThumbnailPreviews(results); results.replaceChildren(); }
      return;
    }
    if (!['file', 'folder'].includes(action.value)) return;
    const image = await gameApi.pickThumbnail(profile.id, action.value === 'folder');
    if (image == null) { if (section.isConnected) status.textContent = t('ui.thumbnail.cancelled'); return; }
    selected(image);
  }));
  section.addEventListener('dragover', (event) => {
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = pendingGames.has(profile.id) || blocked() ? 'none' : 'copy';
    section.classList.toggle('thumbnail-drop-active', !pendingGames.has(profile.id) && !blocked());
  });
  section.addEventListener('dragleave', (event) => {
    if (!section.contains(event.relatedTarget)) section.classList.remove('thumbnail-drop-active');
  });
  section.addEventListener('drop', (event) => {
    event.preventDefault(); event.stopPropagation(); section.classList.remove('thumbnail-drop-active');
    const files = event.dataTransfer?.files;
    if (!files || files.length !== 1 || !usableThumbnailDrop(files[0])) {
      status.textContent = t('ui.thumbnail.invalidDrop'); return;
    }
    void run(async () => selected(await gameApi.importThumbnail(profile.id, files[0])));
  });
  controls.append(el('p', 'thumbnail-help', t('ui.thumbnail.manualHint')), manualRow,
    el('p', 'thumbnail-help', t('ui.thumbnail.searchHint')),
    el('p', 'thumbnail-help', t('ui.thumbnail.gogHint')), actionsRow, status, results);
  section.append(controls); sync();
  return { controls, action, apply, status };
}

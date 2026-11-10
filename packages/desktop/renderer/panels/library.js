/** Sidebar filters and the game list. */

import { $, clear, el } from '../dom.js';
import { currentLocale, t } from '../i18n.js';
import { api, emit, mutationBlocked, state, visibleGames } from '../store.js';
import { archiveRecordForGame, managedInstallationForGame } from '../archive-model.js';
import { releaseThumbnails, thumbnailElement } from '../thumbnail.js';
import { storeLinksForGame } from '../store-model.js';
import { duplicateNameCounts, gameLibrarySettings, LIBRARY_PURCHASE_STORES, normaliseLibraryPreferences } from '../library-preferences.js';

const STORE_NAMES = { steam: 'Steam', epic: 'Epic Games Store', gog: 'GOG', itch: 'itch.io', booth: 'BOOTH', dlsite: 'DLsite', dmm: 'DMM GAMES', fanza: 'FANZA' };
function libraryText(key, ko, en, params) {
  return t(`ui.library.${key}`, params, currentLocale().startsWith('ko') ? ko : en);
}
function purchaseName(id) {
  return STORE_NAMES[id] ?? libraryText('purchaseOther', '기타 구매처', 'Other purchase site');
}

let preferencesStarted = false;
let preferencesWrites = Promise.resolve();
function loadPreferences() {
  if (preferencesStarted || state.libraryPreferencesLoaded) return;
  preferencesStarted = true;
  Promise.resolve().then(() => api.libraryPreferences.read()).then((value) => {
    state.libraryPreferences = normaliseLibraryPreferences(value);
  }).catch(() => { state.libraryPreferencesError = true; }).finally(() => {
    state.libraryPreferencesLoaded = true;
    emit('library');
  });
}
function updatePreferences(change) {
  if (!state.libraryPreferencesLoaded || state.libraryPreferencesError || mutationBlocked()) return Promise.resolve(false);
  state.libraryPreferences = { ...state.libraryPreferences, ...change };
  const snapshot = structuredClone(state.libraryPreferences);
  emit('library');
  const pending = preferencesWrites.then(async () => {
    if (state.libraryPreferencesError) return false;
    await api.libraryPreferences.save(snapshot);
    return true;
  }).catch(() => { state.libraryPreferencesError = true; emit('library'); return false; });
  preferencesWrites = pending.then(() => {});
  return pending;
}

/** Explicit per-copy display labels. A product link never proves purchase or
 * age classification, and these settings never alter a game's payload. */
export function openGameLibraryOptions(game) {
  if (!state.libraryPreferencesLoaded || state.libraryPreferencesError || mutationBlocked() ||
    !state.games.some(entry => entry.id === game?.id)) return null;
  const previous = $('gameLibraryOptions');
  if (previous) { previous.close(); previous.remove(); }
  const dialog = el('dialog', 'library-options-dialog');
  dialog.id = 'gameLibraryOptions'; dialog.dataset.gameId = game.id;
  dialog.setAttribute('aria-labelledby', 'gameLibraryOptionsTitle');
  const heading = el('h2', 'library-options-title', libraryText('optionsTitle', '라이브러리 표시·분류: {name}', 'Library display and labels: {name}', { name: game.title || game.name }));
  heading.id = 'gameLibraryOptionsTitle';
  const settings = gameLibrarySettings(state.libraryPreferences, game.id);
  const hideLabel = el('label', 'library-options-field'), hide = el('input');
  hide.id = 'gameHideListThumbnail'; hide.type = 'checkbox'; hide.checked = settings.hideThumbnail;
  hideLabel.append(hide, el('span', null, libraryText('hideListThumbnail', '이 게임의 목록 섬네일 숨기기', 'Hide this game’s list thumbnail')));
  const adultLabel = el('label', 'library-options-field'), adult = el('select');
  adult.id = 'gameAdultClassification';
  for (const [value, key, ko, en] of [
    ['unclassified', 'adultUnclassified', '미분류', 'Unclassified'],
    ['general', 'adultGeneral', '일반으로 표시', 'Label as general'],
    ['adult', 'adultMarked', '성인용으로 표시', 'Label as adult'],
  ]) { const option = el('option', null, libraryText(key, ko, en)); option.value = value; adult.append(option); }
  adult.value = settings.adult;
  adultLabel.append(el('span', null, libraryText('adultClassification', '성인용 분류 (직접 지정)', 'Adult classification (manual)')), adult);
  const stores = el('fieldset', 'library-purchase-options');
  stores.append(el('legend', null, libraryText('purchaseSites', '구매처 (직접 지정, 여러 곳 선택 가능)', 'Purchase sites (manual, multiple allowed)')));
  const purchaseInputs = [];
  for (const provider of LIBRARY_PURCHASE_STORES) {
    const label = el('label', 'library-purchase-choice'), input = el('input');
    input.type = 'checkbox'; input.name = 'gamePurchaseStore'; input.value = provider; input.checked = settings.purchaseStores.includes(provider);
    label.append(input, el('span', null, purchaseName(provider))); stores.append(label); purchaseInputs.push(input);
  }
  const hint = el('p', 'library-options-hint', libraryText('manualLabelsHint', '사용자가 직접 지정하는 표시예요. 상품 연결이나 폴더 이름으로 구매·연령 등급을 판단하지 않아요.', 'These are your own labels. Product links and folder names do not establish purchase or an age rating.'));
  const status = el('p', 'library-options-status'); status.setAttribute('role', 'status');
  const actions = el('div', 'library-options-actions');
  const save = el('button', 'primary', libraryText('optionsSave', '저장', 'Save'));
  save.id = 'saveGameLibraryOptions'; save.type = 'button';
  const cancel = el('button', 'ghost', libraryText('optionsCancel', '취소', 'Cancel'));
  cancel.id = 'cancelGameLibraryOptions'; cancel.type = 'button';
  let saving = false;
  save.addEventListener('click', () => { void (async () => {
    if (saving || mutationBlocked() || state.libraryPreferencesError || !state.games.some(entry => entry.id === game.id)) return;
    saving = true; save.disabled = true; cancel.disabled = true;
    const next = { hideThumbnail: hide.checked, adult: adult.value, purchaseStores: purchaseInputs.filter(input => input.checked).map(input => input.value) };
    const saved = await updatePreferences({ gameSettings: { ...state.libraryPreferences.gameSettings, [game.id]: next } });
    if (saved) dialog.close();
    else status.textContent = libraryText('preferencesUnavailable', '라이브러리 설정을 읽거나 저장하지 못했어요. 기존 데이터는 유지했어요.', 'Could not load or save library preferences. Existing data was kept.');
    saving = false; save.disabled = state.libraryPreferencesError; cancel.disabled = false;
  })(); });
  cancel.addEventListener('click', () => { if (!saving) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    document.querySelector?.(`[data-game-id="${game.id}"] .library-options`)?.focus();
  });
  actions.append(save, cancel);
  dialog.append(heading, hideLabel, adultLabel, stores, hint, status, actions);
  document.body.append(dialog); dialog.showModal();
  return dialog;
}
function renderLibraryControls() {
  loadPreferences();
  const gamingEngineFilter = $('gamingEngineFilter');
  if (gamingEngineFilter) {
    gamingEngineFilter.replaceChildren();
    for (const entry of [{ id: 'all', title: t('ui.sidebar.allEngines', undefined, 'All engines') },
      ...(state.stats?.byEngine ?? []).map(value => ({ id: value.engineId, title: value.engineName }))]) {
      const option = el('option', null, entry.title); option.value = entry.id; gamingEngineFilter.append(option);
    }
    gamingEngineFilter.value = state.engineFilter;
    gamingEngineFilter.onchange = () => { state.engineFilter = gamingEngineFilter.value; emit('library'); };
  }
  const gamingStatusFilter = $('gamingStatusFilter');
  if (gamingStatusFilter) {
    gamingStatusFilter.value = state.statusFilter;
    gamingStatusFilter.onchange = () => { state.statusFilter = gamingStatusFilter.value; emit('library'); };
  }
  const preferences = state.libraryPreferences;
  const disabled = !state.libraryPreferencesLoaded || state.libraryPreferencesError || mutationBlocked();
  const select = $('librarySort');
  select.disabled = disabled; select.value = preferences.sort;
  select.onchange = () => updatePreferences({ sort: select.value });
  const favorite = $('libraryFavoritesOnly'), duplicate = $('libraryDuplicatesOnly');
  favorite.disabled = disabled; duplicate.disabled = disabled;
  favorite.setAttribute('aria-pressed', String(preferences.favoritesOnly));
  duplicate.setAttribute('aria-pressed', String(preferences.duplicatesOnly));
  favorite.onclick = () => updatePreferences({ favoritesOnly: !state.libraryPreferences.favoritesOnly });
  duplicate.onclick = () => updatePreferences({ duplicatesOnly: !state.libraryPreferences.duplicatesOnly });
  for (const [id, key] of [['libraryPreviewMode', 'previewMode'], ['libraryAdultFilter', 'adultFilter']]) {
    const control = $(id);
    if (control) { control.disabled = disabled; control.value = preferences[key]; control.onchange = () => { void updatePreferences({ [key]: control.value }); }; }
  }
  const purchase = $('libraryPurchaseFilter');
  if (purchase) {
    purchase.replaceChildren();
    for (const value of ['all', 'unassigned', ...LIBRARY_PURCHASE_STORES]) {
      const name = value === 'all' ? libraryText('purchaseAll', '모든 구매처', 'All purchase sites')
        : value === 'unassigned' ? libraryText('purchaseUnassigned', '구매처 미지정', 'No purchase site set') : purchaseName(value);
      const option = el('option', null, name); option.value = value; purchase.append(option);
    }
    purchase.disabled = disabled; purchase.value = preferences.purchaseFilter;
    purchase.onchange = () => { void updatePreferences({ purchaseFilter: purchase.value }); };
  }
  $('libraryPreferencesStatus').textContent = state.libraryPreferencesError
    ? t('ui.library.preferencesUnavailable', undefined, 'Could not load or save library preferences. Existing data was kept.') : '';
}

function operationBadge(gameId) {
  const operation = state.operation;
  if (!operation || operation.gameId !== gameId) return null;
  if (!operation.outcome) {
    return el(
      'span',
      'pill operation-badge active',
      operation.kind === 'uninstall' || operation.kind === 'remove-translator'
        ? t('ui.operation.removingShort', undefined, 'Removing…')
        : t('ui.operation.installingShort', undefined, 'Installing…'),
    );
  }
  if (operation.outcome.status === 'failed') {
    return el('span', 'pill operation-badge err', t('ui.operation.failedShort', undefined, 'Failed'));
  }
  if (operation.outcome.status === 'needs-user-action') {
    return el('span', 'pill operation-badge warn', t('ui.operation.actionShort', undefined, 'Action needed'));
  }
  if (operation.outcome.refreshStatus === 'failed' && operation.outcome.mutationStatus === 'committed') {
    return el('span', 'pill operation-badge warn', t('ui.operation.refreshNeededShort', undefined, 'Refresh needed'));
  }
  if (operation.outcome.status === 'success' && operation.outcome.refreshStatus === 'complete') {
    return el('span', 'pill operation-badge ok', t('ui.operation.completeShort', undefined, 'Complete'));
  }
  return el('span', 'pill operation-badge err', t('ui.operation.failedShort', undefined, 'Failed'));
}

function healthDot(game) {
  const audit = state.audits.get(game.id);
  if (!audit) return game.installedTranslators.length > 0 ? 'ok' : 'none';
  return audit.issues.some((i) => i.severity === 'warn' || i.severity === 'block') ? 'warn' : 'ok';
}

export function renderSidebar(onSelectGame) {
  const list = clear($('engineFilters'));

  const rows = [{ id: 'all', name: t('ui.sidebar.allEngines', undefined, 'All engines'), count: state.games.length }];
  for (const entry of state.stats?.byEngine ?? []) {
    rows.push({ id: entry.engineId, name: entry.engineName, count: entry.count });
  }

  for (const row of rows) {
    const li = el('li');
    const button = el('button');
    button.classList.toggle('active', state.engineFilter === row.id);
    button.append(el('span', null, row.name), el('span', 'count', String(row.count)));
    button.addEventListener('click', () => {
      state.engineFilter = row.id;
      emit('library');
    });
    li.append(button);
    list.append(li);
  }

  for (const button of document.querySelectorAll('#statusFilters button')) {
    button.classList.toggle('active', button.dataset.status === state.statusFilter);
    button.onclick = () => {
      state.statusFilter = button.dataset.status;
      emit('library');
    };
  }
  $('issueCount').textContent = String(state.audits.size);

  // Roots are managed (and listed) exclusively in the settings view now; the
  // sidebar carries only filters, per §7.2 of the UX contract.

  void onSelectGame;
}

export function renderGameList(onSelectGame) {
  renderLibraryControls();
  const container = $('gameList');
  releaseThumbnails(container);
  clear(container);
  const games = visibleGames();

  if (state.games.length === 0) {
    const emptyCard = el('div', 'empty-library');
    emptyCard.append(el('p', null, t('ui.status.emptyLibrary', undefined, 'No games yet — add a folder and scan.')));
    const add = el('button', 'ghost', t('ui.app.addFolder', undefined, 'Add folder'));
    add.disabled = mutationBlocked();
    add.addEventListener('click', () => window.dispatchEvent(new CustomEvent('indiedeck:add-root')));
    emptyCard.append(add);
    container.append(emptyCard);
    $('counts').textContent = '';
    return;
  }

  const duplicates = duplicateNameCounts(state.games);
  const favorites = new Set(state.libraryPreferences.favorites);
  if (games.length === 0) container.append(el('p', 'empty-library', t('ui.library.noMatches', undefined, 'No games match these filters.')));
  for (const game of games) {
    const row = el('div', 'game');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', game.title || game.name);
    row.dataset.gameId = game.id;
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat) onSelectGame(game.id);
    });
    row.classList.toggle('selected', state.selected === game.id);

    const display = gameLibrarySettings(state.libraryPreferences, game.id);
    if (state.libraryPreferencesLoaded && !state.libraryPreferencesError && !display.hideThumbnail) row.append(thumbnailElement(game));
    else {
      // Do not create an image or register an observer while preferences are
      // unknown/failed or the game explicitly hides its list artwork.
      const hidden = el('span', 'thumbnail thumbnail-list thumbnail-list-hidden', '▧');
      hidden.setAttribute('aria-label', libraryText('listThumbnailHidden', '목록 섬네일 숨김', 'List thumbnail hidden'));
      row.append(hidden);
    }

    row.append(el('div', 'name', game.title && game.title !== game.name ? `${game.name} — ${game.title}` : game.name));
    row.append(el('span', `dot ${healthDot(game)}`));
    const isFavorite = favorites.has(game.id);
    const favoriteLabel = isFavorite ? t('ui.library.favoriteRemove', undefined, 'Remove from favorites') : t('ui.library.favoriteAdd', undefined, 'Add to favorites');
    const favoriteButton = el('button', 'favorite-toggle', isFavorite ? '★' : '☆');
    favoriteButton.type = 'button'; favoriteButton.title = favoriteLabel;
    favoriteButton.setAttribute('aria-label', `${favoriteLabel}: ${game.name}`);
    favoriteButton.setAttribute('aria-pressed', String(isFavorite));
    favoriteButton.disabled = !state.libraryPreferencesLoaded || state.libraryPreferencesError || mutationBlocked();
    favoriteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const existing = state.libraryPreferences.favorites;
      updatePreferences({ favorites: existing.includes(game.id) ? existing.filter((id) => id !== game.id) : [...existing, game.id] });
    });
    row.append(favoriteButton);
    const options = el('button', 'library-options', '⋯'); options.type = 'button';
    options.title = libraryText('options', '표시·분류 설정', 'Display and labels');
    options.setAttribute('aria-label', `${options.title}: ${game.title || game.name}`);
    options.disabled = !state.libraryPreferencesLoaded || state.libraryPreferencesError || mutationBlocked();
    options.addEventListener('click', event => { event.stopPropagation(); openGameLibraryOptions(game); });
    row.append(options);

    const meta = el('div', 'meta');
    meta.append(el('span', `badge engine-${game.engineId}`, game.engineName));
    if (display.adult === 'adult') meta.append(el('span', 'pill warn library-adult-badge', libraryText('adultBadge', '성인용 (직접 지정)', 'Adult (manual label)')));
    for (const provider of display.purchaseStores) meta.append(el('span', 'pill library-purchase-badge', libraryText('purchaseBadge', '구매처: {site}', 'Purchased at: {site}', { site: purchaseName(provider) })));
    const connected = new Set(storeLinksForGame(state.archiveCatalog, state.archiveRecords, state.storeConnections?.snapshot, game.id)
      .map(link => link.provider).filter(provider => Object.hasOwn(STORE_NAMES, provider)));
    for (const provider of connected) {
      const badge = el('span', 'pill library-linked-store-badge', libraryText('linkedStoreBadge', '연결: {site}', 'Linked: {site}', { site: purchaseName(provider) }));
      badge.title = libraryText('linkedStoreHint', '상품 페이지 연결이에요. 구매 여부를 확인한 것은 아니에요.', 'A linked product page; purchase ownership has not been verified.');
      meta.append(badge);
    }
    if (duplicates.has(game.id)) {
      const badge = el('span', 'pill warn', t('ui.library.duplicateCount', { count: duplicates.get(game.id) }, 'Same-name candidates: {count}'));
      badge.title = t('ui.library.duplicateHint', undefined, 'Names match; these may be different games or versions. No files are changed.');
      meta.append(badge);
      if (game.path) { const location = el('span', 'duplicate-path', game.path); location.title = game.path; meta.append(location); }
    }
    const runtime = [
      game.unity?.backend && game.unity.backend !== 'unknown' ? game.unity.backend : '',
      game.unity?.version ?? game.engineVersion ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    if (runtime) meta.append(el('span', null, runtime));
    if (game.arch !== 'unknown') meta.append(el('span', null, game.arch));
    const versionRecord = archiveRecordForGame(state.archiveRecords, game.id);
    if (versionRecord) {
      const versionLabel = versionRecord.label
        ? t('ui.archive.listLabel', { label: versionRecord.label }, 'Copy: {label}')
        : versionRecord.versionHint
          ? t('ui.archive.listHint', { version: versionRecord.versionHint }, 'Filename: {version} (?)')
          : t('ui.archive.importedCopy', undefined, 'Imported copy');
      const badge = el('span', 'pill archive-version-label', versionLabel);
      badge.title = versionRecord.archiveName;
      meta.append(badge);
      const managed = managedInstallationForGame(state.archiveCatalog, state.archiveRecords, game.id);
      if (managed) meta.append(el('span', `pill ${managed.active ? 'ok' : 'archive-inactive'}`, managed.active
        ? t('ui.archive.active', undefined, 'Active version')
        : t('ui.archive.inactive', undefined, 'Retained version')));
    }
    const task = operationBadge(game.id);
    if (task) meta.append(task);
    for (const translator of game.installedTranslators) {
      meta.append(
        el(
          'span',
          'pill ok',
          `${translator.translatorId.replace('xunity-autotranslator', 'XUAT')}${translator.version ? ` ${translator.version}` : ''}`,
        ),
      );
    }
    row.append(meta);

    row.addEventListener('click', () => onSelectGame(game.id));
    container.append(row);
  }

  $('counts').textContent = t('ui.app.counts', { shown: games.length, total: state.games.length }, '{shown} of {total} games');
}

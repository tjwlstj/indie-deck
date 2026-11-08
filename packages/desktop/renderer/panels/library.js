/** Sidebar filters and the game list. */

import { $, clear, el } from '../dom.js';
import { t } from '../i18n.js';
import { api, emit, mutationBlocked, state, visibleGames } from '../store.js';
import { archiveRecordForGame, managedInstallationForGame } from '../archive-model.js';
import { releaseThumbnails, thumbnailElement } from '../thumbnail.js';
import { duplicateNameCounts } from '../library-preferences.js';

let preferencesStarted = false;
let preferencesWrites = Promise.resolve();
function loadPreferences() {
  if (preferencesStarted) return;
  preferencesStarted = true;
  Promise.resolve().then(() => api.libraryPreferences.read()).then((value) => {
    state.libraryPreferences = value;
  }).catch(() => { state.libraryPreferencesError = true; }).finally(() => {
    state.libraryPreferencesLoaded = true;
    emit('library');
  });
}
function updatePreferences(change) {
  if (!state.libraryPreferencesLoaded || state.libraryPreferencesError) return;
  state.libraryPreferences = { ...state.libraryPreferences, ...change };
  const snapshot = structuredClone(state.libraryPreferences);
  emit('library');
  preferencesWrites = preferencesWrites.then(async () => {
    if (!state.libraryPreferencesError) await api.libraryPreferences.save(snapshot);
  }).catch(() => { state.libraryPreferencesError = true; emit('library'); });
}
function renderLibraryControls() {
  loadPreferences();
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
    row.classList.toggle('selected', state.selected === game.id);

    row.append(thumbnailElement(game));

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

    const meta = el('div', 'meta');
    meta.append(el('span', `badge engine-${game.engineId}`, game.engineName));
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

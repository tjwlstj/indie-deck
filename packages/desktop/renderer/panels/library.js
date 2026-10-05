/** Sidebar filters and the game list. */

import { $, clear, el } from '../dom.js';
import { t } from '../i18n.js';
import { emit, mutationBlocked, state, visibleGames } from '../store.js';

function operationBadge(gameId) {
  const operation = state.operation;
  if (!operation || operation.gameId !== gameId) return null;
  if (!operation.outcome) {
    return el(
      'span',
      'pill operation-badge active',
      operation.kind === 'uninstall'
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
  const container = clear($('gameList'));
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

  for (const game of games) {
    const row = el('div', 'game');
    row.classList.toggle('selected', state.selected === game.id);

    row.append(el('div', 'name', game.title && game.title !== game.name ? `${game.name} — ${game.title}` : game.name));
    row.append(el('span', `dot ${healthDot(game)}`));

    const meta = el('div', 'meta');
    meta.append(el('span', `badge engine-${game.engineId}`, game.engineName));
    const runtime = [
      game.unity?.backend && game.unity.backend !== 'unknown' ? game.unity.backend : '',
      game.unity?.version ?? game.engineVersion ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    if (runtime) meta.append(el('span', null, runtime));
    if (game.arch !== 'unknown') meta.append(el('span', null, game.arch));
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

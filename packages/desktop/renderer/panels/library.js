/** Sidebar filters and the game list. */

import { $, clear, el } from '../dom.js';
import { t } from '../i18n.js';
import { api, emit, state, visibleGames } from '../store.js';

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

  const roots = clear($('rootList'));
  const configured = state.config?.roots ?? [];
  if (configured.length === 0) {
    const li = el('li');
    li.append(el('span', 'path', t('ui.sidebar.noRoots', undefined, 'none configured')));
    roots.append(li);
  }
  for (const root of configured) {
    const li = el('li');
    li.append(el('span', 'path', root));
    const remove = el('button', null, '×');
    remove.title = t('ui.sidebar.stopScanning', { root }, 'Stop scanning {root}');
    remove.addEventListener('click', async () => {
      state.config = await api.roots.remove(root);
      emit('library');
    });
    li.append(remove);
    roots.append(li);
  }

  void onSelectGame;
}

export function renderGameList(onSelectGame) {
  const container = clear($('gameList'));
  const games = visibleGames();

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

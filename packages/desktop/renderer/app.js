/**
 * Launcher boot and wiring.
 *
 * The renderer is plain ES modules over the IPC bridge in preload.cjs - no
 * framework and no build step. Everything that decides anything lives in
 * @indiedeck/core, on the other side of the boundary.
 */

import { $, el, setStatus } from './dom.js';
import { applyStaticTranslations, t } from './i18n.js';
import { renderGameList, renderSidebar } from './panels/library.js';
import { SECTIONS } from './panels/index.js';
import { resetConfigPanel } from './panels/config.js';
import {
  populateDefaultsForm,
  populateLocaleSelect,
  renderAbout,
  renderRoots,
} from './panels/settings.js';
import { api, applyLibraryPayload, emit, loadLocale, resolveOptions, state, subscribe } from './store.js';

/* --------------------------------------------------------------- render */

function renderDetail() {
  const panel = $('detail');
  panel.replaceChildren();

  if (!state.detail) {
    const empty = el('div', 'empty');
    empty.append(el('p', 'empty-title', t('ui.detail.emptyTitle', undefined, 'Pick a game')));
    empty.append(
      el(
        'p',
        null,
        t(
          'ui.detail.emptyBody',
          undefined,
          'IndieDeck reads its engine, backend and version, then works out which translator build actually fits it.',
        ),
      ),
    );
    panel.append(empty);
    return;
  }

  for (const section of SECTIONS) {
    if (section.when && !section.when(state.detail)) continue;
    section.render(panel, state.detail, refreshDetail, installPlan);
  }
}

function renderView() {
  document.body.dataset.view = state.view;
  $('libraryView').hidden = state.view !== 'library';
  $('settingsView').hidden = state.view !== 'settings';
}

function render(scope = 'all') {
  if (state.view === 'settings') return; // the settings view owns the screen
  if (scope === 'all' || scope === 'library') {
    renderSidebar(selectGame);
    renderGameList(selectGame);
  }
  if (scope === 'all' || scope === 'detail') renderDetail();
}

subscribe(render);

/* -------------------------------------------------------------- actions */

async function selectGame(gameId, options = {}) {
  if (state.selected !== gameId) resetConfigPanel();
  state.selected = gameId;
  if (!options.keepScroll) $('detail').scrollTop = 0;
  renderGameList(selectGame);

  setStatus(t('ui.status.reading', undefined, 'Reading game folder…'));
  try {
    state.detail = await api.game.detail(gameId, resolveOptions());
    setStatus(t('ui.app.ready', undefined, 'Ready'));
  } catch (err) {
    state.detail = null;
    setStatus(err.message, 'err');
  }
  renderDetail();
}

/** Re-reads the selected game without moving the scroll position. */
async function refreshDetail(options = {}) {
  if (!state.selected) return;
  await selectGame(state.selected, { keepScroll: true, ...options });
}

/** Shows a transient task chip in the top bar while a mutation runs. */
function setTaskStatus(text) {
  const node = $('taskStatus');
  node.hidden = !text;
  node.textContent = text ?? '';
}

async function installPlan(plan) {
  state.busy = true;
  setTaskStatus(t('ui.status.installingShort', undefined, 'Installing…'));
  renderDetail();

  const log = el('div', 'log');
  log.id = 'installLog';
  $('detail').append(log);

  const offLog = api.on.installProgress((line) => {
    log.textContent += `${line}\n`;
    log.scrollTop = log.scrollHeight;
  });
  const offBytes = api.on.installBytes(({ received, total }) => {
    if (total > 0) {
      const percent = Math.round((received / total) * 100);
      setStatus(t('ui.status.downloading', { percent }, 'Downloading… {percent}%'));
      setTaskStatus(t('ui.status.downloading', { percent }, 'Downloading… {percent}%'));
    }
  });

  try {
    setStatus(
      t('ui.status.installing', { translator: plan.translatorName, version: plan.version }, 'Installing {translator} {version}…'),
    );
    const result = await api.game.install(state.selected, plan.id, {});
    for (const step of result.performed) log.textContent += `${step.status === 'done' ? '✓' : '·'} ${step.step.description}\n`;
    for (const action of result.pendingUserActions) log.textContent += `! ${action}\n`;
    setStatus(t('ui.status.installed', { count: result.filesWritten.length }, 'Installed — {count} files written'), 'ok');
    await refreshLibraryView(false);
    await refreshDetail();
  } catch (err) {
    setStatus(err.message, 'err');
    log.textContent += `× ${err.message}\n`;
  } finally {
    offLog();
    offBytes();
    state.busy = false;
    setTaskStatus(null);
    // The plan buttons and the sticky Play were disabled by state.busy.
    renderDetail();
  }
}

async function refreshLibraryView(rescan) {
  const scanButton = $('scan');
  scanButton.disabled = true;
  let offProgress = () => {};
  try {
    if (rescan) {
      setStatus(t('ui.status.scanningShort', undefined, 'Scanning…'));
      setTaskStatus(t('ui.status.scanningShort', undefined, 'Scanning…'));
      offProgress = api.on.scanProgress((current) => setStatus(t('ui.status.scanning', { path: current }, 'Scanning {path}')));
    }
    const payload = rescan ? await api.library.scan({}) : await api.library.load();
    applyLibraryPayload(payload);
    setStatus(
      payload.index.games.length === 0
        ? t('ui.status.emptyLibrary', undefined, 'No games yet — add a folder and scan.')
        : t('ui.app.ready', undefined, 'Ready'),
      'ok',
    );
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    offProgress();
    scanButton.disabled = false;
    setTaskStatus(null);
    // A structural signal the CI smoke test can wait on. Keying off the status
    // text would break the moment the UI is translated.
    document.body.dataset.libraryState = 'ready';
    emit('all');
  }
}

/* ------------------------------------------------------------- language */

async function changeLocale(locale) {
  state.config = await api.config.set({ ...state.config, locale });
  await loadLocale();
  applyStaticTranslations();
  populateLocaleSelect();
  // Core renders findings and audit messages at creation time, so the library
  // and the open game are re-fetched to pick up the new language.
  await refreshLibraryView(false);
  if (state.selected) await refreshDetail();
}

/* ------------------------------------------------------------ settings */

function openSettings() {
  state.view = 'settings';
  renderAbout();
  renderRoots();
  populateLocaleSelect();
  populateDefaultsForm(state.registry.translators.find((x) => x.id === 'xunity-autotranslator')?.endpoints ?? []);
  renderView();
}

function closeSettings() {
  state.view = 'library';
  // Preserve selection and detail; only re-render what the library needs.
  renderView();
  emit('all');
}

let savingDefaults = false;

async function saveDefaults() {
  if (savingDefaults) return;
  savingDefaults = true;
  const saveButton = $('saveDefaults');
  saveButton.disabled = true;
  $('defaultsSaved').textContent = t('ui.settings.saving', undefined, 'Saving…');
  try {
    state.config = await api.config.set({
      ...state.config,
      defaults: {
        targetLanguage: $('targetLanguage').value,
        sourceLanguage: $('sourceLanguage').value,
        endpoint: $('endpoint').value,
      },
    });
    $('defaultsSaved').textContent = t('ui.settings.saved', undefined, 'Saved');
    // Plans and audits were computed with the old defaults (§7.2).
    if (state.selected) await refreshDetail();
  } catch (err) {
    $('defaultsSaved').textContent = err.message;
  } finally {
    saveButton.disabled = false;
    savingDefaults = false;
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  await loadLocale();
  state.appInfo = await api.app.info();
  state.registry = await api.registry();
  state.config = await api.config.get();

  applyStaticTranslations();
  renderAbout();
  populateLocaleSelect();

  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);

  $('targetLanguage').addEventListener('change', () => ($('defaultsSaved').textContent = ''));
  $('sourceLanguage').addEventListener('change', () => ($('defaultsSaved').textContent = ''));
  $('endpoint').addEventListener('change', () => ($('defaultsSaved').textContent = ''));
  $('saveDefaults').addEventListener('click', () => void saveDefaults());

  // The empty-library card in the list column also offers "add folder"; it
  // signals through a window event so library.js stays free of boot wiring.
  window.addEventListener('indiedeck:add-root', async () => {
    const picked = await api.roots.pick();
    if (!picked) return;
    state.config = await api.config.get();
    renderRoots();
    await refreshLibraryView(true);
  });

  $('search').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderGameList(selectGame);
  });

  $('scan').addEventListener('click', () => refreshLibraryView(true));
  $('rescanRoots').addEventListener('click', () => refreshLibraryView(true));
  $('addRoot').addEventListener('click', async () => {
    const picked = await api.roots.pick();
    if (!picked) return;
    state.config = await api.config.get();
    renderRoots();
    await refreshLibraryView(true);
  });

  await refreshLibraryView(false);
}

boot().catch((err) => setStatus(err.message, 'err'));

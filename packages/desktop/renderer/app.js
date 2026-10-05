/**
 * Launcher boot and wiring.
 *
 * Filesystem decisions stay in main/core. The renderer owns only correlation,
 * revision ordering and presentation of the privileged operation's snapshots.
 */

import { $, setStatus } from './dom.js';
import { applyStaticTranslations, t } from './i18n.js';
import { renderGameList, renderSidebar } from './panels/library.js';
import { SECTIONS } from './panels/index.js';
import { resetConfigPanel } from './panels/config.js';
import { operationCard } from './panels/detail.js';
import { refreshMToolStatus } from './panels/mtool.js';
import {
  populateDefaultsForm,
  populateLocaleSelect,
  renderAbout,
  renderRoots,
  setSettingsMutationDisabled,
} from './panels/settings.js';
import {
  api,
  applyLibraryPayload,
  emit,
  loadLocale,
  mutationBlocked,
  resolveOptions,
  state,
  subscribe,
} from './store.js';
import {
  acceptDetailResponse,
  applyOperationHandshake,
  createProvisionalOperation,
  mergePostMutationState,
  recoverRetainedOutcome,
  reduceOperationOutcome,
  reduceOperationProgress,
  restoreOperationSnapshot,
} from './state-model.js';

let bootReady = false;
let libraryBusy = false;
let savingDefaults = false;
let detailLoadingGameId = null;
const handledOutcomes = new Map();

/* --------------------------------------------------------------- render */

function renderDetail() {
  const panel = $('detail');
  panel.replaceChildren();

  if (!state.detail) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = state.selected && detailLoadingGameId === state.selected
      ? t('ui.status.reading', undefined, 'Reading game folder…')
      : t('ui.detail.emptyTitle', undefined, 'Pick a game');
    const body = document.createElement('p');
    body.textContent = t(
      'ui.detail.emptyBody',
      undefined,
      'IndieDeck reads its engine, backend and version, then works out which translator build actually fits it.',
    );
    empty.append(title, body);
    if (state.selected && state.operation?.gameId === state.selected) {
      const gameId = state.selected;
      const openFolder = document.createElement('button');
      openFolder.className = 'ghost';
      openFolder.textContent = t('ui.detail.openFolder', undefined, 'Open folder');
      openFolder.addEventListener('click', async () => {
        try {
          await api.game.openFolder(gameId);
        } catch (err) {
          setStatus(err.message, 'err');
        }
      });
      empty.append(openFolder, operationCard(state.operation));
    }
    panel.append(empty);
    return;
  }

  for (const section of SECTIONS) {
    if (section.when && !section.when(state.detail)) continue;
    section.render(panel, state.detail, refreshDetail, installPlan, uninstallGame);
  }
}

function renderView() {
  document.body.dataset.view = state.view;
  $('libraryView').hidden = state.view !== 'library';
  $('settingsView').hidden = state.view !== 'settings';
}

function operationLabel(operation) {
  if (!operation) return '';
  if (operation.outcome) {
    if (operation.outcome.status === 'failed') {
      return t('ui.operation.failedShort', undefined, 'Failed');
    }
    if (operation.outcome.status === 'needs-user-action') {
      return t('ui.operation.actionShort', undefined, 'Action needed');
    }
    if (operation.outcome.refreshStatus === 'failed' && operation.outcome.mutationStatus === 'committed') {
      return t('ui.operation.refreshNeededShort', undefined, 'Refresh needed');
    }
    if (operation.outcome.status === 'success' && operation.outcome.refreshStatus === 'complete') {
      return t('ui.operation.completeShort', undefined, 'Complete');
    }
    return t('ui.operation.failedShort', undefined, 'Failed');
  }
  if (operation.descriptionKey) {
    return t(operation.descriptionKey, operation.descriptionParams, operation.description ?? operation.phase);
  }
  return t(`ui.operation.phase.${operation.phase}`, operation.descriptionParams, operation.description ?? operation.phase);
}

/** Global operation chrome remains visible in both the library and settings. */
function renderOperationChrome() {
  const operation = state.operation;
  const task = $('taskStatus');
  if (operation) {
    task.hidden = false;
    task.textContent = operationLabel(operation);
    task.classList.toggle('terminal', Boolean(operation.outcome));
    task.classList.toggle('failed', Boolean(operation.outcome && operation.outcome.status === 'failed'));
    task.classList.toggle(
      'warning',
      Boolean(
        operation.outcome &&
          operation.outcome.status !== 'failed' &&
          (operation.outcome.status === 'needs-user-action' || operation.outcome.refreshStatus === 'failed'),
      ),
    );
  } else if (!libraryBusy) {
    task.hidden = true;
    task.textContent = '';
    task.classList.remove('terminal', 'failed', 'warning');
  }

  $('scan').disabled = libraryBusy || mutationBlocked();
  setSettingsMutationDisabled();
}

function render(scope = 'all') {
  renderOperationChrome();
  if (!bootReady) return;
  if (state.view === 'settings') return;
  if (scope === 'all' || scope === 'library' || scope === 'operation') {
    renderSidebar(selectGame);
    renderGameList(selectGame);
  }
  if (scope === 'all' || scope === 'detail' || scope === 'operation') renderDetail();
}

subscribe(render);

/* ------------------------------------------------------- selection/races */

async function selectGame(gameId, options = {}) {
  const changed = state.selected !== gameId;
  if (changed) {
    resetConfigPanel();
    // Do not leave the previous game's mutating actions live while the next
    // detail request is in flight.
    state.detail = null;
  }
  state.selected = gameId;
  detailLoadingGameId = gameId;
  const selectionToken = ++state.selectionRequestToken;
  if (!options.keepScroll) $('detail').scrollTop = 0;
  renderGameList(selectGame);

  setStatus(t('ui.status.reading', undefined, 'Reading game folder…'));
  if (changed) renderDetail();
  try {
    const response = await api.game.detail(gameId, resolveOptions());
    if (!acceptDetailResponse(state, gameId, selectionToken, response)) return;
    detailLoadingGameId = null;
    setStatus(t('ui.app.ready', undefined, 'Ready'));
  } catch (err) {
    if (state.selected !== gameId || state.selectionRequestToken !== selectionToken) return;
    detailLoadingGameId = null;
    state.detail = null;
    setStatus(err.message, 'err');
  }
  renderDetail();
}

async function refreshDetail(options = {}) {
  const gameId = state.selected;
  if (!gameId) return;
  await selectGame(gameId, { keepScroll: true, ...options });
}

/* --------------------------------------------------------- maintenance */

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `renderer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function showOperationState() {
  emit('operation');
}

async function startMaintenance(kind, gameId, planId) {
  if (mutationBlocked()) return;
  const id = requestId();
  state.operation = createProvisionalOperation({ requestId: id, gameId, kind, planId });
  setStatus(
    kind === 'uninstall'
      ? t('ui.status.removing', undefined, 'Removing…')
      : kind === 'install-font'
        ? t('ui.operation.installingFont', undefined, 'Installing recommended font')
        : t('ui.status.installingShort', undefined, 'Installing…'),
  );
  // Render before awaiting IPC so the loading state is visible in this frame.
  showOperationState();

  try {
    const handshake = await api.maintenance.start({ kind, gameId, ...(planId ? { planId } : {}), requestId: id });
    state.operation = applyOperationHandshake(state.operation, handshake);
    showOperationState();
  } catch (err) {
    if (state.operation?.requestId === id && !state.operation.operationId) state.operation = null;
    setStatus(err.message, 'err');
    showOperationState();
  }
}

function installPlan(gameId, plan) {
  if (!gameId || state.selected !== gameId) return;
  void startMaintenance(plan.purpose === 'font' ? 'install-font' : 'install', gameId, plan.id);
}

function uninstallGame(gameId) {
  if (!gameId || state.selected !== gameId) return;
  void startMaintenance('uninstall', gameId);
}

function outcomeStatus(outcome) {
  if (outcome.status === 'failed' && outcome.mutationStatus === 'committed') {
    return t(
      'ui.operation.failedCommitted',
      undefined,
      'Changes were applied, but the install record or final step failed. Review the error and current game state.',
    );
  }
  if (outcome.status === 'needs-user-action') {
    return t('ui.operation.needsAction', undefined, 'Automatic steps finished — more action is required.');
  }
  if (outcome.status === 'success') {
    if (outcome.refreshStatus === 'failed') {
      return t('ui.operation.refreshFailed', undefined, 'The file operation finished, but the latest state could not be loaded.');
    }
    return outcome.kind === 'uninstall'
      ? t('ui.operation.removeComplete', undefined, 'Removal complete')
      : outcome.kind === 'install-font'
        ? t('ui.operation.fontComplete', undefined, 'Recommended font setup complete')
        : t('ui.operation.installComplete', undefined, 'Installation complete');
  }
  if (outcome.mutationStatus === 'rolled-back' && outcome.rollbackStatus === 'not-run') {
    return t('ui.operation.stoppedBeforeChanges', undefined, 'The task stopped before any game files were changed.');
  }
  if (outcome.rollbackStatus === 'complete') {
    return t('ui.operation.failedRolledBack', undefined, 'The task failed. Changes were rolled back.');
  }
  return t('ui.operation.failedRollbackPartial', undefined, 'The task failed and some changes could not be restored.');
}

function onMaintenanceProgress(progress) {
  const next = reduceOperationProgress(state.operation, progress);
  if (next === state.operation) return;
  state.operation = next;
  setStatus(operationLabel(next));
  showOperationState();
}

async function onMaintenanceOutcome(outcome, { present = true } = {}) {
  const previous = handledOutcomes.get(outcome.operationId) ?? -1;
  if (Number(outcome.sequence) <= previous) return;
  handledOutcomes.set(outcome.operationId, Number(outcome.sequence));

  const merged = outcome.postState
    ? mergePostMutationState(state, outcome.postState)
    : { library: false, detail: false, translatorConfig: false };
  if (state.selected === outcome.gameId && (merged.detail || merged.translatorConfig)) resetConfigPanel();

  const current = state.operation;
  const belongsToCurrent =
    !current ||
    (current.requestId === outcome.requestId && (!current.operationId || current.operationId === outcome.operationId));
  if (present) {
    const next = reduceOperationOutcome(current, outcome);
    if (next !== current) state.operation = next;
  }

  if (present && belongsToCurrent) {
    const tone =
      outcome.status === 'success' && outcome.refreshStatus === 'complete'
        ? 'ok'
        : outcome.status === 'failed' && outcome.rollbackStatus !== 'complete' && outcome.mutationStatus !== 'rolled-back'
          ? 'err'
          : undefined;
    setStatus(outcomeStatus(outcome), tone);
  }
  emit('all');

  // Main keeps terminal outcomes until the renderer has merged the postState.
  // ACK happens after the render commit, never merely because the event arrived.
  try {
    await api.maintenance.acknowledge(outcome.operationId);
  } catch (err) {
    console.warn(`Could not acknowledge operation ${outcome.operationId}: ${err.message}`);
  }
}

function bindMaintenanceEvents() {
  // Exactly one subscription for the lifetime of this renderer document.
  api.on.maintenanceProgress(onMaintenanceProgress);
  api.on.maintenanceOutcome((outcome) => void onMaintenanceOutcome(outcome));
}

async function recoverMaintenance() {
  const snapshot = await api.maintenance.current();
  state.operation = restoreOperationSnapshot(state.operation, snapshot.active);
  const outcomes = snapshot.outcomes ?? [];
  if (state.operation && !state.operation.outcome) {
    for (const outcome of outcomes) await onMaintenanceOutcome(outcome);
  } else {
    // Merge and ACK every retained post-state without allowing the oldest
    // result to become the only visible card. Feature the newest after all
    // results have been consumed.
    const recovered = recoverRetainedOutcome(state.operation, outcomes);
    for (const outcome of outcomes) await onMaintenanceOutcome(outcome, { present: false });
    if (recovered?.outcome) {
      state.operation = recovered;
      setStatus(outcomeStatus(recovered.outcome), recovered.outcome.status === 'failed' ? 'err' : undefined);
    }
  }
  showOperationState();
}

async function retryOperationRefresh() {
  const operation = state.operation;
  if (!operation?.outcome || operation.outcome.refreshStatus !== 'failed' || operation.refreshing) return;
  const operationId = operation.operationId;
  state.operation = { ...operation, refreshing: true };
  setStatus(t('ui.operation.refreshingState', undefined, 'Refreshing game state…'));
  emit('operation');
  try {
    const postState = await api.game.refresh(operation.gameId);
    if (state.operation?.operationId !== operationId) return;
    if (state.selected === operation.gameId) resetConfigPanel();
    mergePostMutationState(state, postState);
    state.operation = {
      ...operation,
      refreshing: false,
      refreshStatus: 'complete',
      postState,
      outcome: { ...operation.outcome, refreshStatus: 'complete', refreshError: undefined, postState },
    };
    setStatus(t('ui.operation.stateRefreshed', undefined, 'Game state refreshed'), 'ok');
    emit('all');
  } catch (err) {
    if (state.operation?.operationId === operationId) {
      state.operation = { ...operation, refreshing: false };
      emit('operation');
    }
    setStatus(err.message, 'err');
  }
}

/* --------------------------------------------------------- library load */

function setTransientTask(text) {
  if (state.operation) return;
  const node = $('taskStatus');
  node.hidden = !text;
  node.textContent = text ?? '';
}

async function refreshLibraryView(rescan) {
  if (rescan && mutationBlocked()) return;
  libraryBusy = true;
  renderOperationChrome();
  let offProgress = () => {};
  try {
    if (rescan) {
      setStatus(t('ui.status.scanningShort', undefined, 'Scanning…'));
      setTransientTask(t('ui.status.scanningShort', undefined, 'Scanning…'));
      offProgress = api.on.scanProgress((current) => setStatus(t('ui.status.scanning', { path: current }, 'Scanning {path}')));
    }
    const payload = rescan ? await api.library.scan({}) : await api.library.load();
    const applied = applyLibraryPayload(payload);
    if (applied) {
      if (state.selected && !state.games.some((game) => game.id === state.selected)) {
        state.selected = null;
        state.detail = null;
        detailLoadingGameId = null;
        state.selectionRequestToken += 1;
        resetConfigPanel();
      }
      setStatus(
        payload.index.games.length === 0
          ? t('ui.status.emptyLibrary', undefined, 'No games yet — add a folder and scan.')
          : t('ui.app.ready', undefined, 'Ready'),
        'ok',
      );
    }
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    offProgress();
    libraryBusy = false;
    setTransientTask(null);
    document.body.dataset.libraryState = 'ready';
    emit('all');
  }
}

/* ------------------------------------------------------------- settings */

async function changeLocale(locale) {
  if (mutationBlocked()) return;
  state.config = await api.config.set({ ...state.config, locale });
  await loadLocale();
  applyStaticTranslations();
  populateLocaleSelect();
  await refreshLibraryView(false);
  if (state.selected) await refreshDetail();
}

function openSettings() {
  state.view = 'settings';
  renderAbout();
  renderRoots();
  populateLocaleSelect();
  populateDefaultsForm(state.registry.translators.find((x) => x.id === 'xunity-autotranslator')?.endpoints ?? []);
  renderView();
  renderOperationChrome();
  void refreshMToolStatus().catch((err) => setStatus(err.message, 'err'));
}

function closeSettings() {
  state.view = 'library';
  renderView();
  emit('all');
}

async function saveDefaults() {
  if (savingDefaults || mutationBlocked()) return;
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
    if (state.selected) await refreshDetail();
  } catch (err) {
    $('defaultsSaved').textContent = err.message;
  } finally {
    savingDefaults = false;
    setSettingsMutationDisabled();
  }
}

async function pickRootAndScan() {
  if (mutationBlocked()) return;
  try {
    const picked = await api.roots.pick();
    if (!picked) return;
    state.config = await api.config.get();
    renderRoots();
    await refreshLibraryView(true);
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  // Subscribe before asking for a snapshot so no progress/outcome can fall in
  // the gap between renderer creation and reload recovery.
  bindMaintenanceEvents();
  const recovery = recoverMaintenance().catch((err) => setStatus(err.message, 'err'));

  await loadLocale();
  state.appInfo = await api.app.info();
  state.registry = await api.registry();
  state.config = await api.config.get();
  await refreshMToolStatus();

  applyStaticTranslations();
  renderAbout();
  populateLocaleSelect();

  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('taskStatus').addEventListener('click', () => {
    const gameId = state.operation?.gameId;
    if (!gameId || !state.games.some((game) => game.id === gameId)) return;
    state.view = 'library';
    renderView();
    void selectGame(gameId, { keepScroll: true });
  });

  $('uiLocale').addEventListener('change', (event) => void changeLocale(event.target.value));
  $('targetLanguage').addEventListener('change', () => ($('defaultsSaved').textContent = ''));
  $('sourceLanguage').addEventListener('change', () => ($('defaultsSaved').textContent = ''));
  $('endpoint').addEventListener('change', () => ($('defaultsSaved').textContent = ''));
  $('saveDefaults').addEventListener('click', () => void saveDefaults());

  window.addEventListener('indiedeck:add-root', () => void pickRootAndScan());
  window.addEventListener('indiedeck:open-settings', (event) => {
    openSettings();
    const section = event.detail?.section;
    if (section === 'mtoolSettings') $('mtoolSettings')?.scrollIntoView({ block: 'nearest' });
  });
  window.addEventListener('indiedeck:refresh-detail', () => void refreshDetail());
  window.addEventListener('indiedeck:dismiss-operation', () => {
    if (!state.operation?.outcome) return;
    state.operation = null;
    emit('operation');
  });
  window.addEventListener('indiedeck:refresh-operation-state', () => void retryOperationRefresh());

  $('search').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderGameList(selectGame);
  });
  $('scan').addEventListener('click', () => void refreshLibraryView(true));
  $('rescanRoots').addEventListener('click', () => void refreshLibraryView(true));
  $('addRoot').addEventListener('click', () => void pickRootAndScan());

  await recovery;
  bootReady = true;
  await refreshLibraryView(false);
}

boot().catch((err) => setStatus(err.message, 'err'));

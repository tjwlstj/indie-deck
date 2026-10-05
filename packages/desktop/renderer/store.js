/**
 * Renderer state and the IPC surface.
 *
 * Everything the UI knows lives here; panels read it and call `refresh()` /
 * `selectGame()` rather than holding their own copies. Games and plans are
 * addressed by opaque id for privileged calls. The renderer may display paths
 * returned by main, but it cannot choose arbitrary filesystem targets.
 */

import { applyCatalog } from './i18n.js';
import { isOperationActive, mergeLibraryPayload } from './state-model.js';
import { isArchiveActive } from './archive-model.js';
import { launcherUpdateInstallPending } from './update-model.js';
import { isScanActive } from './scan-model.js';

export const api = window.indiedeck;

export const state = {
  games: [],
  audits: new Map(),
  stats: null,
  config: null,
  mtoolStatus: null,
  mtoolStatusLoading: false,
  mtoolStatusRequestToken: 0,
  /** Only the handoff/config IPC request is pending, not external translation. */
  mtoolBusy: false,
  archiveRecords: [],
  archiveRecordsLoaded: false,
  archiveCandidate: null,
  archiveLabel: '',
  archiveProgress: null,
  archiveBusy: false,
  updateStatus: null,
  updateStatusLoading: false,
  updateStatusRequestToken: 0,
  updateReadError: false,
  updateAction: null,
  /** Main-owned scan snapshot, retained so reloads can show progress/cancel. */
  scanStatus: null,
  scanRequestPending: false,
  scanCancelPendingId: null,
  scanDismissedSequence: -1,
  registry: null,
  engineFilter: 'all',
  statusFilter: 'all',
  query: '',
  selected: null,
  detail: null,
  /** The one global install/removal operation, active or retained terminal. */
  operation: null,
  libraryRevision: 0,
  gameRevisions: new Map(),
  translatorConfigs: new Map(),
  selectionRequestToken: 0,
  /** App-level view. Settings stays in this document - no navigation, so the
   * CSP and IPC boundary of the single window are untouched (§7.3). */
  view: 'library',
  appInfo: { version: '', portable: false },
};

/** Panels subscribe so a state change re-renders them without a framework. */
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(scope = 'all') {
  for (const fn of listeners) fn(scope);
}

export function visibleGames() {
  const query = state.query.trim().toLowerCase();
  return state.games.filter((game) => {
    if (state.engineFilter !== 'all' && game.engineId !== state.engineFilter) return false;
    if (state.statusFilter === 'untranslated' && game.installedTranslators.length > 0) return false;
    if (state.statusFilter === 'translated' && game.installedTranslators.length === 0) return false;
    if (state.statusFilter === 'issues' && !state.audits.has(game.id)) return false;
    if (query) {
      const haystack = `${game.name} ${game.title ?? ''} ${game.engineName}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/**
 * Options for plan resolution come from the saved config, never from DOM ids
 * (§7.2): the top bar no longer owns language/endpoint selects, so reading
 * `document.getElementById(...)` here would throw. Unsaved edits in the
 * settings view only affect plans after the user presses save.
 */
export function resolveOptions() {
  const defaults = state.config?.defaults ?? {};
  return {
    targetLanguage: defaults.targetLanguage ?? 'en',
    sourceLanguage: defaults.sourceLanguage ?? 'ja',
    endpoint: defaults.endpoint ?? 'GoogleTranslate',
  };
}

export function applyLibraryPayload(payload) {
  const previousGameIds = new Set(state.games.map((game) => game.id));
  const applied = mergeLibraryPayload(state, payload);
  if (!applied) return false;

  const remainingGameIds = new Set(state.games.map((game) => game.id));
  for (const gameId of previousGameIds) {
    if (remainingGameIds.has(gameId)) continue;
    // Main drops revision authority when a game leaves the library. Mirroring
    // that reset prevents a later re-add of the same path from being rejected
    // as older than the renderer's now-orphaned revision cache.
    state.gameRevisions.delete(gameId);
    state.translatorConfigs.delete(gameId);
  }
  return true;
}

export function mutationBlocked() {
  return isOperationActive(state.operation) || state.mtoolBusy || state.archiveBusy || isArchiveActive(state.archiveProgress) ||
    state.scanRequestPending || isScanActive(state.scanStatus) ||
    launcherUpdateInstallPending(state.updateStatus, state.updateAction);
}

/** Pulls the catalogue for the active language and applies it. */
export async function loadLocale() {
  applyCatalog(await api.i18n.get());
}

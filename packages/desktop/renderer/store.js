/**
 * Renderer state and the IPC surface.
 *
 * Everything the UI knows lives here; panels read it and call `refresh()` /
 * `selectGame()` rather than holding their own copies. Games and plans are
 * addressed by opaque id - the renderer never sees or sends a filesystem path.
 */

import { applyCatalog } from './i18n.js';

export const api = window.indiedeck;

export const state = {
  games: [],
  audits: new Map(),
  stats: null,
  config: null,
  registry: null,
  engineFilter: 'all',
  statusFilter: 'all',
  query: '',
  selected: null,
  detail: null,
  busy: false,
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

export function resolveOptions() {
  return {
    targetLanguage: document.getElementById('targetLanguage').value,
    sourceLanguage: document.getElementById('sourceLanguage').value,
    endpoint: document.getElementById('endpoint').value,
  };
}

export function applyLibraryPayload(payload) {
  state.games = payload.index.games;
  state.stats = payload.stats;
  state.audits = new Map(payload.audits.map((audit) => [audit.id, audit]));
}

/** Pulls the catalogue for the active language and applies it. */
export async function loadLocale() {
  applyCatalog(await api.i18n.get());
}

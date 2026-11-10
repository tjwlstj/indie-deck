/** Launcher-owned display choices. Store and adult labels are explicit user
 * assertions; never infer purchase ownership or content from names or links. */
export const LIBRARY_PURCHASE_STORES = Object.freeze(['steam', 'epic', 'gog', 'itch', 'booth', 'dlsite', 'dmm', 'fanza', 'other']);
export const LIBRARY_PREVIEW_MODES = Object.freeze(['off', 'hover', 'context']);
export const LIBRARY_ADULT_FILTERS = Object.freeze(['all', 'exclude', 'only', 'unclassified']);
const GAME_ID = /^[0-9a-f]{16}$/;
export const defaultGameLibrarySettings = () => ({ hideThumbnail: false, adult: 'unclassified', purchaseStores: [] });
export const defaultLibraryPreferences = () => ({
  sort: 'name-asc', favoritesOnly: false, duplicatesOnly: false, favorites: [],
  previewMode: 'hover', adultFilter: 'all', purchaseFilter: 'all', gameSettings: {},
});
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
function invalid() { throw new Error('Invalid library preferences.'); }

/** Match the main-process format, including legacy files with only the four
 * original fields. A bad read fails closed instead of silently resetting it. */
export function normaliseLibraryPreferences(value) {
  if (!record(value) || Object.keys(value).some(key => !['sort', 'favoritesOnly', 'duplicatesOnly', 'favorites', 'previewMode', 'adultFilter', 'purchaseFilter', 'gameSettings'].includes(key)) ||
      !['name-asc', 'name-desc', 'engine', 'translated', 'favorites', 'duplicates'].includes(value.sort) ||
      typeof value.favoritesOnly !== 'boolean' || typeof value.duplicatesOnly !== 'boolean' ||
      !Array.isArray(value.favorites) || value.favorites.length > 10000 ||
      value.favorites.some(id => typeof id !== 'string' || !GAME_ID.test(id)) || new Set(value.favorites).size !== value.favorites.length ||
      value.previewMode !== undefined && !LIBRARY_PREVIEW_MODES.includes(value.previewMode) ||
      value.adultFilter !== undefined && !LIBRARY_ADULT_FILTERS.includes(value.adultFilter) ||
      value.purchaseFilter !== undefined && !['all', 'unassigned', ...LIBRARY_PURCHASE_STORES].includes(value.purchaseFilter)) invalid();
  const inputSettings = value.gameSettings ?? {};
  if (!record(inputSettings) || Object.keys(inputSettings).length > 5000 || value.gameSettings === null) invalid();
  const gameSettings = {};
  for (const [id, item] of Object.entries(inputSettings)) {
    if (!GAME_ID.test(id) || !record(item) || Object.keys(item).some(key => !['hideThumbnail', 'adult', 'purchaseStores'].includes(key)) ||
        item.hideThumbnail !== undefined && typeof item.hideThumbnail !== 'boolean' ||
        item.adult !== undefined && !['unclassified', 'general', 'adult'].includes(item.adult) ||
        item.purchaseStores !== undefined && (!Array.isArray(item.purchaseStores) || item.purchaseStores.length > LIBRARY_PURCHASE_STORES.length ||
          item.purchaseStores.some(store => !LIBRARY_PURCHASE_STORES.includes(store)) || new Set(item.purchaseStores).size !== item.purchaseStores.length)) invalid();
    gameSettings[id] = { hideThumbnail: item.hideThumbnail === true, adult: item.adult ?? 'unclassified', purchaseStores: [...(item.purchaseStores ?? [])] };
  }
  return { sort: value.sort, favoritesOnly: value.favoritesOnly, duplicatesOnly: value.duplicatesOnly, favorites: [...value.favorites],
    previewMode: value.previewMode ?? 'hover', adultFilter: value.adultFilter ?? 'all', purchaseFilter: value.purchaseFilter ?? 'all', gameSettings };
}

/** Callers may render before preferences finish loading. Return a fresh bounded
 * presentation record without adopting unrelated fields from the game profile. */
export function gameLibrarySettings(preferences, id) {
  const value = typeof id === 'string' && GAME_ID.test(id) && preferences?.gameSettings?.[id];
  return { hideThumbnail: value?.hideThumbnail === true,
    adult: ['general', 'adult'].includes(value?.adult) ? value.adult : 'unclassified',
    purchaseStores: Array.isArray(value?.purchaseStores) ? [...new Set(value.purchaseStores.filter(store => LIBRARY_PURCHASE_STORES.includes(store)))] : [] };
}

/** Filtering reads only saved labels. A linked storefront, a suggestive game
 * name or an executable path is not evidence of a purchase or age rating. */
export function filterLibraryGames(games, preferences) {
  const adultFilter = preferences?.adultFilter ?? 'all', purchaseFilter = preferences?.purchaseFilter ?? 'all';
  return games.filter(game => {
    const settings = gameLibrarySettings(preferences, game.id);
    if (adultFilter === 'exclude' && settings.adult === 'adult' ||
        adultFilter === 'only' && settings.adult !== 'adult' ||
        adultFilter === 'unclassified' && settings.adult !== 'unclassified') return false;
    if (purchaseFilter === 'unassigned' && settings.purchaseStores.length ||
        purchaseFilter !== 'all' && purchaseFilter !== 'unassigned' && !settings.purchaseStores.includes(purchaseFilter)) return false;
    return true;
  });
}

/** Presentation-only grouping. Similar names are clues, not identity evidence. */
function nameKey(game) {
  return String(game.name ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
export function duplicateNameCounts(games) {
  const groups = new Map(), result = new Map();
  for (const game of games) {
    const name = nameKey(game);
    if (!name) continue;
    const group = groups.get(name) ?? [];
    group.push(game.id); groups.set(name, group);
  }
  for (const ids of groups.values()) if (ids.length > 1) for (const id of ids) result.set(id, ids.length);
  return result;
}

export function sortedLibraryGames(games, preferences, duplicates = duplicateNameCounts(games)) {
  const favorites = new Set(preferences.favorites);
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const nameOrder = (a, b) => collator.compare(String(a.name ?? ''), String(b.name ?? '')) ||
    collator.compare(String(a.path ?? ''), String(b.path ?? '')) || String(a.id).localeCompare(String(b.id));
  return [...games].sort((a, b) => {
    switch (preferences.sort) {
      case 'name-desc': return -nameOrder(a, b);
      case 'engine': return collator.compare(String(a.engineName ?? ''), String(b.engineName ?? '')) || nameOrder(a, b);
      case 'translated': return Number((b.installedTranslators?.length ?? 0) > 0) - Number((a.installedTranslators?.length ?? 0) > 0) || nameOrder(a, b);
      case 'favorites': return Number(favorites.has(b.id)) - Number(favorites.has(a.id)) || nameOrder(a, b);
      case 'duplicates': return Number(duplicates.has(b.id)) - Number(duplicates.has(a.id)) ||
        collator.compare(nameKey(a), nameKey(b)) || nameOrder(a, b);
      default: return nameOrder(a, b);
    }
  });
}

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

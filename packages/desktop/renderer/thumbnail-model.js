/** Only main-validated image data may reach an <img>; never accept remote URLs. */
export function normaliseThumbnail(value) {
  if (!value || !['local', 'steam'].includes(value.source) || typeof value.dataUrl !== 'string' ||
      value.dataUrl.length > 12 * 1024 * 1024 ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl)) return null;
  return { source: value.source, dataUrl: value.dataUrl,
    ...(typeof value.steamAppId === 'string' && /^\d{1,10}$/.test(value.steamAppId) ? { steamAppId: value.steamAppId } : {}) };
}

/** Bounded parallel lookups and LRU, including negative results. A manual choice
 * advances the generation so an older asynchronous lookup cannot replace it. */
export function createThumbnailLoader(fetchOne, { concurrency = 3, limit = 24 } = {}) {
  const cache = new Map(), pending = new Map(), generation = new Map(), queue = [];
  let active = 0;
  const remember = (id, value) => {
    cache.delete(id); cache.set(id, value);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  };
  const pump = () => {
    while (active < concurrency && queue.length) {
      const task = queue.shift(); active += 1;
      Promise.resolve().then(() => fetchOne(task.id)).then(normaliseThumbnail, () => null).then((value) => {
        const current = generation.get(task.id) === task.generation;
        if (current) remember(task.id, value);
        task.resolve({ current, value });
      }).finally(() => { active -= 1; if (pending.get(task.id) === task.promise) pending.delete(task.id); pump(); });
    }
  };
  const load = (id, refresh = false) => {
    if (!refresh && cache.has(id)) {
      const value = cache.get(id); remember(id, value);
      return Promise.resolve({ current: true, value });
    }
    if (!refresh && pending.has(id)) return pending.get(id);
    const version = (generation.get(id) ?? 0) + 1; generation.set(id, version);
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    pending.set(id, promise); queue.push({ id, generation: version, resolve, promise }); pump();
    return promise;
  };
  const prime = (id, value) => {
    generation.set(id, (generation.get(id) ?? 0) + 1);
    pending.delete(id);
    const safe = normaliseThumbnail(value); remember(id, safe); return safe;
  };
  return { load, prime };
}

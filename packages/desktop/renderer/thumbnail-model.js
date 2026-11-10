/** Only main-validated image data may reach an <img>; never accept remote URLs. */
export function normaliseThumbnail(value) {
  if (!value || !['local', 'manual', 'steam', 'gog'].includes(value.source) || typeof value.dataUrl !== 'string' ||
      value.dataUrl.length > 12 * 1024 * 1024 ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl)) return null;
  return { source: value.source, dataUrl: value.dataUrl,
    ...(typeof value.steamAppId === 'string' && /^\d{1,10}$/.test(value.steamAppId) ? { steamAppId: value.steamAppId } : {}),
    ...(typeof value.gogProductId === 'string' && /^[1-9]\d{0,19}$/.test(value.gogProductId) ? { gogProductId: value.gogProductId } : {}) };
}

/** Bounded parallel lookups and LRU, including negative results. A manual choice
 * advances the generation so an older asynchronous lookup cannot replace it. */
export function createThumbnailLoader(fetchOne, { concurrency = 3, limit = 24, canStart = () => true } = {}) {
  const cache = new Map(), pending = new Map(), generation = new Map(), queue = [];
  let active = 0;
  const remember = (id, value) => {
    cache.delete(id); cache.set(id, value);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  };
  const pump = () => {
    while (active < concurrency && queue.length && canStart()) {
      const task = queue.shift(); active += 1;
      void (async () => {
        await Promise.resolve();
        // Visibility may change after queue admission but before the IPC call.
        if (!canStart()) { active -= 1; queue.unshift(task); return; }
        if (generation.get(task.id) !== task.generation) {
          task.resolve({ current: false, value: null }); active -= 1;
          if (pending.get(task.id) === task.promise) pending.delete(task.id);
          pump(); return;
        }
        let value;
        try { value = normaliseThumbnail(await fetchOne(task.id)); } catch { value = null; }
        const current = generation.get(task.id) === task.generation;
        if (current) remember(task.id, value);
        task.resolve({ current, value });
        active -= 1; if (pending.get(task.id) === task.promise) pending.delete(task.id); pump();
      })();
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
  return { load, prime, resume: pump };
}

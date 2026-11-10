import assert from 'node:assert/strict';
import test from 'node:test';

class Element {
  tagName: string; children: Element[] = []; parent: Element | null = null;
  id = ''; className = ''; textContent = ''; value = ''; type = ''; name = ''; checked = false;
  disabled = false; hidden = false; open = false; isConnected = false; tabIndex = 0;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; style: Record<string, string> = {};
  handlers = new Map<string, ((event: any) => void)[]>(); onclick?: (event: any) => void; onchange?: (event: any) => void;
  classList = { toggle: (name: string, value?: boolean) => {
    const all = new Set(this.className.split(/\s+/).filter(Boolean));
    const enabled = value ?? !all.has(name); if (enabled) all.add(name); else all.delete(name);
    this.className = [...all].join(' '); return enabled;
  }, contains: (name: string) => this.className.split(/\s+/).includes(name), add: (name: string) => this.classList.toggle(name, true), remove: (name: string) => this.classList.toggle(name, false) };
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  append(...children: Element[]) { for (const child of children) { child.parent = this; child.connect(this.isConnected); this.children.push(child); } }
  connect(value: boolean) { this.isConnected = value; for (const child of this.children) child.connect(value); }
  replaceChildren(...children: Element[]) { for (const child of this.children) child.connect(false); this.children = []; this.append(...children); }
  setAttribute(key: string, value: unknown) { this.attributes[key] = String(value); }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  removeAttribute(key: string) { delete this.attributes[key]; }
  addEventListener(name: string, handler: (event: any) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
  removeEventListener(name: string, handler: (event: any) => void) { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(value => value !== handler)); }
  event(name: string, event: any = {}) {
    event.target ??= this; event.preventDefault ??= () => {}; event.stopPropagation ??= () => { event.stopped = true; };
    for (const handler of this.handlers.get(name) ?? []) handler(event);
  }
  click(event: any = {}) {
    if (this.disabled) return;
    event.target ??= this; event.stopPropagation ??= () => { event.stopped = true; };
    this.event('click', event); this.onclick?.(event); if (!event.stopped) this.parent?.click(event);
  }
  querySelectorAll(selector: string): Element[] { return descendants(this).filter(node => matches(node, selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  matches(selector: string) { return matches(this, selector); }
  closest() { return null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.connect(false); }
  showModal() { this.open = true; }
  close() { this.open = false; this.event('close'); }
  focus() { (globalThis as any).document.activeElement = this; }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
}
function descendants(node: Element): Element[] { return node.children.flatMap(child => [child, ...descendants(child)]); }
function matches(node: Element, selector: string) {
  if (selector === '[data-thumbnail-game-id]') return Boolean(node.dataset.thumbnailGameId);
  if (selector === ':disabled') return node.disabled;
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  return node.tagName === selector.toUpperCase();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Library metadata UI did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); }
};

test('library labels and visibility controls keep hidden artwork inert and preserve independent presentation choices', async context => {
  const a = '1111111111111111', b = '2222222222222222', c = '3333333333333333';
  const body = new Element('body'); body.connect(true);
  for (const id of ['gameList', 'counts', 'librarySort', 'libraryFavoritesOnly', 'libraryDuplicatesOnly',
    'libraryPreferencesStatus', 'libraryPreviewMode', 'libraryAdultFilter', 'libraryPurchaseFilter']) {
    const node = new Element(); node.id = id; body.append(node);
  }
  const observed: Element[] = [], saves: any[] = []; let selections = 0, thumbnailRequests = 0;
  const read = deferred<any>();
  let saveResponse: (value: any) => Promise<any> = async value => value;
  const get = (id: string) => descendants(body).find(node => node.id === id)!;
  (globalThis as any).document = { body, hidden: false, activeElement: body, hasFocus: () => true,
    getElementById: get, createElement: (tag: string) => new Element(tag), addEventListener() {}, removeEventListener() {},
    querySelectorAll: (selector: string) => body.querySelectorAll(selector), querySelector: () => null };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1000, innerHeight: 800,
    setTimeout, clearTimeout, Event,
    indiedeck: { libraryPreferences: { read: () => read.promise,
      save: async (value: any) => { saves.push(structuredClone(value)); return saveResponse(value); } },
    game: { thumbnail: async () => { thumbnailRequests += 1; return null; } } } };
  (globalThis as any).IntersectionObserver = class { observe(node: Element) { observed.push(node); } unobserve() {} };
  const { state, subscribe, visibleGames } = await import('../../desktop/renderer/store.js');
  const { defaultLibraryPreferences } = await import('../../desktop/renderer/library-preferences.js');
  const { renderGameList, openGameLibraryOptions } = await import('../../desktop/renderer/panels/library.js');
  const store: any = state;
  const games = [a, b, c].map((id, index) => ({ id, name: ['Adult fixture', 'General fixture', 'Unclassified fixture'][index],
    engineName: 'Unity', engineId: 'unity', arch: 'unknown', installedTranslators: [] }));
  store.games = games; store.libraryPreferences = defaultLibraryPreferences(); store.libraryPreferencesLoaded = false; store.libraryPreferencesError = false;
  store.storeConnections = { snapshot: { schemaVersion: 1, revision: 1, links: [{ provider: 'steam', gameId: a }, { provider: 'steam', gameId: a }] } };
  const render = () => renderGameList(() => { selections += 1; });
  const unsubscribe = subscribe(scope => { if (scope === 'library' || scope === 'all') render(); });
  const rows = () => get('gameList').children.filter(node => node.className.split(/\s+/).includes('game'));
  const row = (id: string) => rows().find(node => node.dataset.gameId === id)!;
  const selectFilter = (id: string, value: string) => { const node = get(id); node.value = value; node.onchange?.({ target: node }); };
  try {
    await context.test('unloaded preferences create no image nodes or thumbnail observers', async () => {
      render(); await Promise.resolve();
      assert.equal(rows().length, 3); assert.equal(descendants(get('gameList')).filter(node => node.tagName === 'IMG').length, 0);
      assert.equal(observed.length, 0); assert.equal(thumbnailRequests, 0);
      assert.ok(rows().every(node => node.querySelector('.thumbnail-list-hidden')));
      read.resolve({ ...defaultLibraryPreferences(), favorites: [b], gameSettings: {
        [a]: { hideThumbnail: true, adult: 'adult', purchaseStores: ['gog'] },
        [b]: { hideThumbnail: false, adult: 'general', purchaseStores: ['steam', 'dlsite'] },
      } });
      await waitFor(() => store.libraryPreferencesLoaded);
      assert.equal(store.libraryPreferencesError, false);
    });
    await context.test('hidden rows have no image authority while linked and manually purchased sites stay distinct', () => {
      assert.equal(row(a).querySelectorAll('img').length, 0); assert.equal(row(a).querySelectorAll('[data-thumbnail-game-id]').length, 0);
      assert.equal(observed.some(node => node.dataset.thumbnailGameId === a), false);
      assert.equal(row(a).querySelector('.library-adult-badge')?.textContent, 'Adult (manual label)');
      assert.equal(row(a).querySelector('.library-purchase-badge')?.textContent, 'Purchased at: GOG');
      assert.equal(row(a).querySelectorAll('.library-linked-store-badge').length, 1);
      assert.equal(row(a).querySelector('.library-linked-store-badge')?.textContent, 'Linked: Steam');
      assert.deepEqual(store.libraryPreferences.gameSettings[a].purchaseStores, ['gog']);
      assert.equal(row(b).querySelectorAll('img').length, 1);
    });
    await context.test('adult and purchase filters combine with favorites without inferring a purchase from links', () => {
      selectFilter('libraryPurchaseFilter', 'steam'); assert.deepEqual(visibleGames().map((game: any) => game.id), [b]);
      selectFilter('libraryPurchaseFilter', 'all');
      selectFilter('libraryAdultFilter', 'only'); assert.deepEqual(visibleGames().map((game: any) => game.id), [a]);
      selectFilter('libraryAdultFilter', 'exclude'); assert.deepEqual(visibleGames().map((game: any) => game.id), [b, c]);
      selectFilter('libraryAdultFilter', 'unclassified'); assert.deepEqual(visibleGames().map((game: any) => game.id), [c]);
      selectFilter('libraryAdultFilter', 'all');
      get('libraryFavoritesOnly').click(); assert.deepEqual(visibleGames().map((game: any) => game.id), [b]);
      get('libraryFavoritesOnly').click(); assert.equal(visibleGames().length, 3);
    });
    await context.test('dialog saves explicit labels for exactly one game and preserves favorites and other game data', async () => {
      row(a).querySelector('.library-options')!.click();
      assert.equal(selections, 0); const dialog = get('gameLibraryOptions'); assert.equal(dialog.dataset.gameId, a); assert.equal(dialog.open, true);
      get('gameHideListThumbnail').checked = false; get('gameAdultClassification').value = 'general';
      const checks = descendants(dialog).filter(node => node.name === 'gamePurchaseStore');
      for (const check of checks) check.checked = ['steam', 'other'].includes(check.value);
      get('saveGameLibraryOptions').click(); await waitFor(() => !get('gameLibraryOptions'));
      assert.deepEqual(store.libraryPreferences.gameSettings[a], { hideThumbnail: false, adult: 'general', purchaseStores: ['steam', 'other'] });
      assert.deepEqual(store.libraryPreferences.favorites, [b]);
      assert.deepEqual(store.libraryPreferences.gameSettings[b].purchaseStores, ['steam', 'dlsite']);
      assert.equal(row(a).querySelectorAll('img').length, 1);
      await waitFor(() => saves.some(value => value.gameSettings[a].purchaseStores.includes('other')));
    });
    await context.test('cancelling or using a stale game control cannot save metadata', () => {
      openGameLibraryOptions(games[0]); get('gameHideListThumbnail').checked = true; get('cancelGameLibraryOptions').click();
      assert.equal(store.libraryPreferences.gameSettings[a].hideThumbnail, false);
      const old = row(a).querySelector('.library-options')!; store.games = games.slice(1); old.click();
      assert.equal(get('gameLibraryOptions'), undefined); store.games = games; render();
    });
    await context.test('a delayed older save response cannot replace newer local filter choices', async () => {
      await waitFor(() => saves.length >= 9);
      const pending = deferred<any>(); let first = true;
      saveResponse = async value => { if (first) { first = false; return pending.promise; } return value; };
      const before = saves.length; selectFilter('libraryPurchaseFilter', 'gog'); await waitFor(() => saves.length === before + 1);
      selectFilter('libraryAdultFilter', 'only'); assert.equal(store.libraryPreferences.adultFilter, 'only');
      pending.resolve(defaultLibraryPreferences()); await waitFor(() => saves.length === before + 2);
      assert.equal(store.libraryPreferences.adultFilter, 'only'); assert.equal(store.libraryPreferences.purchaseFilter, 'gog');
      saveResponse = async value => value; selectFilter('libraryPurchaseFilter', 'all'); selectFilter('libraryAdultFilter', 'all');
    });
    await context.test('a failed save keeps the dialog draft and suppresses all list image creation', async () => {
      saveResponse = async () => { throw new Error('private failure'); };
      openGameLibraryOptions(games[0]); get('gameHideListThumbnail').checked = true;
      get('saveGameLibraryOptions').click(); await waitFor(() => store.libraryPreferencesError);
      assert.equal(get('gameLibraryOptions').open, true); assert.equal(get('gameHideListThumbnail').checked, true);
      assert.ok(get('gameLibraryOptions').querySelector('.library-options-status')?.textContent.includes('Existing data was kept'));
      assert.equal(descendants(get('gameList')).filter(node => node.tagName === 'IMG').length, 0);
      assert.equal(thumbnailRequests, 0); get('cancelGameLibraryOptions').click();
    });
  } finally { unsubscribe(); delete (globalThis as any).document; delete (globalThis as any).window; delete (globalThis as any).IntersectionObserver; }
});

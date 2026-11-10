// Isolated renderer interaction fixture, run only by the CI test harness.
// This deliberately uses synthetic game metadata and a disposable dataDir.
import assert from 'node:assert/strict';
import { readLibraryPreferences, saveLibraryPreferences, defaultLibraryPreferences } from '../packages/desktop/src/library-preferences.ts';

const [dataDir, phase] = process.argv.slice(2);
assert.ok(dataDir && ['write', 'reload'].includes(phase));
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.parent = null; this.className = ''; this.textContent = '';
    this.dataset = {}; this.attributes = {}; this.handlers = {}; this.disabled = false; this.isConnected = false;
    this.classList = { toggle: () => {} };
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
  click(event = { stopped: false, stopPropagation() { this.stopped = true; } }) {
    if (this.disabled) return;
    for (const handler of this.handlers.click ?? []) handler(event);
    if (this.onclick) this.onclick(event);
    if (!event.stopped && this.parent) this.parent.click(event);
  }
  querySelectorAll() { return []; }
}
const ids = ['gameList', 'counts', 'librarySort', 'libraryFavoritesOnly', 'libraryDuplicatesOnly', 'libraryPreferencesStatus',
  'libraryPreviewMode', 'libraryAdultFilter', 'libraryPurchaseFilter'];
const nodes = new Map(ids.map((id) => [id, new Element()]));
globalThis.document = { getElementById: (id) => nodes.get(id), createElement: (tag) => new Element(tag), querySelectorAll: () => [] };
const pending = [];
globalThis.window = { indiedeck: {
  libraryPreferences: {
    read: () => readLibraryPreferences(dataDir),
    save: (value) => { const promise = saveLibraryPreferences(value, dataDir); pending.push(promise); return promise; },
  },
  game: { thumbnail: () => null },
}, dispatchEvent: () => {} };

const { state, subscribe } = await import('../packages/desktop/renderer/store.js');
const { renderGameList } = await import('../packages/desktop/renderer/panels/library.js');
const idA = '0123456789abcdef', idB = 'fedcba9876543210', idC = 'aaaaaaaaaaaaaaaa';
state.games = [
  { id: idA, name: 'Demo', path: 'C:/fixture/A/Demo', engineId: 'unity', engineName: 'Unity', arch: 'unknown', installedTranslators: [] },
  { id: idB, name: ' demo ', path: 'C:/fixture/B/Demo', engineId: 'rpg', engineName: 'RPG Maker', arch: 'unknown', installedTranslators: [] },
  { id: idC, name: 'Other', path: 'C:/fixture/C/Other', engineId: 'unity', engineName: 'Unity', arch: 'unknown', installedTranslators: [] },
];
let selections = 0;
const render = () => renderGameList(() => { selections += 1; });
subscribe((scope) => { if (scope === 'library' || scope === 'all') render(); });
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); }
};
const findClass = (node, className) => {
  if (node.className.split(/\s+/).includes(className)) return node;
  for (const child of node.children) { const match = findClass(child, className); if (match) return match; }
  return undefined;
};
const rows = () => nodes.get('gameList').children.filter((node) => node.className === 'game');
const rowName = (row) => findClass(row, 'name')?.textContent.trim();
const expectedPreferences = { ...defaultLibraryPreferences(), sort: 'duplicates', favoritesOnly: false, duplicatesOnly: true,
  favorites: [idC], previewMode: 'context', adultFilter: 'exclude', purchaseFilter: 'unassigned' };
render();
await waitFor(() => state.libraryPreferencesLoaded);
assert.equal(state.libraryPreferencesError, false);

if (phase === 'write') {
  assert.equal(rows().length, 3);
  const other = rows().find((row) => rowName(row) === 'Other');
  findClass(other, 'favorite-toggle').click();
  assert.equal(selections, 0, 'the favorite button must not select or launch the game');
  assert.deepEqual(state.libraryPreferences.favorites, [idC]);
  const sort = nodes.get('librarySort'); sort.value = 'favorites'; sort.onchange();
  assert.equal(rowName(rows()[0]), 'Other');
  nodes.get('libraryFavoritesOnly').click();
  assert.equal(rows().length, 1); assert.equal(rowName(rows()[0]), 'Other');
  nodes.get('libraryFavoritesOnly').click();
  sort.value = 'duplicates'; sort.onchange();
  nodes.get('libraryDuplicatesOnly').click();
  assert.equal(rows().length, 2);
  assert.ok(rows().every((row) => findClass(row, 'pill')?.textContent.includes('2')));
  assert.ok(rows().every((row) => findClass(row, 'duplicate-path')?.textContent.startsWith('C:/fixture/')));
  for (const [id, value] of [['libraryPreviewMode', 'context'], ['libraryAdultFilter', 'exclude'], ['libraryPurchaseFilter', 'unassigned']]) {
    const control = nodes.get(id); control.value = value; control.onchange();
  }
  assert.equal(rows().length, 2, 'unclassified games stay visible when excluding only explicit adult labels');
  await waitFor(() => pending.length === 9);
  await Promise.all(pending);
  assert.deepEqual(await readLibraryPreferences(dataDir), expectedPreferences);
} else {
  assert.deepEqual(state.libraryPreferences, expectedPreferences);
  assert.equal(nodes.get('libraryPreviewMode').value, 'context');
  assert.equal(nodes.get('libraryAdultFilter').value, 'exclude');
  assert.equal(nodes.get('libraryPurchaseFilter').value, 'unassigned');
  assert.equal(rows().length, 2, 'the same-name filter survives a fresh renderer process');
  nodes.get('libraryDuplicatesOnly').click();
  assert.equal(rows().length, 3);
  const other = rows().find((row) => rowName(row) === 'Other');
  assert.equal(findClass(other, 'favorite-toggle').getAttribute('aria-pressed'), 'true');
  await waitFor(() => pending.length === 1); await Promise.all(pending);
}
console.log(`[library-renderer] ${phase} passed using an isolated fake bridge`);

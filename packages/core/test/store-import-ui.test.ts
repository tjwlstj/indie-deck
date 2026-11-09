import assert from 'node:assert/strict';
import test from 'node:test';

class Element {
  tagName: string; children: Element[] = []; id = ''; value = ''; className = ''; textContent = '';
  disabled = false; dataset: Record<string, string> = {}; style: Record<string, string> = {};
  handlers = new Map<string, ((event: any) => void)[]>();
  constructor(tag = 'div') { this.tagName = tag; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {} removeAttribute() {}
  addEventListener(type: string, callback: (event: any) => void) { this.handlers.set(type, [...(this.handlers.get(type) || []), callback]); }
  event(type: string, event: any = {}) { for (const handler of this.handlers.get(type) || []) handler(event); }
}
function find(root: Element, predicate: (node: Element) => boolean): Element | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const result = find(child, predicate); if (result) return result; }
}
const waitFor = async (predicate: () => boolean) => {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Synthetic store UI did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); }
};

test('store review supports direct-game presets, edited labels, paste and one-file drop without saving automatically', async () => {
  const gameId = '1234567890abcdef', body = new Element(), status = new Element(), events: any[] = [], saves: unknown[][] = [], imports: unknown[] = [];
  body.id = 'storeSettingsBody'; status.id = 'status';
  let revision = 1, previews = 0;
  const payload = () => ({ snapshot: { schemaVersion: 1, revision, links: [] }, products: [],
    providers: [{ id: 'steam', name: 'Steam', actions: [] }], games: [{ id: gameId, title: 'Demo', path: 'C:/fixture/Demo' }] });
  const candidate = { id: 'issued', provider: 'steam', productId: '440', url: 'https://store.steampowered.com/app/440/', title: 'Page title' };
  (globalThis as any).document = { getElementById: (id: string) => id === 'status' ? status : find(body, node => node.id === id),
    createElement: (tag: string) => new Element(tag), querySelectorAll: () => [] };
  (globalThis as any).CustomEvent = class { type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options.detail; } };
  (globalThis as any).window = { dispatchEvent: (event: unknown) => { events.push(event); }, indiedeck: { stores: {
    list: async () => payload(),
    preview: async () => { previews += 1; return { ...payload(), candidate }; },
    importFile: async (file: unknown) => { imports.push(file); return { ...payload(), candidate }; },
    save: async (...args: unknown[]) => { saves.push(args); revision += 1; return payload(); },
  } } };
  const { state, subscribe } = await import('../../desktop/renderer/store.js');
  const { refreshStoreConnections, renderStoreSettings, renderGameStoreLinks } = await import('../../desktop/renderer/panels/stores.js');
  const store: any = state;
  const unsubscribe = subscribe(() => renderStoreSettings());
  try {
    await refreshStoreConnections();
    const detail = new Element(); renderGameStoreLinks(detail, { id: gameId });
    const connect = find(detail, node => node.className.includes('store-connect-game'))!;
    assert.ok(connect, 'an unlinked game still exposes the connection shortcut');
    connect.event('click');
    assert.equal(events[0]?.detail?.section, 'storeSettings');
    renderStoreSettings();
    const text = find(body, node => node.id === 'storeLinkInput')!;
    text.value = 'https://store.steampowered.com/app/440/'; text.event('input');
    find(body, node => node.className.includes('store-preview'))!.event('click');
    await waitFor(() => Boolean(store.storeCandidate) && !store.storeBusy);
    assert.equal(previews, 1); assert.equal(saves.length, 0);
    assert.equal(find(body, node => node.id === 'storeLinkProduct')?.value, `game:${gameId}`);
    const title = find(body, node => node.id === 'storeLinkTitle')!;
    title.value = 'My reviewed name'; title.event('input');
    find(body, node => node.className.includes('store-save'))!.event('click');
    await waitFor(() => saves.length === 1 && !store.storeBusy);
    assert.deepEqual(saves[0], ['issued', undefined, gameId, 'My reviewed name']);
    const file = { name: 'game.indiedeck-link.json', size: 200 };
    const drop = () => find(body, node => node.className === 'store-import')!;
    const event = (files: unknown[]) => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files } });
    drop().event('drop', event([file, file]));
    assert.equal(imports.length, 0);
    drop().event('drop', event([file]));
    await waitFor(() => imports.length === 1 && !store.storeBusy);
    assert.equal(imports[0], file); assert.equal(saves.length, 1, 'drop must stop at review');
  } finally { unsubscribe(); delete (globalThis as any).window; delete (globalThis as any).document; }
});

import assert from 'node:assert/strict';
import test from 'node:test';

class Element {
  tagName: string; children: Element[] = []; id = ''; value = ''; className = ''; textContent = '';
  disabled = false; hidden = false; src = ''; alt = ''; dataset: Record<string, string> = {};
  style: Record<string, string> = {}; handlers = new Map<string, ((event: any) => void)[]>();
  constructor(tag = 'div') { this.tagName = tag; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {} removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  addEventListener(type: string, callback: (event: any) => void) { this.handlers.set(type, [...(this.handlers.get(type) || []), callback]); }
  event(type: string, event: any = {}) { for (const handler of this.handlers.get(type) || []) handler(event); }
  querySelector(selector: string) { return find(this, node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector); }
}
function find(root: Element, predicate: (node: Element) => boolean): Element | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const result = find(child, predicate); if (result) return result; }
}
function all(root: Element, predicate: (node: Element) => boolean): Element[] {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
}
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Synthetic artwork UI did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); }
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('imported artwork requires reviewed local image bytes and an explicit installed-game application', async (context) => {
  const firstGame = '1111111111111111', secondGame = '2222222222222222';
  const body = new Element(), status = new Element(); body.id = 'storeSettingsBody'; status.id = 'status';
  const thumbnail = { source: 'manual', dataUrl: 'data:image/png;base64,AQID' };
  const nextThumbnail = { source: 'manual', dataUrl: 'data:image/webp;base64,BAUG' };
  const candidate = { id: 'candidate-one', provider: 'itch', productId: 'demo/game', url: 'https://demo.itch.io/game',
    title: 'Demo', artwork: { url: 'https://img.itch.zone/aW1n/example/original.png' } };
  const payload = () => ({ snapshot: { schemaVersion: 1, revision: 1, links: [] }, providers: [],
    products: [{ id: 'managed-one', title: 'Managed demo' }],
    games: [{ id: firstGame, title: 'Demo', path: 'C:/fixture/Demo' }, { id: secondGame, title: 'Other demo', path: 'C:/fixture/Other' }] });
  const boxes = [firstGame, secondGame].map(id => {
    const box = new Element(); box.dataset.thumbnailGameId = id;
    const image = new Element('img'); image.src = `old:${id}`;
    const placeholder = new Element('span'); placeholder.className = 'thumbnail-placeholder';
    box.append(image, placeholder); return box;
  });
  const previews: unknown[][] = [], applications: unknown[][] = [], saves: unknown[][] = [];
  let previewResponse: () => Promise<any> = async () => ({ candidateId: candidate.id, previewId: 'preview-one', thumbnail });
  let applyResponse: (...args: any[]) => Promise<any> = async (_candidateId, _previewId, gameId) => ({ gameId, thumbnail });
  (globalThis as any).document = { getElementById: (id: string) => id === 'status' ? status : find(body, node => node.id === id),
    createElement: (tag: string) => new Element(tag), querySelectorAll: (selector: string) => selector === '[data-thumbnail-game-id]' ? boxes : [] };
  (globalThis as any).window = { indiedeck: { stores: {
    previewArtwork: async (...args: unknown[]) => { previews.push(args); return previewResponse(); },
    applyArtwork: async (...args: any[]) => { applications.push(args); return applyResponse(...args); },
    save: async (...args: unknown[]) => { saves.push(args); return payload(); },
  } } };
  const { state, subscribe } = await import('../../desktop/renderer/store.js');
  const { renderStoreSettings } = await import('../../desktop/renderer/panels/stores.js');
  const store: any = state;
  const unsubscribe = subscribe(() => renderStoreSettings());
  const button = (className: string) => find(body, node => node.className.split(' ').includes(className))!;
  const reset = (target = `game:${firstGame}`) => {
    store.storeConnections = payload(); store.storeConnectionsLoaded = true; store.storeReadError = null; store.storeReadPending = false;
    store.storeCandidate = candidate; store.storeCandidateTitle = candidate.title; store.storeProductId = target;
    store.storeArtworkPreview = null; store.storeArtworkAction = null; store.storeArtworkRequestToken += 1; store.storeBusy = false;
    previews.length = 0; applications.length = 0; saves.length = 0; status.textContent = '';
    previewResponse = async () => ({ candidateId: candidate.id, previewId: 'preview-one', thumbnail });
    applyResponse = async (_candidateId, _previewId, gameId) => ({ gameId, thumbnail });
    boxes.forEach(box => { box.querySelector('img')!.src = `old:${box.dataset.thumbnailGameId}`; });
    renderStoreSettings();
  };
  const preview = async () => { button('store-artwork-preview').event('click'); await waitFor(() => !store.storeBusy); };
  try {
    await context.test('rendering keeps the source as text and performs no artwork request', () => {
      reset(); renderStoreSettings();
      assert.equal(button('store-artwork-source').textContent, candidate.artwork.url);
      assert.equal(all(body, node => node.tagName === 'img' || node.tagName === 'a').length, 0);
      assert.equal(previews.length, 0); assert.equal(applications.length, 0);
      assert.equal(button('store-artwork-apply').disabled, true);
    });
    await context.test('preview is explicit, application targets exactly the selected game, and connection save remains separate', async () => {
      reset(); await preview();
      assert.deepEqual(previews, [[candidate.id]]); assert.equal(applications.length, 0); assert.equal(saves.length, 0);
      assert.equal(button('store-artwork-image').src, thumbnail.dataUrl); assert.equal(button('store-artwork-apply').disabled, false);
      button('store-artwork-apply').event('click'); await waitFor(() => !store.storeBusy);
      assert.deepEqual(applications, [[candidate.id, 'preview-one', firstGame]]);
      assert.equal(boxes[0].querySelector('img')!.src, thumbnail.dataUrl);
      assert.equal(store.storeCandidate.id, candidate.id); assert.equal(saves.length, 0);
      button('store-save').event('click'); await waitFor(() => !store.storeBusy);
      assert.equal(saves.length, 1); assert.equal(store.storeArtworkPreview, null); assert.equal(store.storeCandidate, null);
    });
    await context.test('unlinked, managed, and absent games cannot receive artwork even through a stale button', async () => {
      reset(); await preview(); const oldApply = button('store-artwork-apply');
      for (const target of ['', 'managed-one', 'game:missing']) {
        store.storeProductId = target; renderStoreSettings();
        assert.equal(button('store-artwork-apply').disabled, true);
        oldApply.event('click'); await Promise.resolve();
      }
      assert.equal(applications.length, 0);
      assert.ok(store.storeArtworkPreview, 'candidate-bound preview remains available when choosing a game later');
    });
    await context.test('a target chosen while the preview is pending can use the candidate-bound preview', async () => {
      reset(''); const pending = deferred<any>(); previewResponse = () => pending.promise;
      button('store-artwork-preview').event('click');
      store.storeProductId = `game:${secondGame}`; renderStoreSettings();
      pending.resolve({ candidateId: candidate.id, previewId: 'preview-one', thumbnail });
      await waitFor(() => !store.storeBusy);
      assert.equal(button('store-artwork-apply').disabled, false);
      button('store-artwork-apply').event('click'); await waitFor(() => !store.storeBusy);
      assert.deepEqual(applications, [[candidate.id, 'preview-one', secondGame]]);
    });
    await context.test('late preview results are ignored after candidate replacement or cancellation', async () => {
      reset(); let pending = deferred<any>(); previewResponse = () => pending.promise;
      button('store-artwork-preview').event('click');
      store.storeCandidate = { ...candidate, id: 'candidate-new' }; renderStoreSettings();
      pending.resolve({ candidateId: candidate.id, previewId: 'preview-one', thumbnail });
      await waitFor(() => !store.storeBusy);
      assert.equal(store.storeArtworkPreview, null); assert.equal(all(body, node => node.tagName === 'img').length, 0);
      reset(); pending = deferred<any>(); previewResponse = () => pending.promise;
      button('store-artwork-preview').event('click'); button('store-cancel').event('click');
      pending.resolve({ candidateId: candidate.id, previewId: 'preview-one', thumbnail });
      await waitFor(() => !store.storeBusy);
      assert.equal(store.storeCandidate, null); assert.equal(store.storeArtworkPreview, null);
    });
    await context.test('late application primes its captured game rather than a newly selected target', async () => {
      reset(); await preview(); const pending = deferred<any>(); applyResponse = () => pending.promise;
      button('store-artwork-apply').event('click');
      store.storeProductId = `game:${secondGame}`; renderStoreSettings(); status.textContent = 'current-selection-status';
      pending.resolve({ gameId: firstGame, thumbnail: nextThumbnail }); await waitFor(() => !store.storeBusy);
      assert.equal(boxes[0].querySelector('img')!.src, nextThumbnail.dataUrl);
      assert.equal(boxes[1].querySelector('img')!.src, `old:${secondGame}`);
      assert.equal(status.textContent, 'current-selection-status');
      assert.equal(store.storeProductId, `game:${secondGame}`);
    });
    await context.test('invalid and remote preview responses never create image elements, and raw errors are hidden', async () => {
      for (const response of [
        { candidateId: candidate.id, previewId: 'preview-one', thumbnail: { source: 'manual', dataUrl: candidate.artwork.url } },
        { candidateId: 'other-candidate', previewId: 'preview-one', thumbnail },
        { candidateId: candidate.id, previewId: 'preview-one', thumbnail: { ...thumbnail, source: 'steam' } },
      ]) {
        reset(); previewResponse = async () => response; await preview();
        assert.equal(store.storeArtworkPreview, null); assert.equal(all(body, node => node.tagName === 'img').length, 0);
        assert.equal(button('store-artwork-apply').disabled, true);
      }
      reset(); previewResponse = async () => { throw new Error('secret token and https://private.invalid'); }; await preview();
      assert.doesNotMatch(status.textContent, /secret|private\.invalid/); assert.match(status.textContent, /Could not process/);
    });
    await context.test('an application response for another game cannot prime any thumbnail', async () => {
      reset(); await preview(); applyResponse = async () => ({ gameId: secondGame, thumbnail });
      button('store-artwork-apply').event('click'); await waitFor(() => !store.storeBusy);
      assert.equal(boxes[0].querySelector('img')!.src, `old:${firstGame}`);
      assert.equal(boxes[1].querySelector('img')!.src, `old:${secondGame}`);
    });
  } finally { unsubscribe(); delete (globalThis as any).window; delete (globalThis as any).document; }
});

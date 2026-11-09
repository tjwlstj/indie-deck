import assert from 'node:assert/strict';
import { test } from 'node:test';

// Disposable DOM and injected bridge only. No picker, image, browser or game
// on the host is opened by this interaction fixture.
class Element {
  tagName: string; className = ''; textContent = ''; value = ''; disabled = false; isConnected = true;
  children: Element[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  handlers: Record<string, ((event: any) => void)[]> = {};
  classList = { toggle: () => {}, remove: () => {} };
  constructor(tag: string) { this.tagName = tag; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute(key: string, value: string) { this.attributes[key] = String(value); }
  addEventListener(type: string, fn: (event: any) => void) { (this.handlers[type] ??= []).push(fn); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((node) => [
      ...(selector === 'button, select' && ['button', 'select'].includes(node.tagName) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  contains(node: Element) { return node === this || this.children.some((child) => child.contains(node)); }
  fire(type: string, event: any = {}) { if (type === 'click' && this.disabled) return; for (const fn of this.handlers[type] ?? []) fn(event); }
}
const sections: Element[] = [];
Object.assign(globalThis, {
  document: { createElement: (tag: string) => new Element(tag), querySelectorAll: () => sections.flatMap((section) => section.children) },
  window: { indiedeck: { game: {} } },
});
const { appendThumbnailControls, usableThumbnailDrop } = await import('../../desktop/renderer/thumbnail-controls.js');
const manual = { source: 'manual', dataUrl: 'data:image/png;base64,AAAA' };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve: (value: any) => void = () => {}; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(id: string, gameApi: any, overrides: any = {}) {
  const section = new Element('section'), cover = new Element('div'), accepted: unknown[] = [], reset: unknown[] = [];
  const view = appendThumbnailControls(section, { id }, cover, { gameApi, blocked: () => false,
    accept: (...args: unknown[]) => { accepted.push(args); return args[1]; },
    reset: (...args: unknown[]) => { reset.push(args); return args[1]; }, retry: async () => {}, ...overrides });
  sections.push(section);
  return { ...view, section, accepted, reset };
}
const drop = (files: unknown[]) => ({ dataTransfer: { files }, preventDefault() {}, stopPropagation() {} });

test('manual picker dropdown preserves cancel and sends the folder preference explicitly', async () => {
  const calls: unknown[] = []; let result: unknown = null;
  const view = fixture('picker-game', { pickThumbnail: async (...args: unknown[]) => { calls.push(args); return result; } });
  view.apply.fire('click'); await flush();
  assert.deepEqual(calls, [['picker-game', false]]);
  assert.deepEqual(view.accepted, [], 'cancel must preserve existing artwork');
  result = manual; view.action.value = 'folder'; view.apply.fire('click'); await flush();
  assert.deepEqual(calls[1], ['picker-game', true]);
  assert.deepEqual(view.accepted, [['picker-game', manual]]);
  assert.equal(view.apply.disabled, false);
});

test('a drop forwards one File-like object without a path and rejects links, extra files and oversized images', async () => {
  const calls: unknown[] = [];
  const view = fixture('drop-game', { importThumbnail: async (...args: unknown[]) => { calls.push(args); return manual; } });
  const file = { name: 'my-cover.webp', type: 'image/webp', size: 100 };
  for (const files of [[], [file, file], [{ ...file, size: 2 * 1024 * 1024 + 1 }], [{ ...file, name: 'cover.svg' }]]) {
    view.section.fire('drop', drop(files)); await flush();
  }
  assert.deepEqual(calls, []);
  view.section.fire('drop', drop([file])); await flush();
  assert.deepEqual(calls, [['drop-game', file]]);
  assert.deepEqual(view.accepted, [['drop-game', manual]]);
  assert.equal(usableThumbnailDrop({ name: 'cover.png', size: 1, type: '' }), true);
});

test('one game action spans rebuilt details and a hidden response still refreshes its game artwork', async () => {
  const pending = deferred(); let calls = 0;
  const gameApi = { pickThumbnail: () => { calls += 1; return pending.promise; } };
  const first = fixture('rebuild-game', gameApi); first.apply.fire('click');
  first.section.isConnected = false;
  const next = fixture('rebuild-game', gameApi);
  assert.equal(next.apply.disabled, true);
  next.apply.fire('click'); assert.equal(calls, 1);
  pending.resolve(manual); await flush();
  assert.deepEqual(first.accepted, [['rebuild-game', manual]]);
  assert.equal(next.apply.disabled, false);
});

test('clear invalidates manual artwork then reloads the automatic cover, and busy/error paths keep installation data out of status', async () => {
  let cleared = 0, retried = 0;
  const view = fixture('clear-game', { clearThumbnail: async () => { cleared += 1; return null; } }, { retry: async () => { retried += 1; } });
  view.action.value = 'clear'; view.apply.fire('click'); await flush();
  assert.equal(cleared, 1); assert.equal(retried, 1); assert.deepEqual(view.reset, [['clear-game', null]]);
  const error = fixture('error-game', { pickThumbnail: async () => { throw new Error('secret C:/private/path.png'); } });
  error.apply.fire('click'); await flush();
  assert.equal(error.status.textContent, 'ui.thumbnail.failed');
  assert.ok(!error.status.textContent.includes('private'));
  let invoked = false;
  const busy = fixture('busy-game', { importThumbnail: async () => { invoked = true; } }, { blocked: () => true });
  busy.section.fire('drop', drop([{ name: 'cover.png', type: 'image/png', size: 10 }])); await flush();
  assert.equal(invoked, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Exercise the renderer with an in-memory DOM and a stub bridge; no browser,
// browser profile or filesystem path is opened by this test.
class Element {
  tagName: string;
  className = '';
  textContent = '';
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  open = false;
  disabled = false;
  constructor(tag: string) { this.tagName = tag; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  addEventListener(name: string, listener: () => void) { this.listeners[name] = listener; }
  setAttribute() {}
}
const body = new Element('div');
let openings = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  indiedeck: { stores: { openCompanion: async () => { openings += 1; } } },
} });
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  createElement: (tag: string) => new Element(tag),
  getElementById: (id: string) => id === 'storeSettingsBody' ? body : null,
} });
const { applyCatalog } = await import('../../desktop/renderer/i18n.js');
const { renderStoreSettings } = await import('../../desktop/renderer/panels/stores.js');
function all(root: Element): Element[] { return [root, ...root.children.flatMap(all)]; }

test('extension guidance selects the correct paths and explains temporary Firefox installation in both languages', () => {
  for (const locale of ['ko', 'en']) {
    applyCatalog({ locale, catalog: {} });
    renderStoreSettings();
    const nodes = all(body);
    const guide = nodes.find((node) => node.className === 'store-extension-guide');
    assert.ok(guide?.open);
    const instructions = all(guide).filter((node) => node.tagName === 'li').map((node) => node.textContent);
    assert.equal(instructions.length, 4);
    assert.match(instructions[0], /chrome:\/\/extensions.*chromium/);
    assert.match(instructions[1], /edge:\/\/extensions.*chromium/);
    assert.match(instructions[2], /whale:\/\/extensions.*chromium/);
    assert.match(instructions[3], /about:debugging.*firefox\/manifest\.json/);
    assert.match(instructions[3], locale === 'ko' ? /다시 시작하면 다시/ : /after restarting Firefox/);
  }
});

test('the folder button uses the existing explicit companion handoff', async () => {
  renderStoreSettings();
  const button = all(body).find((node) => node.className.includes('store-companion-open'));
  assert.ok(button && !button.disabled);
  button.listeners.click();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(openings, 1);
});

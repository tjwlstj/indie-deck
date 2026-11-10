import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class Element {
  tagName: string; children: Element[] = []; id = ''; className = ''; textContent = '';
  disabled = false; dataset: Record<string, string> = {}; style: Record<string, string> = {};
  handlers = new Map<string, () => void>();
  constructor(tag: string) { this.tagName = tag; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  removeAttribute() {}
  addEventListener(type: string, handler: () => void) { this.handlers.set(type, handler); }
  querySelectorAll(selector: string): Element[] {
    const name = selector.replace(/^\./, '');
    return this.children.flatMap(node => [
      ...(node.className.split(/\s+/).includes(name) ? [node] : []), ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  click() { if (!this.disabled) this.handlers.get('click')?.(); }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('late security completion releases existing MTool controls without rebuilding forms and keeps other gates', async () => {
  const detail = new Element('div'), status = new Element('div'), gameId = '0123456789abcdef';
  const input = new Element('input'); input.textContent = 'unsaved translation setting';
  let calls = 0;
  let release: (value: unknown) => void = () => {};
  const pending = new Promise(resolve => { release = resolve; });
  (globalThis as any).document = {
    createElement: (tag: string) => new Element(tag), getElementById: (id: string) => id === 'status' ? status : null,
    querySelectorAll: (selector: string) => selector === '#detail .mtool-integration' ? detail.querySelectorAll('.mtool-integration') : [],
    activeElement: input,
  };
  (globalThis as any).window = { indiedeck: { mtool: { launch: async () => { calls += 1; return pending; } } } };
  const { state, subscribe } = await import('../../desktop/renderer/store.js');
  const { renderMToolIntegration, syncMToolIntegrationControls } = await import('../../desktop/renderer/panels/mtool.js');
  const context: any = { profile: { id: gameId, engineId: 'rpgmaker-mv' }, mtoolIntegration: {
    supported: true, status: 'ready', gameExecutable: 'Game.exe', autoApply: false,
  } };
  const store = state as any;
  store.selected = gameId; store.detail = context;
  const render = () => { detail.replaceChildren(input); renderMToolIntegration(detail, context); };
  const unsubscribe = subscribe(render);
  try {
    render();
    detail.querySelector('.mtool-launch')!.click();
    assert.equal(store.mtoolBusy, true); assert.equal(calls, 1);
    // Reproduce the valid IPC interleaving: the renderer saw the scan start,
    // but its terminal status event has not arrived when the handoff replies.
    store.securityBusy = true; release({ opened: true }); await flush();
    assert.equal(store.mtoolBusy, false);
    const card = detail.querySelector('.mtool-integration')!, open = card.querySelector('.mtool-open')!;
    assert.equal(open.disabled, true);
    store.securityBusy = false; syncMToolIntegrationControls();
    assert.equal(open.disabled, false, 'late scan completion must release the existing button');
    assert.equal(detail.querySelector('.mtool-integration'), card);
    assert.equal((globalThis as any).document.activeElement, input);
    assert.equal(input.textContent, 'unsaved translation setting');
    for (const key of ['securityBusy', 'mtoolBusy', 'archiveBusy', 'storeBusy', 'scanRequestPending', 'mtoolStatusLoading']) {
      store[key] = true; syncMToolIntegrationControls();
      assert.equal(open.disabled, true, `${key} must keep the handoff blocked`);
      assert.equal(card.querySelector('.mtool-launch')!.disabled, true);
      assert.equal(card.querySelector('.mtool-refresh')!.disabled, true);
      store[key] = false;
    }
    context.mtoolIntegration.status = 'invalid'; syncMToolIntegrationControls();
    assert.equal(open.disabled, true, 'a scan finishing cannot make an invalid tool ready');
    assert.equal(card.querySelector('.mtool-refresh')!.disabled, false, 'refresh can recover invalid status');
    context.mtoolIntegration.status = 'ready'; store.selected = 'fedcba9876543210'; syncMToolIntegrationControls();
    assert.equal(open.disabled, true, 'stale cards cannot acquire another selected game authority');
    assert.equal(card.querySelector('.mtool-refresh')!.disabled, true);
    store.selected = gameId; context.mtoolIntegration.gameExecutable = undefined; syncMToolIntegrationControls();
    assert.equal(open.disabled, false);
    assert.equal(card.querySelector('.mtool-launch')!.disabled, true, 'a missing game executable still blocks game handoff');
  } finally {
    unsubscribe(); delete (globalThis as any).document; delete (globalThis as any).window;
  }
  const app = fs.readFileSync(new URL('../../desktop/renderer/app.js', import.meta.url), 'utf8');
  const chrome = app.slice(app.indexOf('function renderOperationChrome()'), app.indexOf('function scanLabel('));
  assert.match(chrome, /syncMToolIntegrationControls\(\)/);
  const security = app.slice(app.indexOf("window.addEventListener('indiedeck:security-state'"), app.indexOf('/* ------------------------------------------------------- selection/races */'));
  assert.match(security, /renderOperationChrome\(\)/, 'security snapshots must synchronize existing controls');
});

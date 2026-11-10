import assert from 'node:assert/strict';
import test from 'node:test';

class Element {
  children: Element[] = []; className = ''; textContent = ''; value = ''; type = ''; disabled = false; checked = false;
  readOnly = false; handlers = new Map<string, (() => void)[]>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) {
    if (this.contains((globalThis as any).document?.activeElement)) (globalThis as any).document.activeElement = (globalThis as any).document.body;
    this.children = nodes;
  }
  contains(node: Element | null) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [...(selector === '[data-gaming-focus]' && child.dataset.gamingFocus ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  focus() { if (!this.disabled) { (globalThis as any).document.activeElement = this; this.event('focus'); } }
  addEventListener(type: string, handler: () => void) { this.handlers.set(type, [...this.handlers.get(type) ?? [], handler]); }
  event(type: string) { for (const handler of this.handlers.get(type) ?? []) handler(); }
  select() {} setAttribute() {} removeAttribute() {}
}
function find(root: Element, predicate: (node: Element) => boolean): Element | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const result = find(child, predicate); if (result) return result; }
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > end) throw new Error('Gaming UI did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); }
}

test('gaming settings render main-owned state, preserve newer events and export only an opaque game id', async () => {
  const body = new Element(), status = new Element(), documentBody = new Element(), outside = new Element(), calls: unknown[][] = [];
  documentBody.append(body, status, outside);
  const gameId = '0123456789abcdef';
  let emitState: (value: unknown) => void = () => {};
  const base = { sequence: 1, fullscreen: false, minimizeOnLaunch: true, restoreOnExit: false, activeGameCount: 0, runningGameIds: [] };
  let current: () => Promise<unknown> = async () => base;
  (globalThis as any).document = { body: documentBody, documentElement: documentBody, activeElement: documentBody,
    createElement: () => new Element(), getElementById: (id: string) => id === 'gamingSettingsBody' ? body : id === 'status' ? status : null };
  (globalThis as any).window = { indiedeck: { gaming: {
    current: () => current(), onState: (fn: typeof emitState) => { emitState = fn; },
    configure: async (value: unknown) => { calls.push(['configure', value]); return { ...base, sequence: 2, minimizeOnLaunch: false }; },
    setFullscreen: async (value: boolean) => ({ ...base, sequence: 3, fullscreen: value }),
    registration: async (id?: string) => { calls.push(['registration', id]); return { executable: 'C:\\Program Files\\IndieDeck.exe', argumentLine: '--fullscreen' }; },
    exportShortcut: async (id?: string) => { calls.push(['export', id]); return { created: true }; },
    openSettings: async (action: string) => { calls.push(['settings', action]); },
  } } };
  const ui = await import('../../desktop/renderer/panels/gaming.js');
  try {
    assert.equal(ui.normalizeGamingSnapshot({ ...base, runningGameIds: [gameId] }), null);
    ui.bindGamingSettingsEvents();
    await until(() => Boolean(find(body, node => node.type === 'checkbox')));
    const minimize = find(body, node => node.type === 'checkbox')!;
    assert.equal(minimize.checked, true); minimize.focus(); minimize.checked = false; minimize.event('change');
    await until(() => calls.length === 1 && find(body, node => node.type === 'checkbox')?.checked === false);
    assert.deepEqual(calls[0], ['configure', { minimizeOnLaunch: false, restoreOnExit: false }]);
    await until(() => (globalThis as any).document.activeElement?.dataset.gamingFocus === 'preference-minimizeOnLaunch');
    assert.equal((globalThis as any).document.activeElement, find(body, node => node.dataset.gamingFocus === 'preference-minimizeOnLaunch'));
    let finish!: (value: unknown) => void; current = () => new Promise(resolve => { finish = resolve; });
    const read = ui.refreshGamingSettings();
    emitState({ ...base, sequence: 5, fullscreen: true });
    finish(base); await read;
    assert.match(find(body, node => node.className.includes('gaming-fullscreen'))?.textContent ?? '', /해제|Leave fullscreen/);
    assert.equal((globalThis as any).document.activeElement.dataset.gamingFocus, 'preference-minimizeOnLaunch');
    outside.focus(); emitState({ ...base, sequence: 6, fullscreen: true });
    assert.equal((globalThis as any).document.activeElement, outside, 'events do not steal focus from another panel');
    const detail = new Element(); ui.renderGameGamingActions(detail, { profile: { id: gameId } });
    find(detail, node => node.className.includes('gaming-shortcut-export'))!.event('click');
    await until(() => calls.some(call => call[0] === 'export'));
    assert.deepEqual(calls.find(call => call[0] === 'export'), ['export', gameId]);
    await until(() => find(body, node => node.className.includes('gaming-open-xboxMode'))?.disabled === false);
    find(body, node => node.className.includes('gaming-open-xboxMode'))!.event('click');
    await until(() => calls.some(call => call[0] === 'settings'));
    assert.deepEqual(calls.find(call => call[0] === 'settings'), ['settings', 'xboxMode']);
    await until(() => find(body, node => node.className.includes('gaming-open-xboxMode'))?.disabled === false);
  } finally { delete (globalThis as any).window; delete (globalThis as any).document; }
});

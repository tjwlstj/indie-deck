import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindGamingMode, createGamingNavigator, spatialTarget, standardGamepadInput } from '../../desktop/renderer/gaming-mode.js';

class Events {
  handlers = new Map<string, Set<(event?: any) => void>>();
  addEventListener(name: string, handler: (event?: any) => void) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name)!.add(handler); }
  removeEventListener(name: string, handler: (event?: any) => void) { this.handlers.get(name)?.delete(handler); }
  fire(name: string, event: any = {}) { for (const handler of this.handlers.get(name) ?? []) handler(event); }
}
function fixture() {
  const document = new Events() as any, window = new Events() as any;
  const nodes: any[] = [], dialogs: any[] = [], timers = new Map<number, () => void>();
  let focused = true, time = 0, serial = 0, back = 0, toggles = 0, pad: any = null;
  document.hidden = false; document.hasFocus = () => focused; document.activeElement = null;
  document.querySelectorAll = (selector: string) => selector === 'dialog[open]' ? dialogs : nodes;
  window.setTimeout = (fn: () => void) => { const id = ++serial; timers.set(id, fn); return id; };
  window.clearTimeout = (id: number) => timers.delete(id);
  const node = (x: number, y: number, tagName = 'BUTTON') => {
    const value: any = { tagName, tabIndex: 0, disabled: false, clicks: 0, hidden: false,
      getBoundingClientRect: () => ({ left: x, top: y, width: 50, height: 30 }),
      getClientRects: () => value.hidden ? [] : [{}], closest: () => null, matches: () => false,
      focus: () => { document.activeElement = value; }, click: () => { value.clicks += 1; }, scrollIntoView: () => {} };
    nodes.push(value); return value;
  };
  const controller = createGamingNavigator({ document, window, readGamepads: () => [pad], now: () => time,
    onBack: () => { back += 1; }, onToggle: () => { toggles += 1; },
    schedule: (fn: () => void) => { const id = ++serial; timers.set(id, fn); return id; }, cancel: (id: number) => timers.delete(id) });
  return { document, window, nodes, dialogs, timers, node, controller,
    tick(ms = 50) { time += ms; const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); entry[1](); } },
    setPad(value: any) { pad = value; }, focus(value: boolean) { focused = value; window.fire(value ? 'focus' : 'blur'); },
    counts: () => ({ back, toggles }), key(key: string, extra: any = {}) {
      const event = { key, target: document.activeElement, repeat: false, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
      document.fire('keydown', event); return event;
    } };
}
function pad({ activate = false, back = false, direction = null as null | string } = {}) {
  return { connected: true, mapping: 'standard', axes: [0, 0], buttons: Array.from({ length: 16 }, (_, n) => ({
    pressed: n === 0 ? activate : n === 1 ? back : n === ({ up: 12, down: 13, left: 14, right: 15 } as any)[direction ?? ''], value: 0,
  })) };
}

test('directional navigation chooses an enabled visible control and preserves editable keys', () => {
  const f = fixture(), a = f.node(0, 0), b = f.node(100, 0), c = f.node(0, 100), hidden = f.node(80, 0);
  hidden.hidden = true; a.focus(); f.controller.setEnabled(true);
  assert.equal(f.key('ArrowRight').prevented, true); assert.equal(f.document.activeElement, b);
  assert.equal(spatialTarget([a, b, c], a, 'down'), c);
  const text = f.node(0, 150, 'INPUT'); text.focus();
  assert.equal(f.key('ArrowLeft').prevented, false); assert.equal(f.key('Escape').prevented, false);
  b.focus(); f.key('Enter'); f.key('Enter', { repeat: true }); assert.equal(b.clicks, 1);
  assert.equal(f.key('Enter').stopped, true, 'capture handling must stop a row key handler from also activating');
  f.controller.dispose(); assert.equal(f.timers.size, 0);
});

test('F11 toggles once per press and Escape closes the active modal before navigating back', () => {
  const f = fixture(); f.node(0, 0).focus();
  f.key('F11'); f.key('F11', { repeat: true }); assert.equal(f.counts().toggles, 1);
  f.controller.setEnabled(true); let closed = 0;
  f.dialogs.push({ close: () => { closed += 1; f.dialogs.pop(); }, querySelectorAll: () => [] });
  f.key('Escape'); assert.equal(closed, 1); assert.equal(f.counts().back, 0);
  f.key('Escape'); f.key('Escape', { repeat: true }); assert.equal(f.counts().back, 1);
  assert.equal(f.key('F11', { ctrlKey: true }).prevented, false);
  f.controller.dispose();
});

test('held controller activation never repeats and resume requires neutral input', () => {
  const f = fixture(), a = f.node(0, 0); a.focus(); f.setPad(pad({ activate: true })); f.controller.setEnabled(true);
  f.tick(); f.tick(); assert.equal(a.clicks, 0, 'held input at mode entry cannot launch');
  f.setPad(pad()); f.tick(); f.setPad(pad({ activate: true })); f.tick(); f.tick(); f.tick(); assert.equal(a.clicks, 1);
  f.focus(false); assert.equal(f.timers.size, 0);
  f.focus(true); f.tick(); assert.equal(a.clicks, 1);
  f.setPad(pad()); f.tick(); f.setPad(pad({ activate: true })); f.tick(); assert.equal(a.clicks, 2);
  f.document.hidden = true; f.document.fire('visibilitychange'); assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('controller movement repeats at bounded intervals and unknown mappings are ignored', () => {
  const f = fixture(), a = f.node(0, 0), b = f.node(0, 100), c = f.node(0, 200); a.focus();
  f.controller.setEnabled(true); f.setPad(pad()); f.tick();
  f.setPad(pad({ direction: 'down' })); f.tick(); assert.equal(f.document.activeElement, b);
  f.tick(50); assert.equal(f.document.activeElement, b);
  f.tick(350); assert.equal(f.document.activeElement, c);
  f.setPad({ ...pad({ activate: true }), mapping: '' }); f.tick(); assert.equal(c.clicks, 0);
  assert.equal(standardGamepadInput({ ...pad(), axes: [0.2, -0.9] }).direction, 'up');
  f.controller.dispose();
});

test('modal scope prevents a controller from activating background launch controls', () => {
  const f = fixture(), launch = f.node(0, 0), cancel = f.node(0, 50); launch.focus();
  f.dialogs.push({ close: () => {}, querySelectorAll: () => [cancel] });
  f.controller.setEnabled(true); f.setPad(pad()); f.tick(); f.setPad(pad({ activate: true })); f.tick();
  assert.equal(launch.clicks, 0); assert.equal(cancel.clicks, 1);
  f.controller.dispose();
});

test('no controller means no recurring polling and reconnect cannot activate a held button', () => {
  const f = fixture(), launch = f.node(0, 0); launch.focus(); f.controller.setEnabled(true);
  f.tick(); assert.equal(f.timers.size, 0);
  f.setPad(pad({ activate: true })); f.window.fire('gamepadconnected'); f.tick(); assert.equal(launch.clicks, 0);
  f.setPad(pad()); f.tick(); f.setPad(pad({ activate: true })); f.tick(); assert.equal(launch.clicks, 1);
  f.controller.setEnabled(false); assert.equal(f.timers.size, 0); f.controller.dispose();
});

test('navigation restores focus to the selected replacement row after a view rebuild', () => {
  const f = fixture(), old = f.node(0, 0); old.focus(); f.controller.setEnabled(true); f.setPad(pad()); f.tick();
  f.nodes.splice(f.nodes.indexOf(old), 1);
  const replacement = f.node(0, 100); replacement.matches = (selector: string) => selector === '.game.selected';
  f.setPad(pad({ activate: true })); f.tick();
  assert.equal(old.clicks, 0); assert.equal(replacement.clicks, 1); assert.equal(f.document.activeElement, replacement);
  f.controller.dispose();
});

test('gamepad A cycles native select options without opening an uncontrolled popup', () => {
  const f = fixture(), select = f.node(0, 0, 'SELECT'); let changes = 0;
  select.options = [{ disabled: false }, { disabled: true }, { disabled: false }]; select.selectedIndex = 0;
  select.dispatchEvent = () => { changes += 1; }; f.window.Event = class {};
  select.focus(); f.controller.setEnabled(true); f.setPad(pad()); f.tick(); f.setPad(pad({ activate: true })); f.tick();
  assert.equal(select.selectedIndex, 2); assert.equal(changes, 1);
  f.controller.dispose();
});

test('fullscreen presentation accepts only confirmed ordered main snapshots and deduplicates toggles', async () => {
  const f = fixture(), button = f.node(0, 0), hint = { hidden: true, textContent: '' };
  const classes = new Set<string>();
  button.setAttribute = () => {};
  button.addEventListener = () => {};
  f.document.body = { dataset: {}, classList: { toggle(name: string, enabled: boolean) { enabled ? classes.add(name) : classes.delete(name); } } };
  f.document.getElementById = (id: string) => id === 'toggleGamingMode' ? button : hint;
  let publish: (value: any) => void = () => {}, first: (value: any) => void = () => {}, finish: (value: any) => void = () => {};
  let calls = 0, unsubscribed = 0;
  const mode = bindGamingMode({ document: f.document, window: f.window, api: {
    onState: (fn: any) => { publish = fn; return () => { unsubscribed += 1; }; },
    current: () => new Promise(resolve => { first = resolve; }),
    setFullscreen: () => { calls += 1; return new Promise(resolve => { finish = resolve; }); },
  } });
  await Promise.resolve(); publish({ sequence: 2, fullscreen: true });
  first({ sequence: 1, fullscreen: false }); await Promise.resolve(); await Promise.resolve();
  assert.equal(classes.has('gaming-mode'), true); assert.equal(hint.hidden, false);
  publish({ fullscreen: false }); assert.equal(classes.has('gaming-mode'), true, 'malformed snapshots cannot change mode');
  const pending = mode.toggle(false); void mode.toggle(false); assert.equal(calls, 1);
  finish({ sequence: 3, fullscreen: false }); await pending;
  assert.equal(classes.has('gaming-mode'), false); assert.equal(f.timers.size, 0);
  mode.dispose(); f.controller.dispose(); assert.equal(unsubscribed, 1);
});

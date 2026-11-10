import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindThumbnailPreview, releaseThumbnailPreviews } from '../../desktop/renderer/thumbnail-preview.js';

class Events {
  handlers = new Map<string, { fn: (event: any) => void; options?: unknown }[]>();
  addEventListener(type: string, fn: (event: any) => void, options?: unknown) { this.handlers.set(type, [...(this.handlers.get(type) || []), { fn, options }]); }
  removeEventListener(type: string, fn: (event: any) => void) { this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item.fn !== fn)); }
  fire(type: string, values: any = {}) {
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    for (const { fn } of [...(this.handlers.get(type) || [])]) fn(event);
    return event;
  }
}
class Element extends Events {
  tagName: string; className = ''; id = ''; textContent = ''; src = ''; alt = ''; type = ''; hidden = false;
  dataset: any = {}; style: any = {}; attributes: any = {}; children: Element[] = []; parent: Element | null = null;
  ownerDocument: any;
  constructor(tag: string, document: any) { super(); this.tagName = tag; this.ownerDocument = document; }
  get isConnected(): boolean { return this === this.ownerDocument.body || Boolean(this.parent?.isConnected); }
  append(...nodes: Element[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  contains(node: Element): boolean { return this === node || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector === '[data-thumbnail-preview]' && child.dataset.thumbnailPreview ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { top: 220, left: 20, right: 80, bottom: 260 }; }
}
const image = { source: 'manual', dataUrl: 'data:image/png;base64,AAAA' };
const other = { source: 'local', dataUrl: 'data:image/png;base64,BBBB' };
const flush = async () => { for (let n = 0; n < 3; n += 1) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const document: any = new Events(), window: any = new Events(); document.defaultView = window;
  window.innerWidth = 600; window.innerHeight = 320; document.hidden = false; document.activeElement = null;
  document.createElement = (tag: string) => new Element(tag, document); document.body = document.createElement('body');
  const target = document.createElement('div'), toggle = document.createElement('button'); document.body.append(target, toggle);
  const timers = new Map<number, () => void>(); let timerId = 0, mode = 'off', calls = 0;
  let read: () => unknown = () => image;
  const options = { document, window, toggleButton: toggle, label: 'Current game', mode: () => mode,
    getThumbnail: () => { calls += 1; return read(); },
    schedule: (fn: () => void, ms: number) => { assert.equal(ms, 350); timers.set(++timerId, fn); return timerId; }, cancel: (id: number) => timers.delete(id) };
  const controller = bindThumbnailPreview(target, options);
  const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
  const find = (className: string) => all(document.body).find(node => node.className.split(' ').includes(className));
  return { document, window, target, toggle, timers, controller, options, find,
    setMode(value: string) { mode = value; }, setRead(fn: () => unknown) { read = fn; }, calls: () => calls,
    advance() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    click() { document.fire('pointerdown', { target: toggle }); toggle.fire('click'); },
  };
}

test('manual preview toggles without choosing an image; sibling toggle closes correctly and Escape captures before document navigation', async () => {
  const f = fixture(); f.target.fire('mouseenter'); f.advance(); await flush();
  assert.equal(f.calls(), 0); assert.equal(f.target.fire('contextmenu').prevented, false);
  f.click(); await flush(); assert.equal(f.calls(), 1);
  assert.equal(f.find('thumbnail-preview-image')?.src, image.dataUrl);
  assert.equal(f.toggle.attributes['aria-expanded'], 'true');
  f.window.fire('scroll', { target: f.find('thumbnail-preview-image') });
  assert.ok(f.find('thumbnail-preview-popover'), 'scrolling inside the preview must not dismiss its image');
  assert.equal(f.window.handlers.get('keydown')?.[0]?.options, true);
  const key = f.window.fire('keydown', { key: 'Escape' });
  assert.equal(key.prevented, true); assert.equal(key.stopped, true);
  assert.equal(f.find('thumbnail-preview-popover'), undefined); assert.equal(f.document.activeElement, f.toggle);
  f.click(); await flush(); f.click(); await flush();
  assert.equal(f.find('thumbnail-preview-popover'), undefined, 'pointerdown on a sibling toggle must not reopen the just-dismissed preview');
  assert.equal(f.calls(), 1, 'repeated preview uses bounded cached data');
  f.controller.dispose();
});

test('delayed hover is canceled by leaving, hiding and blur; obsolete asynchronous data cannot reopen a preview', async () => {
  const f = fixture(); f.setMode('hover');
  f.target.fire('mouseenter'); assert.equal(f.timers.size, 1); f.target.fire('mouseleave'); f.advance(); await flush(); assert.equal(f.calls(), 0);
  f.target.fire('mouseenter'); f.window.fire('scroll'); f.advance(); await flush(); assert.equal(f.calls(), 0);
  f.target.fire('mouseenter'); f.window.fire('blur'); f.advance(); await flush(); assert.equal(f.calls(), 0);
  f.target.fire('mouseenter'); f.document.hidden = true; f.document.fire('visibilitychange'); f.advance(); await flush(); assert.equal(f.calls(), 0);
  f.document.hidden = false;
  let resolve!: (value: unknown) => void; f.setRead(() => new Promise(done => { resolve = done; }));
  f.target.fire('mouseenter'); f.advance(); await flush(); assert.equal(f.calls(), 1);
  f.target.fire('mouseleave'); resolve(image); await flush();
  assert.equal(f.find('thumbnail-preview-popover'), undefined);
  f.controller.dispose();
});

test('context preview deduplicates in-flight reads, respects viewport bounds and dismisses on scroll without stealing focus', async () => {
  const f = fixture(); f.setMode('context');
  let resolve!: (value: unknown) => void; f.setRead(() => new Promise(done => { resolve = done; }));
  assert.equal(f.target.fire('contextmenu').prevented, true); await flush();
  f.target.fire('contextmenu'); f.click(); f.click(); await flush(); assert.equal(f.calls(), 1);
  const popover = f.find('thumbnail-preview-popover')!;
  assert.ok(parseInt(popover.style.top) + parseInt(popover.style.maxHeight) <= f.window.innerHeight - 8);
  const previousFocus = {}; f.document.activeElement = previousFocus;
  f.window.fire('scroll'); resolve(image); await flush();
  assert.equal(f.find('thumbnail-preview-popover'), undefined); assert.equal(f.document.activeElement, previousFocus);
  f.controller.dispose();
});

test('only one preview is visible, detached results are discarded and remote image/error data are never displayed', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.setRead(() => new Promise(done => { resolve = done; })); f.click(); await flush();
  const second = f.document.createElement('div'); f.document.body.append(second);
  const next = bindThumbnailPreview(second, { document: f.document, window: f.window, label: 'Second', mode: () => 'off', getThumbnail: () => other });
  next.toggle(); await flush(); resolve(image); await flush();
  assert.equal(f.find('thumbnail-preview-label')?.textContent, 'Second');
  assert.equal(f.find('thumbnail-preview-image')?.src, other.dataUrl);
  next.dispose(); f.controller.dispose();
  const detached = fixture(); let finishDetached!: (value: unknown) => void;
  detached.setRead(() => new Promise(done => { finishDetached = done; })); detached.click(); await flush();
  detached.target.remove(); finishDetached(image); await flush();
  assert.equal(detached.find('thumbnail-preview-popover'), undefined, 'a detached target cannot retain or reopen its loading preview');
  detached.controller.dispose();
  const invalid = fixture(); invalid.setRead(() => ({ source: 'manual', dataUrl: 'https://private.invalid/image?token=secret' })); invalid.click(); await flush();
  assert.equal(invalid.find('thumbnail-preview-image'), undefined);
  assert.doesNotMatch(invalid.find('thumbnail-preview-status')!.textContent, /private|token|secret/);
  invalid.controller.invalidate(); invalid.setRead(() => { throw new Error('https://private.invalid/?token=secret'); });
  invalid.click(); await flush(); assert.equal(invalid.find('thumbnail-preview-image'), undefined);
  releaseThumbnailPreviews(invalid.document.body); assert.equal(invalid.find('thumbnail-preview-popover'), undefined);
});

test('four-image preview cache is bounded and invalidation cannot show an older applied cover', async () => {
  const f = fixture(), entries: { target: Element; controller: ReturnType<typeof bindThumbnailPreview>; calls: number }[] = [];
  f.controller.dispose();
  for (let n = 0; n < 5; n += 1) {
    const target = f.document.createElement('div'); f.document.body.append(target);
    const entry: any = { target, calls: 0 };
    entry.controller = bindThumbnailPreview(target, { document: f.document, window: f.window, getThumbnail: () => { entry.calls += 1; return image; } });
    entries.push(entry); entry.controller.toggle(); await flush();
  }
  entries[0]!.controller.toggle(); await flush(); assert.equal(entries[0]!.calls, 2);
  entries[0]!.controller.invalidate(); entries[0]!.controller.toggle(); await flush(); assert.equal(entries[0]!.calls, 3);
  for (const entry of entries) entry.controller.dispose();
});

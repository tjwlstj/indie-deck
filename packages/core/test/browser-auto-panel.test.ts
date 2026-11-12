import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserCall } from '../../../extensions/browser-companion/browser-api.js';
import { AUTO_PANEL_KEY, AUTO_PANEL_SCRIPT_ID, changeAutoPanelOrigin, normalizeAutoPanelSettings,
  readAutoPanelSettings, reconcileAutoPanelScripts, mountAutoPanelSettings, mountCompanionReload, supportedSiteOrigin } from '../../../extensions/browser-companion/auto-panel-settings.js';
import { installAutoPanelBackground } from '../../../extensions/browser-companion/background.js';
import { collectPanelArtwork, mountProductPanel, PANEL_HOST_ID } from '../../../extensions/browser-companion/page-panel.js';

class Signal {
  listeners = new Set<(...args: any[]) => any>();
  addListener(fn: (...args: any[]) => any) { this.listeners.add(fn); }
  removeListener(fn: (...args: any[]) => any) { this.listeners.delete(fn); }
  fire(...args: any[]) { return [...this.listeners].map(fn => fn(...args)); }
}
class Element {
  tagName: string; id = ''; textContent = ''; className = ''; parent: Element | null = null;
  children: Element[] = []; dataset: any = {}; hidden = false; disabled = false; value = ''; checked = false;
  type = ''; maxLength = 0; autocomplete = ''; href = ''; target = ''; rel = ''; lang = ''; name = '';
  style: any = { setProperty() {} }; attrs: any = {}; events = new Map<string, ((event: any) => any)[]>();
  constructor(tag: string) { this.tagName = tag; }
  append(...nodes: Element[]) { for (const value of nodes) { value.parent = this; this.children.push(value); } }
  replaceChildren(...nodes: Element[]) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  addEventListener(event: string, fn: (event: any) => any) { this.events.set(event, [...(this.events.get(event) ?? []), fn]); }
  removeEventListener(event: string, fn: (event: any) => any) { this.events.set(event, (this.events.get(event) ?? []).filter(item => item !== fn)); }
  click() { if (this.disabled) return; for (const fn of this.events.get('click') ?? []) fn({ preventDefault() {}, stopPropagation() {} }); }
  getElementById(id: string): Element | undefined { return all(this).find(node => node.id === id); }
  querySelectorAll(selector: string) { return all(this).filter(node => selector === '[data-i18n]' && node.dataset.i18n); }
  attachShadow(_options: unknown) { const shadow = new Element('shadow'); shadows.set(this, shadow); return shadow; }
}
const shadows = new WeakMap<Element, Element>();
function all(node: Element): Element[] { return [node, ...node.children.flatMap(all)]; }
const flush = async () => { for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve)); };
const site = 'https://store.steampowered.com';
function browserFixture(enabled = false) {
  let stored: any = { schemaVersion: 1, enabledOrigins: enabled ? [site] : [], collapsedOrigins: [] };
  let scripts: any[] = [], grants = new Set(enabled ? [`${site}/*`] : []), grantResult = true;
  const requested: any[] = [], injected: any[] = [], registrations: any[] = [];
  const changed = new Signal();
  const api: any = {
    runtime: { id: 'fixture-id', getURL: (name: string) => `chrome-extension://fixture-id/${name}`, onInstalled: new Signal(), onStartup: new Signal(), onMessage: new Signal() },
    storage: { local: { get: async () => ({ [AUTO_PANEL_KEY]: structuredClone(stored) }), set: async (input: any) => {
      const oldValue = stored; stored = structuredClone(input[AUTO_PANEL_KEY]); changed.fire({ [AUTO_PANEL_KEY]: { oldValue, newValue: stored } }, 'local');
    } }, onChanged: changed },
    permissions: { contains: async (input: any) => input.origins.every((origin: string) => grants.has(origin)), request: (input: any) => {
      requested.push(input); if (grantResult) for (const origin of input.origins) grants.add(origin); return Promise.resolve(grantResult);
    }, onAdded: new Signal(), onRemoved: new Signal() },
    scripting: { getRegisteredContentScripts: async () => scripts, unregisterContentScripts: async () => { scripts = []; },
      registerContentScripts: async (input: any[]) => { registrations.push(input); scripts = structuredClone(input); },
      executeScript: async (input: any) => { injected.push(input); return []; } },
    tabs: { query: async () => [{ id: 7, url: site + '/app/440/Fixture/', title: 'Fixture game' }] },
  };
  api.runtime.sendMessage = async () => { await reconcileAutoPanelScripts(api, true); return { ok: true }; };
  return { api, requested, injected, registrations, changed, get stored() { return stored; }, get scripts() { return scripts; },
    setGrant(value: boolean) { grantResult = value; }, revoke() { grants = new Set(); }, setStored(value: any) { stored = value; } };
}
function pageFixture(url: string) {
  const body = new Element('body'), title = new Element('title'); title.textContent = 'Fixture game';
  const events = new Map<string, Set<(...args: any[]) => void>>(), navigationEvents = new Map<string, Set<(...args: any[]) => void>>();
  const target = (listeners: Map<string, Set<(...args: any[]) => void>>) => ({
    addEventListener(name: string, fn: (...args: any[]) => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener(name: string, fn: (...args: any[]) => void) { listeners.get(name)?.delete(fn); },
  });
  const window: any = { location: { href: url }, top: null, self: null, ...target(events), navigation: target(navigationEvents) };
  window.top = window.self = window;
  let titleReads = 0, queries = 0;
  const meta = new Element('meta'); meta.setAttribute('content', 'https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg');
  const document: any = {
    body, get title() { titleReads += 1; return title.textContent; }, createElement: (tag: string) => new Element(tag),
    getElementById: (id: string) => body.getElementById(id), querySelector: (selector: string) => selector === 'title' ? title : null,
    querySelectorAll: () => { queries += 1; return [meta]; },
  };
  return { document, window, body, get titleReads() { return titleReads; }, get queries() { return queries; },
    shadow: () => shadows.get(body.getElementById(PANEL_HOST_ID)!), meta,
    navigate() { for (const listener of [...(navigationEvents.get('currententrychange') ?? [])]) listener(); } };
}

test('optional panel settings contain only bounded supported origins and never private URLs or page data', () => {
  const empty = normalizeAutoPanelSettings(undefined);
  assert.deepEqual(empty, { schemaVersion: 1, enabledOrigins: [], collapsedOrigins: [] });
  const active = changeAutoPanelOrigin(empty, site, { enabled: true, collapsed: false });
  assert.deepEqual(changeAutoPanelOrigin(active, site, { collapsed: true }).collapsedOrigins, [site]);
  assert.deepEqual(changeAutoPanelOrigin(changeAutoPanelOrigin(active, site, { collapsed: true }), site, { enabled: false }), empty);
  for (const bad of ['http://store.steampowered.com', 'https://store.steampowered.com:443', 'https://user@store.steampowered.com',
    'https://store.steampowered.com/account', 'https://store.steampowered.com?token=secret', 'https://accounts.booth.pm', 'https://api.itch.io', 'https://example.invalid']) {
    assert.equal(supportedSiteOrigin(bad), null);
    assert.throws(() => changeAutoPanelOrigin(empty, bad, { enabled: true }));
  }
  for (const bad of [{ ...active, cookies: 'private' }, { ...active, collapsedOrigins: ['https://www.gog.com'] },
    { ...active, enabledOrigins: [site, site] }, { ...active, enabledOrigins: Array(65).fill(site) }]) assert.throws(() => normalizeAutoPanelSettings(bad));
});

test('automatic script registration requires stored opt-in plus current host grants and survives repeated reconciliation', async () => {
  const f = browserFixture();
  await reconcileAutoPanelScripts(f.api, true); assert.deepEqual(f.scripts, []);
  f.setStored(changeAutoPanelOrigin(f.stored, site, { enabled: true }));
  await reconcileAutoPanelScripts(f.api, true); assert.deepEqual(f.scripts, []);
  await f.api.permissions.request({ origins: [site + '/*'] });
  await reconcileAutoPanelScripts(f.api, true);
  assert.deepEqual(f.scripts, [{ id: AUTO_PANEL_SCRIPT_ID, js: ['panel-loader.js'], matches: [site + '/*'],
    allFrames: false, runAt: 'document_idle', persistAcrossSessions: true }]);
  await reconcileAutoPanelScripts(f.api, true); assert.equal(f.registrations.length, 1);
  f.revoke(); await reconcileAutoPanelScripts(f.api, true); assert.deepEqual(f.scripts, []);
});

test('toolbar enable requests only the current site from its click, opens that tab, supports hiding and global disable', async () => {
  const f = browserFixture(), body = new Element('body');
  for (const id of ['autoPanelSettings', 'autoPanelHeading', 'enableAutoPanel', 'disableAutoPanel', 'hideAutoPanel', 'disableAllAutoPanels', 'autoPanelStatus', 'autoPanelScope', 'autoPanelRefresh']) {
    const node = new Element('div'); node.id = id; body.append(node);
  }
  const document: any = { getElementById: (id: string) => body.getElementById(id) };
  await mountAutoPanelSettings({ document, api: f.api, promiseApi: true });
  assert.deepEqual(f.requested, []); assert.deepEqual(f.registrations, []);
  document.getElementById('enableAutoPanel').click();
  assert.deepEqual(f.requested, [{ origins: [site + '/*'] }], 'permission request must occur inside the original click before asynchronous reads');
  await flush();
  assert.deepEqual(f.stored.enabledOrigins, [site]); assert.equal(f.scripts.length, 1);
  assert.deepEqual(f.injected[0], { target: { tabId: 7, frameIds: [0] }, files: ['panel-loader.js'] });
  document.getElementById('hideAutoPanel').click(); await flush(); assert.deepEqual(f.stored.collapsedOrigins, [site]);
  document.getElementById('disableAllAutoPanels').click(); await flush(); assert.deepEqual(f.stored.enabledOrigins, []); assert.deepEqual(f.scripts, []);
  assert.equal(await f.api.permissions.contains({ origins: [site + '/*'] }), true, 'hiding/disabling does not force a new browser grant next time');
});

test('private paths and frames never read page titles, image metadata or create a panel', async () => {
  const f = browserFixture(true);
  for (const url of [site + '/login/?token=private', 'https://creator.itch.io/downloads?key=private', 'https://accounts.booth.pm/library']) {
    const page = pageFixture(url);
    assert.equal(await mountProductPanel({ ...page, api: f.api, promiseApi: true }), null);
    assert.equal(page.titleReads, 0); assert.equal(page.queries, 0); assert.equal(page.body.children.length, 0);
  }
  const page = pageFixture(site + '/app/440/'); page.window.top = {};
  assert.equal(await mountProductPanel({ ...page, api: f.api, promiseApi: true }), null); assert.equal(page.titleReads, 0);
});

test('denied optional site grants leave product-only access and saved settings unchanged', async () => {
  const f = browserFixture(), body = new Element('body'); f.setGrant(false);
  for (const id of ['autoPanelSettings', 'autoPanelHeading', 'enableAutoPanel', 'disableAutoPanel', 'hideAutoPanel', 'disableAllAutoPanels', 'autoPanelStatus', 'autoPanelScope', 'autoPanelRefresh']) {
    const node = new Element('div'); node.id = id; body.append(node);
  }
  const document: any = { getElementById: (id: string) => body.getElementById(id) };
  await mountAutoPanelSettings({ document, api: f.api, promiseApi: true });
  document.getElementById('enableAutoPanel').click(); await flush();
  assert.deepEqual(f.stored.enabledOrigins, []); assert.deepEqual(f.scripts, []); assert.deepEqual(f.injected, []);
  assert.match(document.getElementById('autoPanelStatus').textContent, /허용하지 않아/);
  assert.equal(document.getElementById('enableAutoPanel').disabled, false);
});

test('own-extension reload requires a direct trusted toolbar click and cannot be mounted on a product page', () => {
  let calls = 0;
  const f = browserFixture(); f.api.runtime.reload = () => { calls += 1; };
  const button = new Element('button'), status = new Element('p');
  const document: any = { location: { href: f.api.runtime.getURL('popup.html') }, getElementById: (id: string) => id === 'reloadCompanion' ? button : status };
  mountCompanionReload({ document, api: f.api }); assert.equal(calls, 0); assert.equal(button.disabled, false);
  button.click(); assert.equal(calls, 1); button.click(); assert.equal(calls, 1);
  const foreign = new Element('button');
  mountCompanionReload({ document: { location: { href: site + '/app/440/' }, getElementById: () => foreign }, api: f.api });
  assert.equal(foreign.disabled, true); foreign.click(); assert.equal(calls, 1);
});

test('a product panel mounts once with scoped controls, captures only on request, persists hide/reopen and responds to site disable', async () => {
  const f = browserFixture(true), page = pageFixture(site + '/app/440/Fixture/');
  const panel = await mountProductPanel({ ...page, api: f.api, promiseApi: true });
  assert.ok(panel); assert.equal(page.body.children.length, 1); assert.equal(page.titleReads, 1); assert.equal(page.queries, 0);
  assert.equal(await mountProductPanel({ ...page, api: f.api, promiseApi: true }), panel);
  const shadow = page.shadow()!;
  assert.equal(shadow.getElementById('indiedeckPanel')!.hidden, false);
  assert.equal(shadow.getElementById('panelReopen')!.hidden, true);
  assert.equal(shadow.getElementById('provider')!.textContent, 'Steam');
  shadow.getElementById('findArtwork')!.click(); await flush();
  assert.equal(page.queries, 1); assert.equal(shadow.getElementById('includeArtwork')!.checked, true);
  assert.equal(shadow.getElementById('artworkChoice')!.value, 'https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg');
  shadow.getElementById('panelHide')!.click(); await flush();
  assert.deepEqual(f.stored.collapsedOrigins, [site]); assert.equal(shadow.getElementById('indiedeckPanel')!.hidden, true);
  shadow.getElementById('panelReopen')!.click(); await flush();
  assert.deepEqual(f.stored.collapsedOrigins, []); assert.equal(shadow.getElementById('indiedeckPanel')!.hidden, false);
  page.window.location.href = site + '/account/?token=private';
  assert.throws(() => collectPanelArtwork(page.document, page.window, { provider: 'steam', productId: '440' }, site));
  assert.equal(page.queries, 1, 'changed private route must be rejected before querying metadata');
  page.window.location.href = site + '/app/440/Fixture/';
  shadow.getElementById('panelDisableSite')!.click(); await flush(); assert.equal(page.body.children.length, 0);
});

test('background sync accepts only its trusted popup and removes revoked origins without exposing runtime errors', async () => {
  const f = browserFixture(true), background = installAutoPanelBackground(f.api, true); await background.sync();
  let response: unknown;
  const listener = [...f.api.runtime.onMessage.listeners][0] as any;
  assert.equal(listener({ kind: 'indiedeck-auto-panel-sync' }, { id: 'other', url: f.api.runtime.getURL('popup.html') }, () => {}), undefined);
  assert.equal(listener({ kind: 'indiedeck-auto-panel-sync' }, { id: f.api.runtime.id, tab: { id: 7 }, url: site + '/app/440/' }, () => {}), undefined);
  assert.equal(listener({ kind: 'indiedeck-auto-panel-sync' }, { id: f.api.runtime.id, url: f.api.runtime.getURL('popup.html') }, (value: unknown) => { response = value; }), true);
  await flush(); assert.deepEqual(response, { ok: true });
  f.revoke(); f.api.permissions.onRemoved.fire({ origins: [site + '/*'] }); await flush();
  assert.deepEqual(f.stored.enabledOrigins, []); assert.deepEqual(f.scripts, []);
});

test('same-document private navigation disposes existing UI without reading private title or metadata', async () => {
  const f = browserFixture(true), page = pageFixture(site + '/app/440/Fixture/');
  assert.ok(await mountProductPanel({ ...page, api: f.api, promiseApi: true }));
  page.window.location.href = site + '/account/?token=private'; page.navigate(); await flush();
  assert.equal(page.body.children.length, 0); assert.equal(page.titleReads, 1); assert.equal(page.queries, 0);
});

test('a URL-only soft navigation from a non-product route can open a newly supported product without private DOM reads', async () => {
  const f = browserFixture(true), page = pageFixture(site + '/account/?token=private');
  assert.equal(await mountProductPanel({ ...page, api: f.api, promiseApi: true }), null);
  assert.equal(page.titleReads, 0); assert.equal(page.queries, 0);
  page.window.location.href = site + '/app/440/Fixture/'; page.navigate(); await flush();
  assert.equal(page.body.children.length, 1); assert.equal(page.titleReads, 1); assert.equal(page.queries, 0);
});

test('a disable that races the initial panel mount is read again before the panel can remain visible', async () => {
  const f = browserFixture(true), page = pageFixture(site + '/app/440/Fixture/'); let reads = 0;
  f.api.storage.local.get = async () => ({ [AUTO_PANEL_KEY]: ++reads === 1 ? f.stored : { schemaVersion: 1, enabledOrigins: [], collapsedOrigins: [] } });
  assert.equal(await mountProductPanel({ ...page, api: f.api, promiseApi: true }), null);
  assert.equal(page.body.children.length, 0); assert.equal(reads, 2);
});

test('browser callback adapter hides private callback failures and storage corruption is not overwritten', async () => {
  await assert.rejects(browserCall({ runtime: { lastError: { message: 'private-secret' } } }, { op: (done: (v: unknown) => void) => done(null) }, 'op'), /Browser operation failed/);
  const f = browserFixture(); f.setStored({ invalid: 'private' });
  await assert.rejects(readAutoPanelSettings(f.api, true), /Invalid panel settings/);
  assert.deepEqual(f.stored, { invalid: 'private' });
});

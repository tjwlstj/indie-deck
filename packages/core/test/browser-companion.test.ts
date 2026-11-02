import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  LINK_FILENAME, cleanDisplayTitle, metadataFromProductUrl, productPageForMetadata,
  serializeStoreLink, validProductId, validateStoreLink,
} from '../../../extensions/browser-companion/store-link.js';
import { currentTab, MESSAGES, mountPopup, saveConnectionFile } from '../../../extensions/browser-companion/popup-controller.js';

const root = new URL('../../../extensions/browser-companion/', import.meta.url);
const fixtures = [
  ['https://store.steampowered.com/app/12345/Example_Game/?session=private#token=secret', 'steam', '12345'],
  ['https://store.epicgames.com/ko/p/example-game?session=private#secret', 'epic', 'example-game'],
  ['https://www.gog.com/en/game/example_game?token=private#secret', 'gog', 'example_game'],
  ['https://example-studio.itch.io/example-game?download_id=private#secret', 'itch', 'example-studio/example-game'],
  ['https://example-studio.booth.pm/items/123456?token=private#secret', 'booth', '123456'],
  ['https://www.dlsite.com/home/work/=/product_id/RJ12345678.html?token=private#secret', 'dlsite', 'home:RJ12345678'],
] as const;

test('official public product routes export only bounded provider identity and optional display title', () => {
  for (const [url, provider, productId] of fixtures) {
    const metadata = metadataFromProductUrl(url, '  Example\u0000\u202e game  ');
    assert.deepEqual(metadata, { schemaVersion: 1, kind: 'indiedeck-store-link', provider, productId, title: 'Example game' });
    const serialized = serializeStoreLink(metadata);
    assert.doesNotMatch(serialized, /private|secret|session|token|download_id|https|filePath|referrer/);
    assert.equal(Buffer.byteLength(serialized) < 8192, true);
    const canonical = productPageForMetadata(metadata);
    assert.equal(new URL(canonical).protocol, 'https:');
    assert.equal(new URL(canonical).search, ''); assert.equal(new URL(canonical).hash, '');
    assert.deepEqual(metadataFromProductUrl(canonical), { schemaVersion: 1, kind: 'indiedeck-store-link', provider, productId });
  }
  assert.equal(cleanDisplayTitle('x'.repeat(500)).length, 240);
  assert.equal('title' in metadataFromProductUrl(fixtures[0][0], ' \u0000 '), false);
});

test('spoofed origins, credentials, ports, private routes and unknown locale paths cannot become product links', () => {
  const rejected = [
    'http://store.steampowered.com/app/12345', 'https://store.steampowered.com.evil.test/app/12345',
    'https://evil.test@store.steampowered.com/app/12345', 'https://store.steampowered.com:443/app/12345',
    'https://store.steampowered.com:8443/app/12345', 'https://store.steampowered.com/account/',
    'https://store.steampowered.com/app/12345/private/download', 'https://store.steampowered.com/app/012345',
    'https://store.epicgames.com/xx/p/example-game', 'https://store.epicgames.com/en-US/p/example-game/download',
    'https://www.gog.com/account', 'https://www.gog.com/xx/game/example_game',
    'https://itch.io/my-purchases', 'https://www.itch.io/example-game', 'https://api.itch.io/example-game',
    'https://example-studio.itch.io/downloads?token=secret', 'https://example-studio.itch.io/my-purchases',
    'https://example-studio.itch.io/example-game/download', 'https://example-studio.itch.io/%64ownloads',
    'https://booth.pm/ja/orders', 'https://booth.pm/xx/items/12345', 'https://booth.pm.evil.test/ja/items/12345',
    'https://www.dlsite.com/home/download/=/product_id/RJ123456.html',
    'https://www.dlsite.com/home/work/=/product_id/RJ123456.html/download',
    'https://www.dmm.com/example', 'file:///C:/private.html', 'chrome://settings',
    'javascript:alert(1)', 'https://store.steampowered.com\\@evil.test/app/12345',
  ];
  for (const url of rejected) assert.equal(metadataFromProductUrl(url, 'Ignore me'), null, url);
});

test('identifier schema rejects extra payload fields and malformed identities before JSON export', () => {
  const good = metadataFromProductUrl(fixtures[0][0]);
  assert.deepEqual(validateStoreLink(good), good);
  for (const extra of ['url', 'cookies', 'headers', 'filePath', 'downloadUrl', 'accessToken']) {
    assert.throws(() => serializeStoreLink({ ...good, [extra]: 'secret' }), /Unsupported/);
  }
  for (const bad of [null, [], {}, { ...good, schemaVersion: 2 }, { ...good, provider: 'unknown' },
    { ...good, productId: '../arbitrary' }, { ...good, title: '\u0000private' }, { ...good, title: 'x'.repeat(241) },
    Object.create(good)]) assert.throws(() => serializeStoreLink(bad), /Unsupported/);
  for (const [provider, productId] of [['steam', '0'], ['steam', '01234'], ['steam', '12345678901'],
    ['booth', '1234567890123'], ['itch', 'creator/downloads'], ['itch', 'www/game'], ['epic', 'UPPERCASE'],
    ['gog', 'a/b'], ['dlsite', 'home:RJ12345'], ['dlsite', 'other:RJ123456']]) {
    assert.equal(validProductId(provider, productId), false, `${provider}: ${productId}`);
  }
});

class Element {
  textContent = ''; value = ''; disabled = false; hidden = false; href = '';
  listeners = new Map<string, () => Promise<void> | void>();
  addEventListener(event: string, listener: () => Promise<void> | void) { this.listeners.set(event, listener); }
  async click() { await this.listeners.get('click')?.(); }
}
function popupDocument() {
  const elements = Object.fromEntries(['status', 'preview', 'saveLink', 'productTitle', 'provider', 'productId', 'productPage'].map((key) => [key, new Element()]));
  return { elements, documentElement: { lang: '' }, getElementById: (id: string) => elements[id], querySelectorAll: () => [] };
}

test('popup Chrome callback query inspects one active tab and exports only after an explicit review click', async () => {
  const document = popupDocument(), calls: unknown[] = [], downloads: { filename: string; contents: string }[] = [];
  const api = { runtime: {}, tabs: { query: (options: unknown, done: (tabs: unknown[]) => void) => {
    calls.push(options); done([{ url: fixtures[0][0], title: 'Original title' }]);
  } } };
  const result = await mountPopup({ document, api, language: 'ko-KR', saveFile: async (data: { filename: string; contents: string }) => { downloads.push(data); } });
  assert.equal(result.supported, true); assert.equal(document.documentElement.lang, 'ko');
  assert.deepEqual(calls, [{ active: true, currentWindow: true }]);
  assert.equal(downloads.length, 0); assert.equal(document.elements.preview.hidden, false);
  assert.equal(document.elements.provider.textContent, 'Steam');
  assert.equal(document.elements.productPage.href, 'https://store.steampowered.com/app/12345/');
  document.elements.productTitle.value = 'Reviewed title';
  await document.elements.saveLink.click();
  assert.equal(downloads.length, 1); assert.equal(downloads[0]!.filename, LINK_FILENAME);
  assert.deepEqual(JSON.parse(downloads[0]!.contents), { schemaVersion: 1, kind: 'indiedeck-store-link', provider: 'steam', productId: '12345', title: 'Reviewed title' });
  assert.equal(document.elements.status.textContent, MESSAGES.ko.saved);
  assert.equal(document.elements.saveLink.disabled, false);
});

test('Firefox Promise query and unsupported/error pages expose no hidden export action or private error text', async () => {
  const supported = popupDocument(); let saved = 0;
  const api = { tabs: { query: async () => [{ url: fixtures[3][0], title: 'Example game' }] } };
  await mountPopup({ document: supported, api, promiseApi: true, language: 'en-US', saveFile: async () => { saved += 1; } });
  assert.equal(supported.documentElement.lang, 'en'); assert.equal(supported.elements.saveLink.disabled, false);
  supported.elements.productTitle.value = '';
  await supported.elements.saveLink.click(); assert.equal(saved, 1);
  for (const brokenApi of [
    { tabs: { query: async () => [{ url: 'https://example-studio.itch.io/downloads?token=private', title: 'Private' }] } },
    { tabs: { query: async () => { throw new Error('private-account@example.invalid'); } } },
    {},
  ]) {
    const document = popupDocument();
    const outcome = await mountPopup({ document, api: brokenApi, promiseApi: true, language: 'en-US', saveFile: async () => { saved += 1; } });
    assert.equal(outcome.supported, false); assert.equal(document.elements.preview.hidden, true);
    assert.equal(document.elements.saveLink.disabled, true); assert.equal(document.elements.saveLink.listeners.size, 0);
    assert.doesNotMatch(document.elements.status.textContent, /private|example.invalid/);
  }
  assert.equal(saved, 1);
  await assert.rejects(currentTab({ runtime: { lastError: { message: 'secret' } }, tabs: { query: (_options: unknown, done: (value: unknown[]) => void) => done([]) } }), /query failed/);
});

test('an export in progress rejects a second click and reports save requests without claiming browser completion', async () => {
  const document = popupDocument(); let finish!: () => void, saves = 0;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  await mountPopup({ document, api: { tabs: { query: async () => [{ url: fixtures[1][0] }] } }, promiseApi: true,
    saveFile: async () => { saves += 1; await pending; } });
  const first = document.elements.saveLink.click();
  await document.elements.saveLink.click();
  assert.equal(saves, 1); assert.equal(document.elements.saveLink.disabled, true);
  finish(); await first;
  assert.equal(document.elements.status.textContent, MESSAGES.ko.saved);
  assert.equal(document.elements.saveLink.disabled, false);
});

test('browser manifests request only activeTab and contain no background, host or profile privileges', () => {
  const launcherVersion = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  for (const name of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(fs.readFileSync(new URL(name, root), 'utf8'));
    assert.equal(manifest.manifest_version, 3); assert.equal(manifest.version, launcherVersion);
    assert.deepEqual(manifest.permissions, ['activeTab']);
    for (const key of ['host_permissions', 'optional_permissions', 'background', 'content_scripts', 'externally_connectable']) assert.equal(key in manifest, false);
    assert.equal(manifest.action.default_popup, 'popup.html');
    assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
    if (name === 'manifest.firefox.json') {
      assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '140.0');
      assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['browsingActivity', 'websiteContent']);
    }
  }
  for (const name of ['popup.html', 'popup.css', 'popup.js', 'popup-controller.js', 'store-link.js']) {
    assert.equal(fs.statSync(new URL(name, root)).isFile(), true);
  }
});

test('connection-file saving uses a local JSON Blob and cleans its temporary anchor and object URL', async () => {
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL, oldTimeout = globalThis.setTimeout;
  const timeouts: (() => void)[] = [], revoked: string[] = [];
  let created: Blob | undefined, clicked = 0, removed = 0, attached = 0;
  const anchor = { href: '', download: '', hidden: false,
    click: () => { clicked += 1; }, remove: () => { removed += 1; } };
  URL.createObjectURL = (value) => { created = value as Blob; return 'blob:local-test'; };
  URL.revokeObjectURL = (value) => { revoked.push(String(value)); };
  globalThis.setTimeout = ((callback: () => void) => { timeouts.push(callback); return undefined; }) as typeof setTimeout;
  try {
    const contents = serializeStoreLink(metadataFromProductUrl(fixtures[0][0]));
    saveConnectionFile({ document: { body: { append: () => { attached += 1; } }, createElement: () => anchor }, filename: LINK_FILENAME, contents });
    assert.equal(created?.type, 'application/json;charset=utf-8');
    assert.equal(await created?.text(), contents);
    assert.equal(anchor.href, 'blob:local-test'); assert.equal(anchor.download, LINK_FILENAME);
    assert.equal(attached, 1); assert.equal(clicked, 1); assert.equal(removed, 1);
    assert.deepEqual(revoked, []); assert.equal(timeouts.length, 1);
    timeouts[0]!(); assert.deepEqual(revoked, ['blob:local-test']);
  } finally { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; globalThis.setTimeout = oldTimeout; }
});

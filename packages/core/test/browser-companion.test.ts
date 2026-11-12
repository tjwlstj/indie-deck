import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  LINK_FILENAME, cleanDisplayTitle, metadataFromProductUrl, productPageForMetadata,
  serializeStoreLink, validProductId, validateStoreLink,
} from '../../../extensions/browser-companion/store-link.js';
import { capturePageArtwork, currentProductArtwork, currentTab, MESSAGES, mountPopup, saveConnectionFile } from '../../../extensions/browser-companion/popup-controller.js';
import { normalizeArtworkUrl } from '../../../extensions/browser-companion/artwork.js';
import { OPTIONAL_SITE_PATTERNS } from '../../../extensions/browser-companion/auto-panel-settings.js';

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
  textContent = ''; value = ''; disabled = false; hidden = false; href = ''; checked = false;
  children: Element[] = [];
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  listeners = new Map<string, () => Promise<void> | void>();
  addEventListener(event: string, listener: () => Promise<void> | void) { this.listeners.set(event, listener); }
  async click() { await this.listeners.get('click')?.(); }
}
function popupDocument() {
  const elements = Object.fromEntries(['status', 'preview', 'saveLink', 'copyLink', 'productTitle', 'provider', 'productId', 'productPage',
    'findArtwork', 'artworkChoice', 'includeArtwork', 'artworkStatus'].map((key) => [key, new Element()]));
  return { elements, documentElement: { lang: '' }, getElementById: (id: string) => elements[id], querySelectorAll: () => [], createElement: () => new Element() };
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

test('explicit companion copy exports reviewed metadata only and failed clipboard writes retain file fallback', async () => {
  const document = popupDocument(), copied: string[] = [];
  let downloads = 0;
  await mountPopup({ document, api: { tabs: { query: async () => [{ url: fixtures[3][0], title: 'Original' }] } }, promiseApi: true,
    writeClipboard: async (contents: string) => { copied.push(contents); }, saveFile: async () => { downloads += 1; } });
  assert.deepEqual(copied, []);
  document.elements.productTitle.value = 'Reviewed label';
  await document.elements.copyLink.click();
  assert.deepEqual(JSON.parse(copied[0]!), { schemaVersion: 1, kind: 'indiedeck-store-link', provider: 'itch', productId: 'example-studio/example-game', title: 'Reviewed label' });
  assert.doesNotMatch(copied[0]!, /private|secret|download_id|https/);
  assert.equal(downloads, 0); assert.equal(document.elements.status.textContent, MESSAGES.ko.copied);
  const denied = popupDocument();
  await mountPopup({ document: denied, api: { tabs: { query: async () => [{ url: fixtures[0][0] }] } }, promiseApi: true,
    writeClipboard: async () => { throw new Error('private clipboard denial'); }, saveFile: async () => { downloads += 1; } });
  await denied.elements.copyLink.click();
  assert.equal(denied.elements.status.textContent, MESSAGES.ko.copyFailed);
  assert.equal(denied.elements.copyLink.disabled, false); assert.equal(denied.elements.saveLink.disabled, false);
  await denied.elements.saveLink.click(); assert.equal(downloads, 1);
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

test('in-page context never queries another tab and rejects exports after a private navigation', async () => {
  const document = popupDocument(); let current = true, files = 0, copies = 0;
  const metadata = metadataFromProductUrl(fixtures[0][0], 'Public fixture');
  await mountPopup({ document, api: { tabs: { query: () => { throw new Error('In-page contexts must not query tabs'); } } },
    productContext: { metadata, isCurrent: () => current, readArtwork: () => [] },
    saveFile: async () => { files += 1; }, writeClipboard: async () => { copies += 1; } });
  assert.equal(document.elements.productTitle.value, 'Public fixture');
  current = false;
  await document.elements.saveLink.click(); await document.elements.copyLink.click();
  assert.equal(files, 0); assert.equal(copies, 0);
  assert.equal(document.elements.status.textContent, MESSAGES.ko.copyFailed);
});

test('browser manifests keep automatic site access optional and scope background/module resources to supported sites', () => {
  const extensionVersion = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8')).version;
  assert.match(extensionVersion, /^\d+\.\d+\.\d+$/);
  for (const name of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(fs.readFileSync(new URL(name, root), 'utf8'));
    assert.equal(manifest.manifest_version, 3); assert.equal(manifest.version, extensionVersion);
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
    for (const key of ['host_permissions', 'optional_permissions', 'content_scripts', 'externally_connectable']) assert.equal(key in manifest, false);
    assert.deepEqual(manifest.optional_host_permissions, OPTIONAL_SITE_PATTERNS);
    assert.deepEqual(manifest.web_accessible_resources, [{ resources: ['page-panel.js', 'popup-controller.js', 'store-link.js', 'artwork.js', 'auto-panel-settings.js', 'browser-api.js'], matches: OPTIONAL_SITE_PATTERNS }]);
    assert.deepEqual(manifest.background, name === 'manifest.firefox.json' ? { scripts: ['background.js'], type: 'module' } : { service_worker: 'background.js', type: 'module' });
    assert.equal(manifest.action.default_popup, 'popup.html');
    assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
    assert.match(manifest.content_security_policy.extension_pages, /img-src 'none'/);
    if (name === 'manifest.firefox.json') {
      assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '140.0');
      assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['browsingActivity', 'websiteContent']);
    }
  }
  for (const name of ['popup.html', 'popup.css', 'popup.js', 'popup-controller.js', 'store-link.js', 'artwork.js', 'browser-api.js', 'auto-panel-settings.js', 'background.js', 'panel-loader.js', 'page-panel.js']) {
    assert.equal(fs.statSync(new URL(name, root)).isFile(), true);
  }
});

const artworkFixtures = [
  ['steam', '12345', 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/12345/abcdef/capsule_616x353.jpg?t=1730000000',
    'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/12345/abcdef/capsule_616x353.jpg'],
  ['gog', 'example_game', `https://images.gog-statics.com/${'a'.repeat(64)}_product_card.jpg`, `https://images.gog-statics.com/${'a'.repeat(64)}_product_card.jpg`],
  ['epic', 'example-game', 'https://cdn1.epicgames.com/spt-assets/namespace/image.png?resize=1&w=640&h=480&quality=80', 'https://cdn1.epicgames.com/spt-assets/namespace/image.png'],
  ['itch', 'example-studio/example-game', 'https://img.itch.zone/aW1nLzEyMzQ1.png/315x250%23c/cover.png', 'https://img.itch.zone/aW1nLzEyMzQ1.png/315x250%23c/cover.png'],
  ['booth', '123456', 'https://booth.pximg.net/c/620x620/fixture/i/123456/cover_base_resized.jpg', 'https://booth.pximg.net/c/620x620/fixture/i/123456/cover_base_resized.jpg'],
  ['dlsite', 'home:RJ12345678', 'https://img.dlsite.jp/modpub/images2/work/doujin/RJ12346000/RJ12345678_img_main.jpg', 'https://img.dlsite.jp/modpub/images2/work/doujin/RJ12346000/RJ12345678_img_main.jpg'],
] as const;

test('artwork schema is optional, versioned and limited to public provider-bound raster addresses', () => {
  for (const [provider, productId, url, expected] of artworkFixtures) {
    assert.equal(normalizeArtworkUrl(provider, productId, url), expected);
    const input = { schemaVersion: 2, kind: 'indiedeck-store-link', provider, productId, artwork: { url } };
    const parsed = JSON.parse(serializeStoreLink(input));
    assert.equal(parsed.schemaVersion, 2); assert.deepEqual(parsed.artwork, { url: expected });
    assert.equal(metadataFromProductUrl(productPageForMetadata(parsed))?.productId, productId);
    assert.throws(() => validateStoreLink({ ...input, schemaVersion: 1 }), /Unsupported/);
    assert.throws(() => validateStoreLink({ ...input, artwork: { url, cookies: 'private' } }), /Unsupported/);
    assert.throws(() => validateStoreLink({ ...input, artwork: Object.create({ url }) }), /Unsupported/);
    assert.throws(() => validateStoreLink({ ...input, artwork: { url: 'https://private.invalid/image.png' } }), /Unsupported/);
    const { artwork: _, ...missingArtwork } = input;
    assert.throws(() => validateStoreLink(missingArtwork), /Unsupported/);
  }
  for (const url of [
    'http://shared.fastly.steamstatic.com/steam/apps/12345/header.jpg',
    'https://shared.fastly.steamstatic.com.evil.invalid/steam/apps/12345/header.jpg',
    'https://private@shared.fastly.steamstatic.com/steam/apps/12345/header.jpg',
    'https://shared.fastly.steamstatic.com:443/steam/apps/12345/header.jpg',
    'https://shared.fastly.steamstatic.com/steam/apps/999/header.jpg',
    'https://shared.fastly.steamstatic.com/steam/apps/12345/../12345/header.jpg',
    'https://shared.fastly.steamstatic.com/steam/apps/12345/%2e/header.jpg',
    'https://shared.fastly.steamstatic.com/steam/apps/12345/header.jpg?token=secret',
    'https://shared.fastly.steamstatic.com/steam/apps/12345/header.jpg?t=secret',
    'https://shared.fastly.steamstatic.com/steam/apps/12345/header.jpg?t=1&t=2',
    'https://shared.fastly.steamstatic.com/steam/apps/12345/header.jpg#private',
    'https://shared.fastly.steamstatic.com/steam/apps/12345/header.svg',
    'https://127.0.0.1/image.png', 'file:///C:/private.png', 'data:image/png;base64,AA==',
  ]) assert.equal(normalizeArtworkUrl('steam', '12345', url), null, url);
  assert.equal(normalizeArtworkUrl('booth', '999', artworkFixtures[4][2]), null);
  assert.equal(normalizeArtworkUrl('dlsite', 'home:RJ99999999', artworkFixtures[5][2]), null);
  assert.equal(normalizeArtworkUrl('epic', 'example-game', artworkFixtures[2][2] + '&signature=private'), null);
  assert.equal(normalizeArtworkUrl('epic', 'example-game', artworkFixtures[2][2].replace('quality=80', 'quality=medium')), artworkFixtures[2][3]);
  assert.equal(normalizeArtworkUrl('epic', 'example-game', artworkFixtures[2][2].replace('quality=80', 'quality=custom')), null);
  assert.equal(normalizeArtworkUrl('steam', '12345', artworkFixtures[0][3] + '#'), null);
  assert.equal(normalizeArtworkUrl('itch', 'example-studio/example-game', artworkFixtures[3][2].replace('%23', '%2f')), null);
});

test('artwork capture is explicit, main-frame-only and exports the reviewed choice without a network image load', async () => {
  const document = popupDocument(), copied: string[] = [], downloads: string[] = [], injections: any[] = [];
  const first = artworkFixtures[0][2], second = 'https://cdn.cloudflare.steamstatic.com/steam/apps/12345/header.jpg';
  const tab = { id: 34, url: fixtures[0][0], title: 'Reviewed game' };
  const api = { runtime: {}, tabs: { query: (_query: unknown, done: (tabs: unknown[]) => void) => done([tab]) },
    scripting: { executeScript: (options: unknown, done: (results: unknown[]) => void) => {
      injections.push(options); done([{ frameId: 0, result: { pageUrl: tab.url, images: [first, 'https://private.invalid/account.png', second, first] } }]);
    } } };
  await mountPopup({ document, api, writeClipboard: async (contents: string) => copied.push(contents),
    saveFile: async ({ contents }: { contents: string }) => downloads.push(contents) });
  assert.equal(injections.length, 0); assert.equal(document.elements.includeArtwork.checked, false);
  await document.elements.findArtwork.click();
  assert.equal(injections.length, 1); assert.deepEqual(injections[0].target, { tabId: 34, frameIds: [0] });
  assert.equal(injections[0].world, 'ISOLATED'); assert.equal(injections[0].func, capturePageArtwork);
  assert.deepEqual(injections[0].args, ['https://store.steampowered.com', '/app/12345/Example_Game/']);
  assert.equal(document.elements.artworkChoice.children.length, 2); assert.equal(document.elements.includeArtwork.checked, true);
  document.elements.artworkChoice.value = second;
  await document.elements.copyLink.click();
  const payload = JSON.parse(copied[0]!);
  assert.equal(payload.schemaVersion, 2); assert.deepEqual(payload.artwork, { url: second });
  assert.doesNotMatch(copied[0]!, /private|secret|session|token|signature/);
  document.elements.includeArtwork.checked = false;
  await document.elements.saveLink.click();
  assert.equal(JSON.parse(downloads[0]!).schemaVersion, 1); assert.equal('artwork' in JSON.parse(downloads[0]!), false);
  assert.equal(document.elements.artworkStatus.textContent, MESSAGES.ko.artworkReady);
});

test('capture rechecks navigation and sanitizes failed or empty responses while retaining product-only export', async () => {
  const original = { id: 9, url: fixtures[0][0] }, metadata = metadataFromProductUrl(original.url);
  let injected = 0;
  await assert.rejects(currentProductArtwork({ tabs: { query: async () => [{ ...original, url: 'https://store.steampowered.com/account/' }] },
    scripting: { executeScript: async () => { injected += 1; return []; } } }, original, metadata, true), /changed/);
  assert.equal(injected, 0);
  for (const response of [
    [{ frameId: 0, result: { pageUrl: 'https://store.steampowered.com/app/999/', images: [artworkFixtures[0][2]] } }],
    [{ frameId: 1, result: { pageUrl: original.url, images: [artworkFixtures[0][2]] } }],
    [{ frameId: 0, result: { pageUrl: original.url, images: 'private' } }],
  ]) {
    const document = popupDocument(), exports: string[] = [];
    await mountPopup({ document, api: { tabs: { query: async () => [original] }, scripting: { executeScript: async () => response } },
      promiseApi: true, writeClipboard: async (text: string) => exports.push(text) });
    await document.elements.findArtwork.click();
    assert.equal(document.elements.artworkStatus.textContent, MESSAGES.ko.artworkFailed);
    assert.equal(document.elements.includeArtwork.checked, false); assert.equal(document.elements.copyLink.disabled, false);
    await document.elements.copyLink.click(); assert.equal(JSON.parse(exports[0]!).schemaVersion, 1);
  }
  const images = await currentProductArtwork({ tabs: { query: async () => [original] }, scripting: { executeScript: async () => [
    { frameId: 0, result: { pageUrl: original.url, images: Array(8).fill('https://private.invalid/p.png').concat(artworkFixtures[0][2]) } },
  ] } }, original, metadata, true);
  assert.deepEqual(images, []);
  await assert.rejects(currentProductArtwork({ runtime: { lastError: { message: 'private capture error' } },
    tabs: { query: (_query: unknown, done: (tabs: unknown[]) => void) => done([original]) },
    scripting: { executeScript: (_options: unknown, done: (value: unknown[]) => void) => done([]) } }, original, metadata), /query failed/);
});

test('pending capture deduplicates clicks and a scripting permission failure safely unlocks product-only export', async () => {
  const document = popupDocument(), copied: string[] = [];
  const tab = { id: 7, url: fixtures[0][0] };
  let resolve!: (value: unknown[]) => void, calls = 0;
  const pending = new Promise<unknown[]>(done => { resolve = done; });
  const api = { tabs: { query: async () => [tab] }, scripting: { executeScript: async () => { calls += 1; return pending; } } };
  await mountPopup({ document, api, promiseApi: true, writeClipboard: async (text: string) => copied.push(text) });
  const first = document.elements.findArtwork.click();
  await new Promise(done => setImmediate(done));
  await document.elements.findArtwork.click(); await document.elements.copyLink.click();
  assert.equal(calls, 1); assert.deepEqual(copied, []);
  assert.equal(document.elements.findArtwork.disabled, true); assert.equal(document.elements.copyLink.disabled, true);
  resolve([{ frameId: 0, result: { pageUrl: tab.url, images: [] } }]); await first;
  assert.equal(document.elements.findArtwork.disabled, false); assert.equal(document.elements.copyLink.disabled, false);
  assert.equal(document.elements.includeArtwork.disabled, true);
  assert.equal(document.elements.artworkStatus.textContent, MESSAGES.ko.artworkEmpty);
  const runtime: any = {};
  await assert.rejects(currentProductArtwork({ runtime,
    tabs: { query: (_options: unknown, done: (value: unknown[]) => void) => done([tab]) },
    scripting: { executeScript: (_options: unknown, done: (value: unknown[]) => void) => {
      runtime.lastError = { message: 'private scripting permission detail' }; done([]);
    } } }, tab, metadataFromProductUrl(tab.url)), /Artwork capture failed/);
  await document.elements.copyLink.click(); assert.equal(JSON.parse(copied[0]!).schemaVersion, 1);
});

test('the isolated page function reads no metadata on a navigation mismatch and limits reads to eight meta entries', () => {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let reads = 0, queries = 0;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://store.steampowered.com/app/12345/?session=private' } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: (selector: string) => {
    queries += 1; assert.equal(selector.includes('meta['), true); assert.equal(selector.includes('img'), false);
    return Array.from({ length: 20 }, () => ({ getAttribute: () => { reads += 1; return artworkFixtures[0][2]; } }));
  } } });
  try {
    assert.deepEqual(capturePageArtwork('https://store.steampowered.com', '/account/').images, []);
    assert.equal(queries, 0);
    assert.equal(capturePageArtwork('https://store.steampowered.com', '/app/12345/').images.length, 8);
    assert.equal(reads, 8); assert.equal(queries, 1);
  } finally {
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete (globalThis as any).location;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete (globalThis as any).document;
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

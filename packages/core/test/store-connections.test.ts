import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  STORE_PROVIDERS, canonicalStoreProductUrl, parseStoreLink, parseStoreLinkText, readStoreConnections, readStoreLinkFile,
  removeStoreConnection, resolveStoreHandoff, saveStoreConnection,
  type StoreLinkCandidate,
} from '../../desktop/src/store-connections.ts';
import { metadataFromProductUrl, productPageForMetadata, serializeStoreLink } from '../../../extensions/browser-companion/store-link.js';

const parent = path.resolve(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(parent, 'indiedeck-store-connections-'));
after(() => { assert.equal(path.dirname(temporary), parent); fs.rmSync(temporary, { recursive: true, force: true }); });
function candidate(provider = 'steam', productId = '440', title?: string): StoreLinkCandidate {
  return parseStoreLink({ schemaVersion: 1, kind: 'indiedeck-store-link', provider, productId, ...(title ? { title } : {}) });
}
function data(name: string): string { return path.join(temporary, name); }
function write(file: string, bytes: string | Buffer): string { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }

test('page metadata normalizes display text and creates only fixed canonical provider URLs', () => {
  const fixtures = [
    ['steam', '440', 'https://store.steampowered.com/app/440/'],
    ['epic', 'example-game', 'https://store.epicgames.com/en-US/p/example-game'],
    ['gog', 'example_game', 'https://www.gog.com/en/game/example_game'],
    ['itch', 'creator/example-game', 'https://creator.itch.io/example-game'],
    ['booth', '1234567', 'https://booth.pm/ja/items/1234567'],
    ['dlsite', 'home:RJ123456', 'https://www.dlsite.com/home/work/=/product_id/RJ123456.html'],
    ['dlsite', 'maniax:VJ123456789012', 'https://www.dlsite.com/maniax/work/=/product_id/VJ123456789012.html'],
  ];
  for (const [provider, productId, expected] of fixtures) {
    const parsed = candidate(provider, productId, '  로컬 테스트 작품  ');
    assert.equal(parsed.title, '로컬 테스트 작품');
    assert.equal(canonicalStoreProductUrl(parsed), expected);
    assert.equal('url' in parsed, false);
  }
});

test('browser companion metadata passes desktop validation without carrying query or fragment credentials', () => {
  for (const url of [
    'https://store.steampowered.com/app/440/Fixture/?token=private-fixture#private-fragment',
    'https://store.epicgames.com/ko/p/example-game?token=private-fixture',
    'https://www.gog.com/en/game/example_game#private-fragment',
    'https://creator.itch.io/example-game?download=private-fixture',
    'https://creator.booth.pm/items/1234567?token=private-fixture',
    'https://www.dlsite.com/home/work/=/product_id/RJ123456.html?token=private-fixture',
  ]) {
    const metadata = metadataFromProductUrl(url, 'Example title');
    assert.ok(metadata);
    const serialized = serializeStoreLink(metadata), parsed = parseStoreLink(JSON.parse(serialized));
    assert.deepEqual(parsed, metadata);
    assert.equal(canonicalStoreProductUrl(parsed), productPageForMetadata(metadata));
    assert.doesNotMatch(serialized, /private-fixture|private-fragment|https?:\/\//);
    assert.deepEqual(parseStoreLinkText(serialized), metadata);
    const pasted = parseStoreLinkText(url);
    assert.deepEqual(pasted, metadataFromProductUrl(url));
    assert.doesNotMatch(JSON.stringify(pasted), /private-fixture|private-fragment|https?:\/\//);
  }
});

test('pasted product routes reject spoofed origins, credentials, private pages and hidden JSON commands', () => {
  for (const value of ['', 'https://store.steampowered.com.evil.test/app/440/', 'https://name:secret@store.steampowered.com/app/440/',
    'https://store.steampowered.com:443/app/440/', 'https://creator.itch.io/downloads?key=secret', 'https://www.gog.com/xx/game/example_game',
    'file:///C:/game.exe', 'javascript:alert(1)', JSON.stringify({ ...candidate(), url: 'https://private.invalid/' })]) {
    assert.throws(() => parseStoreLinkText(value), /invalidLink/);
  }
  assert.throws(() => parseStoreLinkText('가'.repeat(3000)), /linkFileTooLarge/);
});

test('direct installed-game associations persist and remain exclusive of managed-product identity', async () => {
  const directory = data('installed-game'), gameId = '1234567890abcdef';
  const first = await saveStoreConnection(directory, candidate('itch', 'creator/example-game', 'Reviewed label'), undefined, gameId);
  assert.equal(first.links[0]?.gameId, gameId); assert.equal(first.links[0]?.managedProductId, undefined);
  assert.deepEqual(await readStoreConnections(directory), first);
  await assert.rejects(saveStoreConnection(directory, candidate(), undefined, '../game'), /invalidManagedProduct/);
  await assert.rejects(saveStoreConnection(directory, candidate(), crypto.randomUUID(), gameId), /invalidManagedProduct/);
  const productId = crypto.randomUUID(), second = await saveStoreConnection(directory, candidate('itch', 'creator/example-game'), productId);
  assert.equal(second.links[0]?.managedProductId, productId); assert.equal(second.links[0]?.gameId, undefined);
  const file = path.join(directory, 'store-connections.json');
  fs.writeFileSync(file, JSON.stringify({ ...second, links: [{ ...second.links[0], gameId }] }));
  await assert.rejects(readStoreConnections(directory), /connectionsCorrupt/);
});

test('metadata cannot carry credentials, downloads, commands or other unrecognized fields', () => {
  const good = candidate();
  for (const field of ['url', 'downloadUrl', 'headers', 'cookies', 'authorization', 'accessToken', 'executable', 'path', 'arguments', 'managedProductId']) {
    assert.throws(() => parseStoreLink({ ...good, [field]: 'private fixture never logged' }), /invalidLink/);
  }
  for (const input of [null, [], {}, 'https://store.steampowered.com/app/440/', { ...good, schemaVersion: 2 },
    { ...good, kind: 'download' }, { ...good, provider: 'unknown' }, { ...good, title: 'a\nb' },
    { ...good, title: '\u0085' }, { ...good, title: 'x'.repeat(241) }, { ...good, title: '   ' }]) {
    assert.throws(() => parseStoreLink(input), /ui\.stores\.error\.(?:invalidLink|invalidProvider)/);
  }
});

test('product ID grammar rejects URL injection, reserved itch endpoints and unsupported provider products', () => {
  for (const [provider, id] of [
    ['steam', '0'], ['steam', '0440'], ['steam', '1/launch'], ['steam', '440?token=secret'], ['steam', '99999999999'],
    ['epic', '../game'], ['epic', 'game#fragment'], ['epic', '%2e%2e'], ['epic', 'https://example.invalid'],
    ['gog', 'game/path'], ['gog', 'Game'], ['gog', 'a'.repeat(161)], ['booth', '-1'],
    ['itch', 'api/game'], ['itch', 'creator/download'], ['itch', 'creator/game/extra'],
    ['itch', 'creator.itch.io/game'], ['itch', 'creator@evil/game'], ['itch', '-creator/game'],
    ['dlsite', 'unknown:RJ123456'], ['dlsite', 'home:RJ12345'], ['dlsite', 'home:rj123456'],
    ['dlsite', 'home:RJ123456.html?secret=1'], ['dmm', '123'], ['fanza', '123'],
  ]) assert.throws(() => candidate(provider, id), /invalidLink/);
});

test('handoff actions are fixed, context-bound, and never claim authentication or completion', () => {
  const steam = candidate(), epic = candidate('epic', 'example-game');
  assert.deepEqual(resolveStoreHandoff('steam', 'client', steam), {
    url: 'steam://install/440', kind: 'official-client', authentication: 'unverified',
  });
  assert.equal(resolveStoreHandoff('epic', 'client', epic).url, 'com.epicgames.launcher://store/product/example-game');
  assert.equal(resolveStoreHandoff('itch', 'client').url, 'itch://library');
  assert.equal(resolveStoreHandoff('steam', 'site', steam).url, canonicalStoreProductUrl(steam));
  for (const p of STORE_PROVIDERS) {
    const result = resolveStoreHandoff(p.id, 'site');
    assert.match(result.url, /^https:\/\//); assert.equal(result.authentication, 'unverified');
    assert.equal(result.kind, 'browser'); assert.equal(p.authMode, 'external-browser');
  }
  assert.throws(() => resolveStoreHandoff('gog', 'client'), /invalidAction/);
  assert.throws(() => resolveStoreHandoff('steam', 'client'), /invalidAction/);
  assert.throws(() => resolveStoreHandoff('epic', 'client', steam), /invalidLink/);
  assert.throws(() => resolveStoreHandoff('unknown', 'site'), /invalidProvider/);
  assert.throws(() => resolveStoreHandoff('steam', 'javascript:alert(1)' as 'site'), /invalidAction/);
});

test('bounded OS-selected JSON import rejects invalid UTF-8, oversized files and source links', async (context) => {
  const good = write(path.join(temporary, 'page.indiedeck-link.json'), JSON.stringify(candidate()));
  assert.deepEqual(await readStoreLinkFile(good), candidate());
  const tooLarge = write(path.join(temporary, 'large.json'), Buffer.alloc(8193, 32));
  await assert.rejects(readStoreLinkFile(tooLarge), /linkFileTooLarge/);
  const invalidUtf8 = write(path.join(temporary, 'invalid-utf8.json'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(readStoreLinkFile(invalidUtf8), /linkFileInvalid/);
  const malformed = write(path.join(temporary, 'malformed.json'), '{"secret fixture": ');
  await assert.rejects(readStoreLinkFile(malformed), /^Error: ui\.stores\.error\.linkFileInvalid$/);
  await assert.rejects(readStoreLinkFile('relative.json'), /linkFileUnsafe/);
  const linkRoot = path.join(temporary, 'linked-import');
  try { fs.symlinkSync(path.dirname(good), linkRoot, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { context.skip(`Host link privilege unavailable: ${(error as NodeJS.ErrnoException).code}`); return; }
  await assert.rejects(readStoreLinkFile(path.join(linkRoot, path.basename(good))), /linkFileUnsafe/);
  assert.equal(fs.existsSync(good), true);
});

test('saved page identities deduplicate by provider and product while preserving UUID and independent payload ownership', async () => {
  const directory = data('deduplicate');
  const owner = write(path.join(directory, 'game-installations.json'), '{"owner":"indiedeck","active":"original"}');
  const before = fs.readFileSync(owner);
  assert.deepEqual(await readStoreConnections(directory), { schemaVersion: 1, revision: 0, links: [] });
  const productId = crypto.randomUUID();
  const first = await saveStoreConnection(directory, candidate('steam', '440', 'First label'), productId);
  assert.equal(first.revision, 1); assert.equal(first.links.length, 1); assert.equal(first.links[0]!.managedProductId, productId);
  const second = await saveStoreConnection(directory, candidate('steam', '440', 'Updated label'));
  assert.equal(second.revision, 2); assert.equal(second.links.length, 1);
  assert.equal(second.links[0]!.id, first.links[0]!.id); assert.equal(second.links[0]!.createdAt, first.links[0]!.createdAt);
  assert.equal(second.links[0]!.title, 'Updated label'); assert.equal(second.links[0]!.managedProductId, undefined);
  const third = await saveStoreConnection(directory, candidate('gog', 'other_game'));
  assert.equal(third.revision, 3); assert.equal(third.links.length, 2);
  assert.deepEqual(await readStoreConnections(directory), third);
  const removed = await removeStoreConnection(directory, first.links[0]!.id);
  assert.equal(removed.revision, 4); assert.equal(removed.links.length, 1);
  assert.equal(removed.links[0]!.provider, 'gog'); assert.deepEqual(fs.readFileSync(owner), before);
  await assert.rejects(removeStoreConnection(directory, '../outside'), /invalidConnection/);
  await assert.rejects(saveStoreConnection(directory, candidate(), '../game'), /invalidManagedProduct/);
});

test('damaged or linked connection storage remains intact rather than being reset or overwritten', async () => {
  const directory = data('corrupt'), first = await saveStoreConnection(directory, candidate());
  const file = path.join(directory, 'store-connections.json');
  for (const broken of ['{broken', JSON.stringify({ ...first, links: [...first.links, first.links[0]] }),
    JSON.stringify({ ...first, links: [{ ...first.links[0], accessToken: 'must not persist' }] }),
    JSON.stringify({ ...first, revision: -1 }), JSON.stringify({ ...first, links: [{ ...first.links[0], managedProductId: 'arbitrary' }] })]) {
    fs.writeFileSync(file, broken);
    await assert.rejects(readStoreConnections(directory), /connectionsCorrupt/);
    await assert.rejects(saveStoreConnection(directory, candidate('gog', 'other_game')), /connectionsCorrupt/);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  }
  fs.writeFileSync(file, JSON.stringify({ ...first, revision: Number.MAX_SAFE_INTEGER }));
  await assert.rejects(saveStoreConnection(directory, candidate()), /connectionsCorrupt/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, Number.MAX_SAFE_INTEGER);
});

test('atomic replacement failure retains the old page connection and revision', async () => {
  const directory = data('atomic'), first = await saveStoreConnection(directory, candidate());
  const original = fsp.rename;
  fsp.rename = async (from, to) => {
    if (String(to) === path.join(directory, 'store-connections.json')) throw Object.assign(new Error('simulated write denial'), { code: 'EACCES' });
    return original(from, to);
  };
  try { await assert.rejects(saveStoreConnection(directory, candidate('gog', 'another_game')), /simulated write denial/); }
  finally { fsp.rename = original; }
  assert.deepEqual(await readStoreConnections(directory), first);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
});

test('a junction cannot redirect connection reads or writes into another directory', async (context) => {
  const directory = data('outside-store'), target = data('linked-store');
  await saveStoreConnection(directory, candidate());
  const file = path.join(directory, 'store-connections.json'), before = fs.readFileSync(file);
  try { fs.symlinkSync(directory, target, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { context.skip(`Host link privilege unavailable: ${(error as NodeJS.ErrnoException).code}`); return; }
  await assert.rejects(readStoreConnections(target), /connectionsCorrupt/);
  await assert.rejects(saveStoreConnection(target, candidate('gog', 'outside_game')), /connectionsCorrupt/);
  assert.deepEqual(fs.readFileSync(file), before);
});

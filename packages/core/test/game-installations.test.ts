import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadRegistry } from '../src/registry/index.ts';
import { importGameArchive } from '../../desktop/src/game-archives.ts';
import {
  installGameArchiveVersion, listGameInstallations, recoverGameInstallations, setActiveGameInstallation,
  type GameInstallationsCatalog,
} from '../../desktop/src/game-installations.ts';

const registry = loadRegistry(), parent = path.resolve(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(parent, 'indiedeck-installations-'));
after(() => { assert.equal(path.dirname(temporary), parent); fs.rmSync(temporary, { recursive: true, force: true }); });
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function zip(files: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [filename, content] of Object.entries(files)) {
    const name = Buffer.from(filename), data = Buffer.from(content); let checksum = 0xffffffff;
    for (const byte of data) checksum = (checksum >>> 8) ^ crcTable[(checksum ^ byte) & 255]!;
    checksum = (checksum ^ 0xffffffff) >>> 0;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6);
    head.writeUInt32LE(checksum, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    const entry = Buffer.concat([head, name, data]), record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42); local.push(entry); central.push(Buffer.concat([record, name])); offset += entry.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function archive(name: string, version = '1'): string {
  const exe = Buffer.alloc(512); exe.writeUInt16LE(0x5a4d); exe.writeUInt32LE(0x80, 0x3c); exe.writeUInt32LE(0x4550, 0x80); exe.writeUInt16LE(0x8664, 0x84);
  const file = path.join(temporary, `${name}.zip`);
  fs.writeFileSync(file, zip({ 'Game/Game.exe': exe, 'Game/nw.dll': 'fixture', 'Game/package.json': '{"name":"version-game"}',
    'Game/js/rpg_core.js': '//fixture', 'Game/data/System.json': '{"gameTitle":"Version Fixture","locale":"ja_JP"}', 'Game/version.txt': version }));
  return file;
}
function dataDir(name: string): string { return path.join(temporary, name); }
function editCatalog(directory: string, edit: (catalog: GameInstallationsCatalog) => void): GameInstallationsCatalog {
  const filename = path.join(directory, 'game-installations.json'), catalog = JSON.parse(fs.readFileSync(filename, 'utf8')) as GameInstallationsCatalog;
  edit(catalog); fs.writeFileSync(filename, JSON.stringify(catalog)); return catalog;
}
const register = async (): Promise<void> => {};

test('explicit product grouping retains active predecessor, deduplicates and persists version selection', async () => {
  const data = dataDir('versions'), firstSource = archive('Version-v1.0'), secondSource = archive('Version-v2.0', '2');
  const first = await installGameArchiveVersion(firstSource, { dataDir: data, registry, register, label: 'Original 1' });
  assert.equal(first.catalog.products[0]!.activeInstallationId, first.installationId);
  const second = await installGameArchiveVersion(secondSource, { dataDir: data, registry, register, productId: first.productId, label: 'New 2' });
  assert.equal(second.catalog.products.length, 1); assert.equal(second.catalog.installations.length, 2);
  assert.equal(second.catalog.products[0]!.activeInstallationId, first.installationId);
  assert.equal(second.catalog.releases[1]!.versionEvidence, 'user-label');
  assert.ok(fs.existsSync(first.record.gameRoot)); assert.ok(fs.existsSync(firstSource));
  const active = await setActiveGameInstallation(data, second.installationId);
  assert.equal(active.products[0]!.activeInstallationId, second.installationId);
  assert.ok(active.revision > second.catalog.revision);
  assert.equal((await listGameInstallations(data)).products[0]!.activeInstallationId, second.installationId);
  const duplicate = await installGameArchiveVersion(secondSource, { dataDir: data, registry, register, productId: first.productId });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.catalog.installations.length, 2);
  assert.equal(duplicate.installationId, second.installationId);
  const other = await installGameArchiveVersion(archive('OtherEdition', 'other'), { dataDir: data, registry, register });
  await assert.rejects(installGameArchiveVersion(firstSource, { dataDir: data, registry, register, productId: other.productId }), /productConflict/);
  await assert.rejects(installGameArchiveVersion(firstSource, { dataDir: data, registry, register, productId: crypto.randomUUID() }), /invalidProduct/);
  const prior = (await listGameInstallations(data)).products[0]!.activeInstallationId;
  fs.unlinkSync(path.join(first.record.gameRoot, first.record.executable!));
  await assert.rejects(setActiveGameInstallation(data, first.installationId), /installationUnavailable/);
  assert.equal((await listGameInstallations(data)).products[0]!.activeInstallationId, prior);
});

test('published registration failures recover by exact journal ID without source archive and are idempotent', async () => {
  const data = dataDir('recover'), source = archive('Recover-v1.0'); let registrations = 0;
  await assert.rejects(installGameArchiveVersion(source, { dataDir: data, registry,
    register: async () => { throw new Error('simulated library write failure'); } }), /simulated/);
  let catalog = await listGameInstallations(data);
  assert.equal(catalog.jobs[0]!.phase, 'recovery-required'); assert.equal(catalog.products[0]!.activeInstallationId, undefined);
  const installationId = catalog.jobs[0]!.installationId; fs.unlinkSync(source);
  catalog = await recoverGameInstallations({ dataDir: data, registry, register: async (record) => { assert.equal(record.id, installationId); registrations += 1; } });
  assert.equal(catalog.products[0]!.activeInstallationId, installationId); assert.equal(catalog.jobs[0]!.phase, 'activated');
  await recoverGameInstallations({ dataDir: data, registry, register: async () => { registrations += 1; } });
  assert.equal(registrations, 1);
  const next = archive('Recover-v2.0', '2');
  await assert.rejects(installGameArchiveVersion(next, { dataDir: data, registry, productId: catalog.products[0]!.id,
    register: async () => { throw new Error('simulated new registration failure'); } }), /simulated/);
  const recovered = await recoverGameInstallations({ dataDir: data, registry, register });
  assert.equal(recovered.installations.length, 2); assert.equal(recovered.products[0]!.activeInstallationId, installationId);
  assert.equal(recovered.jobs[1]!.phase, 'registered');
});

test('legacy records with matching titles become separate products and adoption is stable', async () => {
  const data = dataDir('legacy');
  await importGameArchive(archive('LegacyA', 'legacy-a'), { dataDir: data, registry });
  await importGameArchive(archive('LegacyB', 'legacy-b'), { dataDir: data, registry });
  assert.equal((await listGameInstallations(data)).products.length, 0);
  const adopted = await recoverGameInstallations({ dataDir: data, registry, register });
  assert.equal(adopted.products.length, 2); assert.equal(adopted.installations.length, 2);
  assert.ok(adopted.products.every((product) => product.activeInstallationId));
  assert.deepEqual(await recoverGameInstallations({ dataDir: data, registry, register }), adopted);
});

test('interrupted prepublish cleanup requires exact UUID marker and original storage device', async () => {
  for (const kind of ['owned', 'foreign', 'volume'] as const) {
    const data = dataDir(`stage-${kind}`), imported = await installGameArchiveVersion(archive(`Stage-${kind}`, kind), { dataDir: data, registry, register });
    const oldActive = imported.installationId, id = crypto.randomUUID(), stage = path.join(data, 'game-versions', `.staging-${id}`);
    fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, '.indiedeck-stage.json'), kind === 'foreign' ? 'not-our-marker' : id);
    fs.writeFileSync(path.join(stage, 'partial-file'), 'never published');
    editCatalog(data, (catalog) => {
      const sourceJob = catalog.jobs[0]!;
      catalog.jobs.push({ ...sourceJob, id: crypto.randomUUID(), installationId: id, phase: 'staging',
        storageDevice: kind === 'volume' ? 'different-volume' : sourceJob.storageDevice });
    });
    const recovered = await recoverGameInstallations({ dataDir: data, registry, register });
    assert.equal(recovered.products[0]!.activeInstallationId, oldActive);
    assert.equal(fs.existsSync(stage), kind !== 'owned');
    assert.equal(recovered.jobs[1]!.phase, kind === 'owned' ? 'failed' : 'recovery-required');
  }
});

test('corrupt and cross-product forged references fail closed without resetting catalog', async () => {
  const data = dataDir('corrupt'), first = await installGameArchiveVersion(archive('Corrupt-v1.0'), { dataDir: data, registry, register });
  const filename = path.join(data, 'game-installations.json'), saved = fs.readFileSync(filename, 'utf8');
  fs.writeFileSync(filename, '{broken');
  await assert.rejects(listGameInstallations(data), /catalogCorrupt/);
  await assert.rejects(recoverGameInstallations({ dataDir: data, registry, register }), /catalogCorrupt/);
  assert.equal(fs.readFileSync(filename, 'utf8'), '{broken'); fs.writeFileSync(filename, saved);
  editCatalog(data, (catalog) => { catalog.products.push({ id: crypto.randomUUID(), title: 'Other', provider: 'local', createdAt: new Date().toISOString(), activeInstallationId: first.installationId }); });
  await assert.rejects(setActiveGameInstallation(data, first.installationId), /catalogCorrupt/);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).products.length, 2);
});

test('failed atomic activation save leaves the old persisted active reference', async () => {
  const data = dataDir('activation-save'), first = await installGameArchiveVersion(archive('Atomic-v1.0'), { dataDir: data, registry, register });
  const second = await installGameArchiveVersion(archive('Atomic-v2.0', '2'), { dataDir: data, registry, register, productId: first.productId });
  const original = fsp.rename;
  fsp.rename = async (from, to) => {
    if (String(to) === path.join(data, 'game-installations.json')) throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' });
    return original(from, to);
  };
  try { await assert.rejects(setActiveGameInstallation(data, second.installationId), /simulated rename/); }
  finally { fsp.rename = original; }
  assert.equal((await listGameInstallations(data)).products[0]!.activeInstallationId, first.installationId);
  assert.ok(fs.existsSync(first.record.root)); assert.ok(fs.existsSync(second.record.root));
});

test('registered checkpoint before initial activation recovers without repeating registration', async () => {
  const data = dataDir('registered-checkpoint'), first = await installGameArchiveVersion(archive('Registered-v1.0'), { dataDir: data, registry, register });
  editCatalog(data, (catalog) => { delete catalog.products[0]!.activeInstallationId; catalog.jobs[0]!.phase = 'registered'; });
  const recovered = await recoverGameInstallations({ dataDir: data, registry,
    register: async () => { throw new Error('registration must not repeat'); } });
  assert.equal(recovered.products[0]!.activeInstallationId, first.installationId);
  assert.equal(recovered.jobs[0]!.phase, 'activated');
});

test('space preflight rejects before extraction and retains installed predecessor', async () => {
  const data = dataDir('space'), first = await installGameArchiveVersion(archive('Space-v1.0'), { dataDir: data, registry, register });
  const original = fsp.statfs;
  fsp.statfs = (async () => ({ bavail: 0n, bsize: 4096n })) as typeof fsp.statfs;
  try {
    await assert.rejects(installGameArchiveVersion(archive('Space-v2.0', '2'), { dataDir: data, registry, register, productId: first.productId }), /insufficientSpace/);
  } finally { fsp.statfs = original; }
  const catalog = await listGameInstallations(data);
  assert.equal(catalog.products[0]!.activeInstallationId, first.installationId);
  assert.equal(catalog.installations.length, 1); assert.ok(fs.existsSync(first.record.gameRoot));
});

test('duplicate selection re-registers a removed library entry and refuses changed storage identity', async () => {
  const data = dataDir('duplicate-register'), source = archive('DuplicateRegister-v1.0'); let registrations = 0;
  const first = await installGameArchiveVersion(source, { dataDir: data, registry, register: async () => { registrations += 1; } });
  const duplicate = await installGameArchiveVersion(source, { dataDir: data, registry, register: async () => { registrations += 1; } });
  assert.equal(duplicate.duplicate, true); assert.equal(registrations, 2);
  await assert.rejects(installGameArchiveVersion(source, { dataDir: data, registry,
    register: async () => { throw new Error('simulated duplicate registration failure'); } }), /simulated duplicate/);
  const failed = await listGameInstallations(data);
  assert.equal(failed.jobs[0]!.phase, 'recovery-required'); assert.equal(failed.products[0]!.activeInstallationId, first.installationId);
  await recoverGameInstallations({ dataDir: data, registry, register });
  editCatalog(data, (catalog) => { catalog.jobs[0]!.storageDevice = 'different-volume'; });
  await assert.rejects(installGameArchiveVersion(source, { dataDir: data, registry, register: async () => { registrations += 1; } }), /storageChanged/);
  assert.equal(registrations, 2); assert.equal((await listGameInstallations(data)).products[0]!.activeInstallationId, first.installationId);
});

test('a published but damaged executable remains recovery-required and is never removed', async () => {
  const data = dataDir('damaged-payload'), source = archive('DamagedPayload-v1.0');
  await assert.rejects(installGameArchiveVersion(source, { dataDir: data, registry,
    register: async () => { throw new Error('simulated registration failure'); } }), /simulated/);
  const catalog = await listGameInstallations(data), installationId = catalog.jobs[0]!.installationId;
  const root = path.join(data, 'game-versions', installationId); fs.unlinkSync(path.join(root, 'Game', 'Game.exe'));
  const recovered = await recoverGameInstallations({ dataDir: data, registry, register });
  assert.equal(recovered.jobs[0]!.phase, 'recovery-required');
  assert.equal(recovered.jobs[0]!.error, 'ui.archives.reason.installationUnavailable');
  assert.ok(fs.existsSync(root)); assert.equal(recovered.products[0]!.activeInstallationId, undefined);
});

test('interrupted stage containing a junction is retained without deleting the linked tree', async (context) => {
  const data = dataDir('linked-stage'), first = await installGameArchiveVersion(archive('LinkedStage-v1.0'), { dataDir: data, registry, register });
  const id = crypto.randomUUID(), stage = path.join(data, 'game-versions', `.staging-${id}`), outside = path.join(temporary, 'stage-link-outside');
  fs.mkdirSync(stage); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(stage, '.indiedeck-stage.json'), id);
  try { fs.symlinkSync(outside, path.join(stage, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { context.skip(`Local link privilege unavailable: ${(error as NodeJS.ErrnoException).code}`); return; }
  editCatalog(data, (catalog) => { catalog.jobs.push({ ...catalog.jobs[0]!, id: crypto.randomUUID(), installationId: id, phase: 'staging' }); });
  const recovered = await recoverGameInstallations({ dataDir: data, registry, register });
  assert.equal(recovered.jobs[1]!.phase, 'recovery-required'); assert.ok(fs.existsSync(stage));
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(recovered.products[0]!.activeInstallationId, first.installationId);
});

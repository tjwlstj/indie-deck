/** Standalone font ownership overlays must never hide pre-existing user edits. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { collectTranslatorEvidence } from '../src/health/index.ts';
import { readReceipts, uninstallReceipt } from '../src/install/apply.ts';
import { loadRegistry } from '../src/registry/index.ts';
import type { GameProfile } from '../src/types.ts';
import { cleanupFixtures, dllWithVersion, fixtureRoot, makeGame, sha256, writeReceiptFile } from './fixtures.ts';

const reg = loadRegistry();
after(() => cleanupFixtures());

const CONFIG = 'BepInEx/config/AutoTranslatorConfig.ini';
const PLUGIN = 'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll';
const FONT = 'arialuni_sdf_u2021';
const BACKUP = `.indiedeck/backups/font-overlay/${CONFIG}`;
const TRANSLATOR_RECEIPT = '.indiedeck/receipts/translator-xunity-autotranslator.json';
const FONT_RECEIPT = `.indiedeck/receipts/font-${FONT}.json`;
const ORIGINAL_CONFIG = '[Language]\nLanguage=ko\n[Service]\nEndpoint=GoogleTranslate\n[Behaviour]\n';
const FONT_CONFIG = `${ORIGINAL_CONFIG}FallbackFontTextMeshPro=${FONT}\n`;

function profile(root: string): GameProfile {
  return {
    path: root,
    name: path.basename(root),
    engineId: 'unity',
    engineName: 'Unity',
    confidence: 100,
    alternatives: [],
    arch: 'x64',
    captures: {},
    installedLoaders: [{ loaderId: 'bepinex5', markers: ['winhttp.dll'] }],
    installedTranslators: [],
    installedFontBundles: [FONT],
    notes: [],
    scannedAt: new Date().toISOString(),
    unity: { backend: 'mono', version: '2021.3.16f1' },
  };
}

function overlayGame(name: string, predecessor = ORIGINAL_CONFIG, createFont = true): string {
  const root = makeGame(name, {
    'Game.exe': Buffer.alloc(16),
    'UnityPlayer.dll': 'fixture',
    [PLUGIN]: dllWithVersion('5.6.1'),
    [CONFIG]: FONT_CONFIG,
    [BACKUP]: predecessor,
    [FONT]: 'fixture font bundle',
  });
  writeReceiptFile(root, {
    version: '5.6.1',
    variantId: 'bepinex',
    entries: [
      { path: PLUGIN, operation: 'create', sha256: sha256(fs.readFileSync(path.join(root, PLUGIN))) },
      { path: CONFIG, operation: 'create', sha256: sha256(ORIGINAL_CONFIG) },
    ],
  });
  writeReceiptFile(root, {
    kind: 'font',
    componentId: FONT,
    version: '5.5.0',
    variantId: 'bepinex',
    entries: [
      ...(createFont ? [{ path: FONT, operation: 'create' as const, sha256: sha256('fixture font bundle') }] : []),
      { path: CONFIG, operation: 'modify', sha256: sha256(FONT_CONFIG), backup: BACKUP },
    ],
  });
  return root;
}

function evidence(root: string) {
  const found = collectTranslatorEvidence(reg, profile(root), { targetLanguage: 'ko' });
  assert.equal(found.length, 1);
  return found[0]!;
}

function expectDrift(root: string) {
  const found = evidence(root);
  assert.ok(found.healthIssues.includes('managed-drift'));
  assert.ok(found.modifiedOwnedPaths.includes(CONFIG));
  assert.equal(found.uninstallable, false);
}

function editReceipt(root: string, mutate: (receipt: Record<string, unknown>) => void, relative = FONT_RECEIPT): void {
  const target = path.join(root, relative);
  const receipt = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
  mutate(receipt);
  fs.writeFileSync(target, JSON.stringify(receipt), 'utf8');
}

test('an intact standalone font overlay is healthy without rewriting the translator receipt', () => {
  const root = overlayGame('font-health-normal');
  const receiptBefore = fs.readFileSync(path.join(root, TRANSLATOR_RECEIPT));
  const found = evidence(root);
  assert.deepEqual(found.modifiedOwnedPaths, []);
  assert.equal(found.primaryStatus, 'healthy');
  assert.equal(found.uninstallable, true);
  assert.deepEqual(fs.readFileSync(path.join(root, TRANSLATOR_RECEIPT)), receiptBefore);
});

test('a config-only font receipt can reuse an existing unowned bundle', () => {
  const root = overlayGame('font-health-existing-bundle', ORIGINAL_CONFIG, false);
  assert.deepEqual(evidence(root).modifiedOwnedPaths, []);
});

test('removing the font before its translator restores the ownership predecessor safely', async () => {
  const root = overlayGame('font-health-removal-order');
  const receipts = await readReceipts(root);
  const font = receipts.find((receipt) => receipt.kind === 'font');
  const translator = receipts.find((receipt) => receipt.kind === 'translator');
  assert.ok(font);
  assert.ok(translator);
  await uninstallReceipt(font);
  assert.equal(fs.readFileSync(path.join(root, CONFIG), 'utf8'), ORIGINAL_CONFIG);
  assert.equal(fs.existsSync(path.join(root, FONT)), false);
  assert.deepEqual(evidence(root).modifiedOwnedPaths, []);
  await uninstallReceipt(translator);
  assert.equal(fs.existsSync(path.join(root, CONFIG)), false);
  assert.equal(fs.existsSync(path.join(root, PLUGIN)), false);
  assert.equal(fs.existsSync(path.join(root, 'Game.exe')), true);
});

test('a font predecessor containing user edits does not hide translator drift', () => {
  const root = overlayGame('font-health-user-predecessor', `${ORIGINAL_CONFIG}# user setting\n`);
  expectDrift(root);
});

test('later config edits are still drift even when the predecessor matched', () => {
  const root = overlayGame('font-health-config-drift');
  fs.appendFileSync(path.join(root, CONFIG), '# edited after font install\n');
  expectDrift(root);
});

test('a modified owned font bundle invalidates the overlay', () => {
  const root = overlayGame('font-health-font-drift');
  fs.writeFileSync(path.join(root, FONT), 'changed font bundle');
  expectDrift(root);
});

test('multiple font receipts never form an implicitly trusted chain', () => {
  const root = overlayGame('font-health-multiple');
  writeReceiptFile(root, {
    kind: 'font', componentId: 'another-font', version: '5.5.0',
    entries: [{ path: CONFIG, operation: 'modify', sha256: sha256(FONT_CONFIG), backup: BACKUP }],
  });
  expectDrift(root);
});

test('noncanonical font storage and duplicated entries are rejected', () => {
  const renamed = overlayGame('font-health-noncanonical');
  fs.renameSync(path.join(renamed, FONT_RECEIPT), path.join(renamed, '.indiedeck/receipts/font-renamed.json'));
  expectDrift(renamed);

  const duplicate = overlayGame('font-health-duplicate-entry');
  editReceipt(duplicate, (raw) => {
    const entries = raw['entries'] as unknown[];
    entries.push(entries.at(-1));
  });
  expectDrift(duplicate);
});

test('unsafe backup paths, malformed hashes, and malformed metadata are not trusted', () => {
  const cases: [string, (raw: Record<string, unknown>) => void][] = [
    ['outside-backups', (raw) => { (raw['entries'] as Record<string, unknown>[]).at(-1)!['backup'] = CONFIG; }],
    ['parent-backup', (raw) => { (raw['entries'] as Record<string, unknown>[]).at(-1)!['backup'] = '../external.ini'; }],
    ['metadata-path', (raw) => { (raw['entries'] as Record<string, unknown>[]).at(-1)!['path'] = '.indiedeck/receipts/fake.json'; }],
    ['hash', (raw) => { (raw['entries'] as Record<string, unknown>[]).at(-1)!['sha256'] = 'not-a-sha'; }],
    ['schema', (raw) => { raw['schemaVersion'] = 1; }],
    ['game-root', (raw) => { raw['gamePath'] = fixtureRoot(); }],
    ['unsafe-id', (raw) => { raw['componentId'] = '../font'; }],
    ['missing-time', (raw) => { delete raw['installedAt']; }],
    ['invalid-time', (raw) => { raw['installedAt'] = 'not a timestamp'; }],
    ['old-time', (raw) => { raw['installedAt'] = '2000-01-01T00:00:00.000Z'; }],
  ];
  for (const [name, mutate] of cases) {
    const root = overlayGame(`font-health-invalid-${name}`);
    editReceipt(root, mutate);
    expectDrift(root);
  }
});

test('a font receipt cannot mask payload DLL drift by claiming a matching backup', () => {
  const root = overlayGame('font-health-payload-overlay');
  const oldDll = fs.readFileSync(path.join(root, PLUGIN));
  const newDll = Buffer.concat([oldDll, Buffer.from('new payload')]);
  const backup = '.indiedeck/backups/font-overlay/plugin.dll';
  fs.writeFileSync(path.join(root, PLUGIN), newDll);
  fs.writeFileSync(path.join(root, backup), oldDll);
  editReceipt(root, (raw) => {
    raw['entries'] = [{ path: PLUGIN, operation: 'modify', sha256: sha256(newDll), backup }];
  });
  const found = evidence(root);
  assert.ok(found.modifiedOwnedPaths.includes(PLUGIN));
  assert.ok(found.modifiedOwnedPaths.includes(CONFIG));
});

function linkDirectory(t: TestContext, root: string, relative: string, label: string): boolean {
  const destination = path.join(root, relative);
  const external = path.join(fixtureRoot(), `${path.basename(root)}-${label}`);
  fs.renameSync(destination, external);
  try {
    fs.symlinkSync(external, destination, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    fs.renameSync(external, destination);
    t.skip(`Cannot create a directory link on this host: ${(error as Error).message}`);
    return false;
  }
}

test('a linked config directory is never accepted as a legitimate overlay', (t) => {
  const root = overlayGame('font-health-config-link');
  if (!linkDirectory(t, root, 'BepInEx/config', 'external-config')) return;
  expectDrift(root);
});

test('a linked backup directory is never accepted as a legitimate overlay', (t) => {
  const root = overlayGame('font-health-backup-link');
  if (!linkDirectory(t, root, '.indiedeck/backups/font-overlay', 'external-backup')) return;
  expectDrift(root);
});

test('a linked receipts directory does not become trusted ownership evidence', (t) => {
  const root = overlayGame('font-health-receipt-directory-link');
  if (!linkDirectory(t, root, '.indiedeck/receipts', 'external-receipts')) return;
  const found = evidence(root);
  assert.ok(found.healthIssues.includes('corrupt-receipt'));
  assert.ok(found.receiptIssues.some((issue) => issue.code === 'unsafe-storage-id'));
  assert.equal(found.uninstallable, false);
});

test('a linked font receipt cannot mask the config change', (t) => {
  const root = overlayGame('font-health-font-receipt-link');
  const destination = path.join(root, FONT_RECEIPT);
  const external = path.join(fixtureRoot(), 'font-health-external-receipt.json');
  fs.renameSync(destination, external);
  try {
    fs.symlinkSync(external, destination, 'file');
  } catch (error) {
    fs.renameSync(external, destination);
    t.skip(`Cannot create a file link on this host: ${(error as Error).message}`);
    return;
  }
  expectDrift(root);
});

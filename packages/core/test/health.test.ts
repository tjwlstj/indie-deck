/**
 * §13.3 installation-health fixtures.
 *
 * Every scenario builds a real fake game folder through the shared fixture
 * module, so the evidence collector sees actual files, actual DLL version
 * resources and actual receipt JSON - not synthetic profiles.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { auditGame } from '../src/audit/index.ts';
import { collectTranslatorEvidence } from '../src/health/index.ts';
import { loadRegistry } from '../src/registry/index.ts';
import type { GameProfile } from '../src/types.ts';
import { cleanupFixtures, dllWithVersion, makeGame, sha256, writeReceiptFile } from './fixtures.ts';

const reg = loadRegistry();
after(() => cleanupFixtures());

const PLUGIN_DLL = 'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll';
const COMMON_DLL = 'BepInEx/core/XUnity.Common.dll';

function monoGame(root: string, overrides: Partial<GameProfile> = {}): GameProfile {
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
    installedFontBundles: [],
    notes: [],
    scannedAt: new Date().toISOString(),
    unity: { backend: 'mono', version: '2021.3.16f1' },
    ...overrides,
  };
}

function xunityFiles(version: string): Record<string, string | Buffer> {
  return {
    'Game.exe': Buffer.alloc(16),
    'UnityPlayer.dll': 'stub',
    'Game_Data/Managed/Assembly-CSharp.dll': 'stub',
    [COMMON_DLL]: dllWithVersion(version),
    [PLUGIN_DLL]: dllWithVersion(version),
    'BepInEx/config/AutoTranslatorConfig.ini': '[Service]\nEndpoint=GoogleTranslate\n',
  };
}

function evidence(root: string, overrides: Partial<GameProfile> = {}) {
  const found = collectTranslatorEvidence(reg, monoGame(root, overrides));
  assert.equal(found.length, 1, 'exactly one translator should have traces');
  return found[0]!;
}

test('an untouched folder yields no evidence', () => {
  const root = makeGame('health-absent', {});
  assert.deepEqual(collectTranslatorEvidence(reg, monoGame(root)), []);
});

test('receipt matching DLL versions is healthy and uninstallable', () => {
  const root = makeGame('health-healthy', xunityFiles('5.6.1'));
  writeReceiptFile(root, {
    version: '5.6.1',
    variantId: 'bepinex',
    entries: [
      { path: PLUGIN_DLL, operation: 'create', sha256: sha256(fs.readFileSync(path.join(root, PLUGIN_DLL))) },
      { path: COMMON_DLL, operation: 'create', sha256: sha256(fs.readFileSync(path.join(root, COMMON_DLL))) },
    ],
  });

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'healthy');
  assert.deepEqual(ev.healthIssues, [], "an absence of issues IS the healthy state");
  assert.equal(ev.ownership, 'managed');
  assert.equal(ev.uninstallable, true);
  assert.deepEqual(ev.modifiedOwnedPaths, []);
  assert.ok(ev.assemblyVersions.some((a) => a.version === '5.6.1'));
});

test('a compatible older managed install reports update-available against this game', () => {
  const root = makeGame('health-update', xunityFiles('5.5.2'));
  writeReceiptFile(root, { version: '5.5.2', variantId: 'bepinex', entries: [] });

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'update-available');
  assert.ok(ev.healthIssues.includes('update-available'));
});

test('a manual install without a receipt is unmanaged', () => {
  const root = makeGame('health-unmanaged-current', xunityFiles('5.6.1'));

  const ev = evidence(root);
  assert.ok(ev.healthIssues.includes('unmanaged'));
  assert.equal(ev.ownership, 'observed');
  assert.equal(ev.uninstallable, false);
});

test('a manual old install leads with update-available and keeps unmanaged as an issue', () => {
  const root = makeGame('health-unmanaged-old', xunityFiles('5.4.4'));

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'update-available');
  assert.ok(ev.healthIssues.includes('unmanaged'));
});

test('receipt and DLL version disagreement is managed-drift, not silent trust', () => {
  const root = makeGame('health-drift', xunityFiles('5.4.2'));
  writeReceiptFile(root, { version: '5.6.1', variantId: 'bepinex', entries: [] });

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'managed-drift');
  assert.ok(ev.receipts[0]?.version === '5.6.1');
});

test('payloads from two loader families are duplicate-variants', () => {
  const root = makeGame('health-duplicate', {
    ...xunityFiles('5.6.1'),
    'Mods/XUnity.AutoTranslator.Plugin.MelonMod.dll': dllWithVersion('5.6.1'),
    'UserLibs/XUnity.Common.dll': dllWithVersion('5.6.1'),
  });

  const ev = evidence(root, {
    installedLoaders: [
      { loaderId: 'bepinex5', markers: ['winhttp.dll'] },
      { loaderId: 'melonloader', markers: ['Mods'] },
    ],
  });
  assert.equal(ev.primaryStatus, 'duplicate-variants');
  assert.deepEqual(
    ev.variantHits.filter((h) => h.paths.length > 0).map((h) => h.variantId).sort(),
    ['bepinex', 'melonmod'],
  );
});

test('two DLL versions on disk report multiple-versions', () => {
  const root = makeGame('health-multi-version', {
    ...xunityFiles('5.6.1'),
    // XUnity.Common shipping an older line than the plugin is a classic
    // half-updated folder.
  });
  fs.writeFileSync(path.join(root, COMMON_DLL), dllWithVersion('5.4.0'));

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'multiple-versions');
  assert.deepEqual([...new Set(ev.assemblyVersions.map((a) => a.version))].sort(), ['5.4.0', '5.6.1']);
});

test('payload without any loader is orphaned', () => {
  const root = makeGame('health-orphaned', {
    'Mods/XUnity.AutoTranslator.Plugin.MelonMod.dll': dllWithVersion('5.6.1'),
    'UserLibs/XUnity.Common.dll': dllWithVersion('5.6.1'),
  });

  const ev = evidence(root, { installedLoaders: [] });
  assert.equal(ev.primaryStatus, 'orphaned');
});

test('unreadable versions leave the install version-unknown', () => {
  const root = makeGame('health-unknown', {
    [PLUGIN_DLL]: 'not a pe with versions',
    [COMMON_DLL]: 'also nothing readable',
    'BepInEx/config/AutoTranslatorConfig.ini': '[Service]\n',
  });

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'version-unknown');
});

test('a version newer than the registry is kept, never downgraded', () => {
  const root = makeGame('health-newer', xunityFiles('9.9.9'));

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'newer-than-registry');
});

test('hand edits to owned files surface as modifiedOwnedPaths and drift', () => {
  const root = makeGame('health-hand-edit', xunityFiles('5.6.1'));
  const iniRel = 'BepInEx/config/AutoTranslatorConfig.ini';
  const original = fs.readFileSync(path.join(root, iniRel));

  writeReceiptFile(root, {
    version: '5.6.1',
    variantId: 'bepinex',
    entries: [
      { path: PLUGIN_DLL, operation: 'create', sha256: sha256(fs.readFileSync(path.join(root, PLUGIN_DLL))) },
      { path: iniRel, operation: 'create', sha256: sha256(original) },
    ],
  });
  fs.writeFileSync(path.join(root, iniRel), '# user tweaked me\n');

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'managed-drift');
  assert.deepEqual(ev.modifiedOwnedPaths, [iniRel]);
  assert.equal(ev.uninstallable, false);
});

test('a damaged receipt is preserved as evidence and blocks automation', () => {
  const root = makeGame('health-corrupt', xunityFiles('5.6.1'));
  const receipts = path.join(root, '.indiedeck', 'receipts');
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(receipts, 'translator-xunity-autotranslator.json'), '{ not json at all');

  const ev = evidence(root);
  assert.equal(ev.primaryStatus, 'corrupt-receipt');
  assert.equal(ev.receiptIssues[0]?.code, 'parse-error');
  assert.deepEqual(ev.receipts, []);

  const codes = auditGame(reg, monoGame(root)).issues.map((i) => i.code);
  assert.ok(codes.includes('translator-receipt-corrupt'));
});

test('audit surfaces evidence-driven codes without duplicating legacy ones', () => {
  const root = makeGame('health-audit-mixed', xunityFiles('5.4.2'));
  writeReceiptFile(root, { version: '5.6.1', variantId: 'bepinex', entries: [] });
  writeReceiptFile(root, { kind: 'loader', componentId: 'bepinex5', version: '5.4.23.5', entries: [] });

  const issues = auditGame(reg, monoGame(root)).issues;
  const codes = issues.map((i) => i.code);

  assert.ok(codes.includes('translator-managed-drift'));
  assert.ok(codes.includes('translator-outdated'));
  // exactly one outdated-style finding even though both legacy and evidence
  // paths could have produced one
  assert.equal(codes.filter((c) => c === 'translator-outdated').length, 1);
});

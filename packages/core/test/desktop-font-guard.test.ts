import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { readGameConfig, type ConfigSchema, type GameConfig } from '../src/config/index.ts';
import { collectTranslatorEvidence, readReceiptEvidence } from '../src/health/index.ts';
import { loadRegistry } from '../src/registry/index.ts';
import { resolveFontPlan, resolvePlans, summarisePlans } from '../src/resolve/index.ts';
import type { GameProfile, TranslatorPlan } from '../src/types.ts';
import { fontWriteBlockKey } from '../../desktop/src/font-guard.ts';
import { cleanupFixtures, dllWithVersion, fakeExe, fixtureRoot, makeGame, sha256, writeReceiptFile } from './fixtures.ts';

const reg = loadRegistry();
const schemas = reg.configSchemas as Map<string, ConfigSchema>;
const CONFIG = 'BepInEx/config/AutoTranslatorConfig.ini';
const PLUGIN = 'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll';
const COMMON = 'BepInEx/core/XUnity.Common.dll';
const FONT = 'arialuni_sdf_u2021';
const ORIGINAL_CONFIG = '[Service]\nEndpoint=GoogleTranslate\n[General]\nLanguage=ko\nFromLanguage=ja\n[Behaviour]\nFallbackFontTextMeshPro=\n[Unknown]\nUserValue=keep-me\n';

after(() => cleanupFixtures());

function game(name: string, fontPresent = false): GameProfile {
  const root = makeGame(`font-guard-${name}`, {
    'Game.exe': fakeExe(0x8664),
    'UnityPlayer.dll': 'isolated fixture',
    'Game_Data/Managed/Assembly-CSharp.dll': 'isolated fixture',
    [PLUGIN]: dllWithVersion('5.6.1'),
    [COMMON]: dllWithVersion('5.6.1'),
    [CONFIG]: ORIGINAL_CONFIG,
    ...(fontPresent ? { [FONT]: 'external existing atlas fixture' } : {}),
  });
  return {
    path: root, name, engineId: 'unity', engineName: 'Unity', confidence: 100,
    alternatives: [], executable: 'Game.exe', arch: 'x64', captures: {},
    unity: { backend: 'mono', version: '2021.3.16f1', usesTextMeshPro: true },
    installedLoaders: [{ loaderId: 'bepinex5', version: '5.4.23.5', markers: ['BepInEx/core/BepInEx.dll'] }],
    installedTranslators: [{ translatorId: 'xunity-autotranslator', variantId: 'bepinex', version: '5.6.1', configPath: CONFIG, markers: [PLUGIN] }],
    installedFontBundles: fontPresent ? [FONT] : [], notes: [], scannedAt: new Date(0).toISOString(),
  };
}

async function context(profile: GameProfile) {
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');
  const fallback = config.values.find((value) => value.id === 'xunity.fallbackFontTextMeshPro')?.value;
  const plan = resolveFontPlan(reg, profile, { targetLanguage: 'ko', currentFallbackFontTextMeshPro: fallback });
  assert.ok(plan, 'fixture must produce an eligible standalone font plan before desktop safety gates');
  return { plan, config };
}

function block(profile: GameProfile, plan: TranslatorPlan, config?: GameConfig) {
  return fontWriteBlockKey(profile, plan, readReceiptEvidence(profile.path), collectTranslatorEvidence(reg, profile), config);
}

function ownTranslator(profile: GameProfile, paths: string[] = [PLUGIN, COMMON, CONFIG]) {
  writeReceiptFile(profile.path, {
    version: '5.6.1', variantId: 'bepinex',
    entries: paths.map((relative) => ({ path: relative, operation: 'create', sha256: sha256(fs.readFileSync(path.join(profile.path, relative))) })),
  });
}

function junction(target: string, link: string, ctx: TestContext): boolean {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      ctx.skip('this host does not permit isolated symlink/junction fixtures');
      return false;
    }
    throw error;
  }
}

test('a compatible installed translator with a confirmed existing config permits a narrow standalone font plan', async () => {
  const profile = game('healthy');
  const { plan, config } = await context(profile);
  assert.equal(config.location.exists, true);
  assert.equal(config.detected.source, 'assembly');
  assert.equal(config.values.find((value) => value.id === 'xunity.fallbackFontTextMeshPro')?.assumed, false);
  assert.deepEqual(plan.steps.map((step) => step.action), ['download', 'copy', 'config']);
  assert.equal(await block(profile, plan, config), undefined);
  assert.equal(fs.readFileSync(path.join(profile.path, CONFIG), 'utf8'), ORIGINAL_CONFIG, 'the guard never writes settings');
});

test('a same-name external atlas blocks bundled copying but permits standalone fallback linking without overwriting it', async () => {
  const profile = game('existing-atlas', true);
  const initial = summarisePlans(resolvePlans(reg, { ...profile, installedTranslators: [] }, { targetLanguage: 'ko' })).find((plan) => plan.viable)!;
  assert.ok(initial.steps.some((step) => step.action === 'copy'));
  assert.equal(await block(profile, initial), 'existingFont');

  const { plan, config } = await context(profile);
  assert.deepEqual(plan.steps.map((step) => step.action), ['config']);
  assert.equal(await block(profile, plan, config), undefined);
  assert.equal(fs.readFileSync(path.join(profile.path, FONT), 'utf8'), 'external existing atlas fixture');
});

test('equivalent four-part DLL and three-part receipt versions permit font maintenance', async () => {
  const profile = game('four-part-version');
  fs.writeFileSync(path.join(profile.path, PLUGIN), dllWithVersion('5.6.1.0'));
  fs.writeFileSync(path.join(profile.path, COMMON), dllWithVersion('5.6.1.0'));
  profile.installedTranslators[0]!.version = '5.6.1.0';
  ownTranslator(profile);
  const { plan, config } = await context(profile);
  assert.equal(await block(profile, plan, config), undefined);
});

test('a missing first-run config is not permission to patch an assumed destination', async () => {
  const profile = game('missing-config');
  fs.unlinkSync(path.join(profile.path, CONFIG));
  const { plan, config } = await context(profile);
  assert.equal(config.location.exists, false);
  assert.equal(await block(profile, plan, config), 'config');
  assert.equal(fs.existsSync(path.join(profile.path, CONFIG)), false);
});

test('assumed or mismatched fallback mapping, translator, variant and path are all blocked', async () => {
  const profile = game('mapping');
  const { plan, config } = await context(profile);
  const variants: GameConfig[] = [
    { ...config, translatorId: 'another-translator' },
    { ...config, location: { ...config.location, variant: 'melonmod' } },
    { ...config, location: { ...config.location, path: 'another.ini' } },
    { ...config, values: config.values.filter((value) => value.id !== 'xunity.fallbackFontTextMeshPro') },
    ...[
      { assumed: true }, { section: 'UnknownSection' }, { key: 'OverrideFontTextMeshPro' },
    ].map((change) => ({
      ...config,
      values: config.values.map((value) => value.id === 'xunity.fallbackFontTextMeshPro' ? { ...value, ...change } : value),
    })),
  ];
  for (const invalid of variants) assert.equal(await block(profile, plan, invalid), 'config');
  assert.equal(await block(profile, plan), 'config');
});

test('damaged receipt bytes block font changes and remain preserved for review', async () => {
  const profile = game('corrupt-receipt');
  const { plan, config } = await context(profile);
  const receipt = path.join(profile.path, '.indiedeck/receipts/translator-xunity-autotranslator.json');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, '{ invalid receipt fixture');
  assert.ok(readReceiptEvidence(profile.path).issues.length > 0);
  assert.equal(await block(profile, plan, config), 'receipt');
  assert.equal(fs.readFileSync(receipt, 'utf8'), '{ invalid receipt fixture');
});

test('an existing valid managed font receipt blocks unsafe repeat font maintenance', async () => {
  const profile = game('managed-font');
  const { plan, config } = await context(profile);
  writeReceiptFile(profile.path, { kind: 'font', componentId: FONT, version: 'TMP_Font_AssetBundles', entries: [] });
  assert.equal(readReceiptEvidence(profile.path).issues.length, 0);
  assert.equal(await block(profile, plan, config), 'managedFont');
});

test('user edits to translator payloads block font writes even when the DLL reports the same version', async () => {
  const profile = game('payload-edit');
  ownTranslator(profile);
  fs.appendFileSync(path.join(profile.path, PLUGIN), Buffer.from('modified payload fixture'));
  const { plan, config } = await context(profile);
  const evidence = collectTranslatorEvidence(reg, profile)[0]!;
  assert.ok(evidence.modifiedOwnedPaths.includes(PLUGIN));
  assert.ok(evidence.healthIssues.includes('managed-drift'));
  assert.equal(await block(profile, plan, config), 'payload');
});

test('a valid user config-only edit is preserved and does not block the narrow fallback patch', async () => {
  const profile = game('config-edit');
  ownTranslator(profile);
  const custom = ORIGINAL_CONFIG.replace('UserValue=keep-me', 'UserValue=my-own-value');
  fs.writeFileSync(path.join(profile.path, CONFIG), custom);
  const { plan, config } = await context(profile);
  const evidence = collectTranslatorEvidence(reg, profile)[0]!;
  assert.deepEqual(evidence.modifiedOwnedPaths, [CONFIG]);
  assert.ok(evidence.healthIssues.includes('managed-drift'));
  assert.equal(await block(profile, plan, config), undefined);
  assert.equal(fs.readFileSync(path.join(profile.path, CONFIG), 'utf8'), custom);
});

test('version disagreement with an otherwise valid translator receipt blocks font writes', async () => {
  const profile = game('version-drift');
  writeReceiptFile(profile.path, { version: '5.5.2', variantId: 'bepinex', entries: [] });
  const { plan, config } = await context(profile);
  assert.ok(collectTranslatorEvidence(reg, profile)[0]!.healthIssues.includes('managed-drift'));
  assert.equal(await block(profile, plan, config), 'payload');
});

test('a second translator payload family blocks a standalone font plan', async () => {
  const profile = game('duplicate');
  fs.mkdirSync(path.join(profile.path, 'Mods'), { recursive: true });
  fs.writeFileSync(path.join(profile.path, 'Mods/XUnity.AutoTranslator.Plugin.MelonMod.dll'), dllWithVersion('5.6.1'));
  const { plan, config } = await context(profile);
  assert.ok(collectTranslatorEvidence(reg, profile)[0]!.healthIssues.includes('duplicate-variants'));
  assert.equal(await block(profile, plan, config), 'payload');
});

test('a linked atlas destination is blocked without touching its target', async (ctx) => {
  const profile = game('font-junction');
  const { plan, config } = await context(profile);
  const outside = makeGame('font-guard-font-target', { 'sentinel.txt': 'keep external fixture' });
  if (!junction(outside, path.join(profile.path, FONT), ctx)) return;
  assert.equal(await block(profile, plan, config), 'linkedPath');
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep external fixture');
});

test('a config ancestor junction is blocked even when the regular config target exists', async (ctx) => {
  const profile = game('config-junction');
  const { plan, config } = await context(profile);
  const configDir = path.join(profile.path, 'BepInEx/config');
  const outside = path.join(fixtureRoot(), 'font-guard-config-target');
  fs.renameSync(configDir, outside);
  if (!junction(outside, configDir, ctx)) return;
  assert.equal(await block(profile, plan, config), 'linkedPath');
  assert.equal(fs.readFileSync(path.join(outside, 'AutoTranslatorConfig.ini'), 'utf8'), ORIGINAL_CONFIG);
});

test('linked receipt metadata is rejected even if its contents are otherwise valid', async (ctx) => {
  const profile = game('metadata-junction');
  const { plan, config } = await context(profile);
  const outside = makeGame('font-guard-metadata-target', { 'sentinel.txt': 'keep metadata target' });
  if (!junction(outside, path.join(profile.path, '.indiedeck'), ctx)) return;
  assert.equal(await block(profile, plan, config), 'receipt');
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep metadata target');
});

test('a linked backup directory is blocked even with no active receipt', async (ctx) => {
  const profile = game('backup-junction');
  const { plan, config } = await context(profile);
  const outside = makeGame('font-guard-backup-target', { 'sentinel.txt': 'keep backup target' });
  if (!junction(outside, path.join(profile.path, '.indiedeck/backups'), ctx)) return;
  assert.equal(await block(profile, plan, config), 'linkedPath');
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep backup target');
});

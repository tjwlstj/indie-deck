import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { applyPlan, readReceipts, uninstallReceipt } from '../src/install/apply.ts';
import { downloadAsset } from '../src/install/download.ts';
import { loadRegistry } from '../src/registry/index.ts';
import { recommendGameFont, resolveFontPlan, resolvePlans, summarisePlans } from '../src/resolve/index.ts';
import type { GameProfile, Registry } from '../src/types.ts';
import { parseIni } from '../src/util/ini.ts';

const reg = loadRegistry();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-fonts-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function unityGame(overrides: Partial<GameProfile> = {}): GameProfile {
  return {
    path: 'C:/games/FontTest',
    name: 'FontTest',
    engineId: 'unity',
    engineName: 'Unity',
    confidence: 100,
    alternatives: [],
    executable: 'FontTest.exe',
    arch: 'x64',
    captures: {},
    unity: { backend: 'mono', version: '2021.3.16f1', usesTextMeshPro: true },
    installedLoaders: [{ loaderId: 'bepinex5', version: '5.4.23.5', markers: ['BepInEx/core/BepInEx.dll'] }],
    installedTranslators: [{ translatorId: 'xunity-autotranslator', variantId: 'bepinex', version: '5.6.1', configPath: 'BepInEx/config/AutoTranslatorConfig.ini', markers: ['BepInEx/plugins/XUnity.AutoTranslator'] }],
    installedFontBundles: [],
    notes: [],
    scannedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

async function gameRoot(name: string, fontPresent = false): Promise<GameProfile> {
  const root = path.join(tmp, name);
  const configPath = path.join(root, 'BepInEx/config/AutoTranslatorConfig.ini');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, ORIGINAL_CONFIG);
  if (fontPresent) await fsp.writeFile(path.join(root, 'arialuni_sdf_u2021'), 'original external font');
  return unityGame({ path: root, installedFontBundles: fontPresent ? ['arialuni_sdf_u2021'] : [] });
}

const ORIGINAL_CONFIG = [
  '; retain user comments',
  '[Service]',
  'Endpoint=CustomEndpoint ; keep this provider',
  '[General]',
  'Language=ko',
  'FromLanguage=en',
  '[Behaviour]',
  'FallbackFontTextMeshPro= ; preserve inline comment',
  'OverrideFontTextMeshPro=MyExistingOverride',
  '[Unknown]',
  'UserValue=keep-me',
].join('\r\n');

test('the initial translator font recommendation is optional without losing translator steps', () => {
  const game = unityGame({ installedTranslators: [] });
  const withFont = summarisePlans(resolvePlans(reg, game, { targetLanguage: 'ko' })).find((item) => item.viable)!;
  const withoutFont = summarisePlans(resolvePlans(reg, game, { targetLanguage: 'ko', includeFont: false })).find((item) => item.viable)!;
  assert.equal(withFont.fontBundle?.file, 'arialuni_sdf_u2021');
  assert.equal(withoutFont.fontBundle, undefined);
  assert.equal(withoutFont.config['Behaviour']?.['FallbackFontTextMeshPro'], undefined);
  assert.ok(withoutFont.steps.some((item) => item.action === 'extract'));
  assert.equal(withoutFont.steps.some((item) => item.details?.['fontBundleId']), false);
  assert.equal(withoutFont.findings.some((item) => item.ruleId === 'font-bundle-unresolved'), false, 'opt-out is not an unresolved-version warning');
});

test('font recommendation derives its archive source and retains inferred compatibility', () => {
  const game = unityGame({ unity: { backend: 'mono', version: '2020.3.14f1', usesTextMeshPro: true } });
  const recommendation = recommendGameFont(reg, game, { targetLanguage: 'ko' });
  assert.equal(recommendation.status, 'recommended');
  assert.equal(recommendation.bundle?.id, 'arialuni_sdf_u2019');
  assert.equal(recommendation.bundle?.confidence, 'inferred');
  assert.equal(recommendation.sourceUrl, 'https://github.com/bbepis/XUnity.AutoTranslator/releases/tag/v5.5.0');
  assert.equal(resolveFontPlan(reg, game, { targetLanguage: 'ko' })?.findings[0]?.confidence, 'inferred');
});

test('font plans are unavailable for non-TMP, unknown TMP, unknown Unity, or a Latin target', () => {
  for (const [unity, status] of [
    [{ backend: 'mono', version: '2021.3.16f1', usesTextMeshPro: false }, 'not-needed'],
    [{ backend: 'mono', version: '2021.3.16f1' }, 'unavailable'],
    [{ backend: 'mono', usesTextMeshPro: true }, 'unavailable'],
    [{ backend: 'mono', version: '4.7.0', usesTextMeshPro: true }, 'unavailable'],
  ] as const) {
    const game = unityGame({ unity });
    assert.equal(recommendGameFont(reg, game, { targetLanguage: 'ko' }).status, status);
    assert.equal(resolveFontPlan(reg, game, { targetLanguage: 'ko' }), undefined);
  }
  assert.equal(recommendGameFont(reg, unityGame(), { targetLanguage: 'en' }).status, 'not-needed');
  assert.equal(recommendGameFont(reg, unityGame({ engineId: 'godot' }), { targetLanguage: 'ko' }).status, 'not-needed');
});

test('a standalone font requires one compatible installed translator and an existing loader', () => {
  const normal = unityGame();
  for (const game of [
    unityGame({ installedTranslators: [] }),
    unityGame({ installedTranslators: [...normal.installedTranslators, ...normal.installedTranslators] }),
    unityGame({ installedLoaders: [] }),
    unityGame({ installedTranslators: [{ ...normal.installedTranslators[0]!, variantId: 'bepinex-il2cpp' }] }),
    unityGame({ installedTranslators: [{ ...normal.installedTranslators[0]!, variantId: undefined }] }),
  ]) {
    const recommendation = recommendGameFont(reg, game, { targetLanguage: 'ko' });
    assert.equal(recommendation.status, 'recommended');
    assert.equal(recommendation.installable, false);
    assert.ok(recommendation.blockReason);
    assert.equal(resolveFontPlan(reg, game, { targetLanguage: 'ko' }), undefined);
  }
});

test('configured without a present bundle is not falsely reported as installed', () => {
  const options = { targetLanguage: 'ko', currentFallbackFontTextMeshPro: 'arialuni_sdf_u2021' };
  const missing = recommendGameFont(reg, unityGame(), options);
  assert.equal(missing.status, 'recommended');
  assert.equal(missing.configured, true);
  assert.equal(missing.alreadyPresent, false);
  const present = unityGame({ installedFontBundles: ['arialuni_sdf_u2021'] });
  assert.equal(recommendGameFont(reg, present, options).status, 'installed');
  assert.equal(resolveFontPlan(reg, present, options), undefined);
});

test('font-only plans do not download or replace translator/loader payloads', () => {
  const plan = resolveFontPlan(reg, unityGame(), { targetLanguage: 'ko' })!;
  assert.equal(plan.purpose, 'font');
  assert.equal(plan.loader, undefined);
  assert.deepEqual(plan.steps.map((item) => item.action), ['download', 'copy', 'config']);
  assert.ok(plan.steps.every((item) => item.details?.['fontBundleId'] === 'arialuni_sdf_u2021'));
  assert.deepEqual(plan.config, { Behaviour: { FallbackFontTextMeshPro: 'arialuni_sdf_u2021' } });
  const reused = resolveFontPlan(reg, unityGame({ installedFontBundles: ['arialuni_sdf_u2021'] }), { targetLanguage: 'ko' })!;
  assert.deepEqual(reused.steps.map((item) => item.action), ['config']);
});

test('equivalent four-component PE versions use the registered translator version for font eligibility', () => {
  const game = unityGame();
  game.installedTranslators[0]!.version = '5.6.1.0';
  assert.equal(recommendGameFont(reg, game, { targetLanguage: 'ko' }).installable, true);
  const plan = resolveFontPlan(reg, game, { targetLanguage: 'ko' });
  assert.equal(plan?.purpose, 'font');
  assert.equal(plan?.variantId, 'bepinex');
  game.installedTranslators[0]!.version = '5.6.1.1';
  assert.equal(resolveFontPlan(reg, game, { targetLanguage: 'ko' }), undefined, 'a genuinely different unknown version is not normalised away');
});

test('adding an existing bundle only changes fallback, records a font receipt and restores the user config', async () => {
  const game = await gameRoot('reuse', true);
  const plan = resolveFontPlan(reg, game, { targetLanguage: 'ko', endpoint: 'GoogleTranslate', sourceLanguage: 'ja' })!;
  const result = await applyPlan(plan);
  assert.deepEqual(result.filesWritten, ['BepInEx/config/AutoTranslatorConfig.ini']);
  assert.deepEqual(result.pendingUserActions, []);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]?.kind, 'font');
  assert.equal(result.receipts[0]?.componentId, 'arialuni_sdf_u2021');
  const changedText = await fsp.readFile(path.join(game.path, plan.steps[0]!.dest!), 'utf8');
  const changed = parseIni(changedText);
  assert.equal(changed['General']?.['Language'], 'ko');
  assert.equal(changed['General']?.['FromLanguage'], 'en');
  assert.equal(changed['Service']?.['Endpoint'], 'CustomEndpoint');
  assert.equal(changed['Behaviour']?.['FallbackFontTextMeshPro'], 'arialuni_sdf_u2021');
  assert.equal(changed['Behaviour']?.['OverrideFontTextMeshPro'], 'MyExistingOverride');
  assert.equal(changed['Unknown']?.['UserValue'], 'keep-me');
  assert.match(changedText, /retain user comments/);
  const receipts = await readReceipts(game.path);
  assert.equal(receipts[0]?.entries[0]?.sha256, crypto.createHash('sha256').update(changedText).digest('hex'));
  await uninstallReceipt(receipts[0]!);
  assert.equal(await fsp.readFile(path.join(game.path, plan.steps[0]!.dest!), 'utf8'), ORIGINAL_CONFIG);
  assert.equal(await fsp.readFile(path.join(game.path, 'arialuni_sdf_u2021'), 'utf8'), 'original external font', 'reused external bundles are not owned or removed');
});

test('a copied font has a hash-bearing font receipt, while translator payloads stay untouched', async () => {
  const game = await gameRoot('copied');
  const cacheDir = path.join(tmp, 'cache-copied');
  const source = { type: 'url' as const, url: 'https://font-fixture.invalid/bundles.7z' };
  const fixtureReg: Registry = { ...reg, fonts: { ...reg.fonts, source } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from('isolated archive fixture'), { status: 200 });
  try {
    const downloaded = await downloadAsset(source, { cacheDir });
    const extractedDir = path.join(cacheDir, 'extracted', path.basename(downloaded.path).replace(/\.[^.]+$/, ''));
    await fsp.mkdir(extractedDir, { recursive: true });
    await fsp.writeFile(path.join(extractedDir, '.indiedeck-extracted'), '7z');
    const payload = Buffer.from('isolated atlas fixture');
    await fsp.writeFile(path.join(extractedDir, 'arialuni_sdf_u2021'), payload);
    const plan = resolveFontPlan(fixtureReg, game, { targetLanguage: 'ko' })!;
    const result = await applyPlan(plan, { cacheDir });
    assert.deepEqual(result.pendingUserActions, []);
    assert.equal(result.receipts[0]?.kind, 'font');
    const entry = result.receipts[0]?.entries.find((item) => item.path === 'arialuni_sdf_u2021');
    assert.equal(entry?.operation, 'create');
    assert.equal(entry?.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    assert.equal(fs.existsSync(path.join(game.path, 'BepInEx/plugins/XUnity.AutoTranslator')), false);
    await fsp.writeFile(path.join(game.path, 'arialuni_sdf_u2021'), 'user-modified atlas');
    const removed = await uninstallReceipt(result.receipts[0]!);
    assert.ok(removed.keptModified.includes('arialuni_sdf_u2021'));
    assert.equal(await fsp.readFile(path.join(game.path, 'arialuni_sdf_u2021'), 'utf8'), 'user-modified atlas');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unavailable font bytes never change fallback config or falsely complete a font-only install', async () => {
  const game = await gameRoot('missing-copy');
  const plan = resolveFontPlan(reg, game, { targetLanguage: 'ko' })!;
  plan.steps = plan.steps.filter((item) => item.action === 'config');
  const result = await applyPlan(plan);
  assert.equal(await fsp.readFile(path.join(game.path, plan.steps[0]!.dest!), 'utf8'), ORIGINAL_CONFIG);
  assert.deepEqual(result.filesWritten, []);
  assert.deepEqual(result.receipts, []);
  assert.equal(result.performed[0]?.status, 'pending-user');
  assert.ok(result.pendingUserActions.length > 0);
});

test('an initial translator still gets language/provider settings but never a missing font reference', async () => {
  const game = await gameRoot('initial-no-font');
  const plan = summarisePlans(resolvePlans(reg, game, { targetLanguage: 'ja', endpoint: 'GoogleTranslate' })).find((item) => item.viable)!;
  plan.steps = plan.steps.filter((item) => item.action === 'config');
  const result = await applyPlan(plan);
  const config = parseIni(await fsp.readFile(path.join(game.path, plan.steps[0]!.dest!), 'utf8'));
  assert.equal(config['General']?.['Language'], 'ja');
  assert.equal(config['Service']?.['Endpoint'], 'GoogleTranslate');
  assert.equal(config['Behaviour']?.['FallbackFontTextMeshPro'], '');
  assert.equal(result.receipts[0]?.kind, 'translator');
  assert.ok(result.pendingUserActions.length > 0);
});

test('font-only application rejects broader writes before touching the game', async () => {
  const game = await gameRoot('malformed');
  const plan = resolveFontPlan(reg, game, { targetLanguage: 'ko' })!;
  plan.config['General'] = { Language: 'en' };
  await assert.rejects(() => applyPlan(plan), /font-only plan/);
  assert.equal(await fsp.readFile(path.join(game.path, 'BepInEx/config/AutoTranslatorConfig.ini'), 'utf8'), ORIGINAL_CONFIG);
});

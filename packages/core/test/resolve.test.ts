import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditGame } from '../src/audit/index.ts';
import { loadRegistry, validateRegistry } from '../src/registry/index.ts';
import { pickFontBundle, resolvePlans, summarisePlans } from '../src/resolve/index.ts';
import type { GameProfile } from '../src/types.ts';

const reg = loadRegistry();

function unityGame(overrides: Partial<GameProfile> & { unity?: Partial<GameProfile['unity']> } = {}): GameProfile {
  const { unity, ...rest } = overrides;
  return {
    path: 'C:/games/Test',
    name: 'Test',
    engineId: 'unity',
    engineName: 'Unity',
    confidence: 100,
    alternatives: [],
    executable: 'Test.exe',
    arch: 'x64',
    captures: {},
    installedLoaders: [],
    installedTranslators: [],
    installedFontBundles: [],
    notes: [],
    scannedAt: new Date(0).toISOString(),
    unity: { backend: 'mono', version: '2021.3.16f1', ...(unity ?? {}) } as GameProfile['unity'],
    ...rest,
  };
}

test('the shipped registry is internally consistent', () => {
  assert.deepEqual(validateRegistry(reg).filter((i) => i.level === 'error'), []);
});

test('a Mono game gets the BepInEx Mono variant, not IL2CPP', () => {
  const plans = summarisePlans(resolvePlans(reg, unityGame(), { targetLanguage: 'en' }));
  const best = plans.find((p) => p.viable);
  assert.equal(best?.translatorId, 'xunity-autotranslator');
  assert.equal(best?.variantId, 'bepinex');
  assert.equal(best?.loader?.loaderId, 'bepinex5');
  assert.equal(plans.some((p) => p.viable && p.variantId === 'bepinex-il2cpp'), false);
});

test('an IL2CPP game is routed to BepInEx 6 bleeding edge', () => {
  const plans = summarisePlans(resolvePlans(reg, unityGame({ unity: { backend: 'il2cpp', version: '2021.3.5f1' } })));
  const best = plans.find((p) => p.viable);
  assert.equal(best?.variantId, 'bepinex-il2cpp');
  assert.equal(best?.loader?.loaderId, 'bepinex6-il2cpp');
  assert.equal(best?.loader?.channel, 'bleeding-edge');
});

test('pre-2017 IL2CPP is blocked with the changelog as the source', () => {
  const plans = resolvePlans(reg, unityGame({ unity: { backend: 'il2cpp', version: '5.6.4f1' } }), { includeNonViable: true });
  const il2cpp = plans.find((p) => p.variantId === 'bepinex-il2cpp');
  assert.equal(il2cpp?.viable, false);
  const blocking = il2cpp?.findings.find((f) => f.severity === 'block');
  assert.match(String(blocking?.message), /pre-2017|2017/);
  assert.ok(blocking?.sources?.some((s) => s.includes('CHANGELOG')));
});

test('an already-installed loader is preferred over adding a second one', () => {
  const withBepInEx = unityGame({ installedLoaders: [{ loaderId: 'bepinex5', version: '5.4.23.3', markers: ['BepInEx/core/BepInEx.dll'] }] });
  const plain = summarisePlans(resolvePlans(reg, unityGame())).find((p) => p.viable)!;
  const reuse = summarisePlans(resolvePlans(reg, withBepInEx)).find((p) => p.viable)!;

  assert.equal(reuse.loader?.alreadyInstalled, true);
  assert.equal(reuse.loader?.version, '5.4.23.3', 'the installed version is carried through, not the newest');
  assert.ok(reuse.score > plain.score);
});

test('ReiPatcher is blocked when a mod loader is already present', () => {
  const withLoader = unityGame({ installedLoaders: [{ loaderId: 'bepinex5', markers: ['BepInEx/core/BepInEx.dll'] }] });
  const plans = resolvePlans(reg, withLoader, { includeNonViable: true });
  const rei = plans.find((p) => p.variantId === 'reipatcher');
  assert.equal(rei?.viable, false);
  assert.ok(rei?.findings.some((f) => f.ruleId === 'reipatcher-conflicts-with-loader'));
});

test('v5.6.0 is never offered for the ReiPatcher variant, because it ships no such asset', () => {
  const plans = resolvePlans(reg, unityGame(), { includeNonViable: true, variantId: 'reipatcher' });
  const versions = plans.filter((p) => p.viable).map((p) => p.version);
  assert.equal(versions.includes('5.6.0'), false);
  assert.ok(versions.includes('5.6.1'));
});

test('DeepL below 5.5.2 is flagged, 5.5.2 and up is not', () => {
  const old = resolvePlans(reg, unityGame(), { endpoint: 'DeepLTranslateLegitimate', version: '5.4.6' });
  const fixed = resolvePlans(reg, unityGame(), { endpoint: 'DeepLTranslateLegitimate', version: '5.5.2' });
  assert.ok(old.some((p) => p.findings.some((f) => f.ruleId === 'deepl-auth-header-needs-5.5.2')));
  assert.equal(fixed.some((p) => p.findings.some((f) => f.ruleId === 'deepl-auth-header-needs-5.5.2')), false);
});

test('a CJK target on a TextMeshPro game pulls in the matching font bundle', () => {
  const game = unityGame({ unity: { backend: 'mono', version: '2021.3.16f1', usesTextMeshPro: true } });
  const best = summarisePlans(resolvePlans(reg, game, { targetLanguage: 'ko' })).find((p) => p.viable);
  assert.equal(best?.fontBundle?.file, 'arialuni_sdf_u2021');
  assert.equal(best?.config['Behaviour']?.['FallbackFontTextMeshPro'], 'arialuni_sdf_u2021');

  const english = summarisePlans(resolvePlans(reg, game, { targetLanguage: 'en' })).find((p) => p.viable);
  assert.equal(english?.fontBundle, undefined, 'a latin target needs no fallback atlas');
});

test('font bundles are chosen per Unity line', () => {
  assert.equal(pickFontBundle(reg, '5.6.4f1')?.id, 'arialuni_sdf-u55to2017');
  assert.equal(pickFontBundle(reg, '2018.4.1f1')?.id, 'arialuni_sdf_u2018');
  assert.equal(pickFontBundle(reg, '2020.3.14f1')?.id, 'arialuni_sdf_u2019');
  assert.equal(pickFontBundle(reg, '2022.3.10f1')?.id, 'arialuni_sdf_u2022');
  assert.equal(pickFontBundle(reg, '6000.0.58f2')?.id, 'arialuni_sdf_u6000');
  assert.equal(pickFontBundle(reg, undefined), undefined);
});

test('an unknown Unity version never hard-blocks a plan', () => {
  const plans = summarisePlans(resolvePlans(reg, unityGame({ unity: { backend: 'il2cpp', version: undefined } })));
  assert.ok(plans.some((p) => p.viable && p.variantId === 'bepinex-il2cpp'));
});

test('engines with no in-process translator fall back to OCR tools', () => {
  const godot: GameProfile = {
    ...unityGame(),
    engineId: 'godot',
    engineName: 'Godot Engine',
    unity: undefined as unknown as GameProfile['unity'],
  };
  const plans = summarisePlans(resolvePlans(reg, godot)).filter((p) => p.viable);
  assert.ok(plans.length > 0);
  assert.ok(plans.every((p) => ['mort', 'lunatranslator'].includes(p.translatorId)));
});

test('the plan carries concrete install steps with a real asset name', () => {
  const best = summarisePlans(resolvePlans(reg, unityGame())).find((p) => p.viable)!;
  const download = best.steps.find((s) => s.action === 'download' && s.source?.repo === 'bbepis/XUnity.AutoTranslator');
  assert.equal(download?.source?.asset, `XUnity.AutoTranslator-BepInEx-${best.version}.zip`);
  assert.ok(best.steps.some((s) => s.action === 'extract'));
  assert.ok(best.steps.some((s) => s.action === 'config' && s.dest === 'BepInEx/config/AutoTranslatorConfig.ini'));
});

/* ------------------------------------------------------------------- audit */

test('audit catches a font bundle built for the wrong Unity line', () => {
  const game = unityGame({
    unity: { backend: 'mono', version: '2022.3.48f1', usesTextMeshPro: true },
    installedFontBundles: ['arialuni_sdf_u2018', 'arialuni_sdf_u2019'],
  });
  const issues = auditGame(reg, game).issues;
  const mismatch = issues.find((i) => i.code === 'font-bundle-mismatch');
  assert.ok(mismatch);
  assert.match(mismatch.message, /2022\.3\.48f1/);
  assert.match(String(mismatch.fix), /arialuni_sdf_u2022/);
});

test('audit catches stacked loaders and orphaned plugin payloads', () => {
  const game = unityGame({
    installedLoaders: [
      { loaderId: 'bepinex6-mono', markers: ['BepInEx/core/BepInEx.Unity.Mono.dll'] },
      { loaderId: 'reipatcher', markers: ['ReiPatcher/ReiPatcher.exe'] },
    ],
    installedTranslators: [
      { translatorId: 'xunity-autotranslator', variantId: 'melonmod', version: '5.4.4', markers: ['Mods/XUnity.AutoTranslator.Plugin.MelonMod.dll'] },
    ],
  });
  const codes = auditGame(reg, game).issues.map((i) => i.code);
  assert.ok(codes.includes('loaders-stacked'));
  assert.ok(codes.includes('translator-payload-orphaned'));
  assert.ok(codes.includes('translator-outdated'));
});

test('a healthy install produces no audit issues', () => {
  const game = unityGame({
    unity: { backend: 'mono', version: '2021.3.16f1', usesTextMeshPro: true },
    installedFontBundles: ['arialuni_sdf_u2021'],
    installedLoaders: [{ loaderId: 'bepinex5', version: '5.4.23.5', markers: ['BepInEx/core/BepInEx.dll'] }],
    installedTranslators: [
      { translatorId: 'xunity-autotranslator', variantId: 'bepinex', version: '5.6.1', markers: ['BepInEx/plugins/XUnity.AutoTranslator'] },
    ],
  });
  assert.deepEqual(auditGame(reg, game).issues, []);
});

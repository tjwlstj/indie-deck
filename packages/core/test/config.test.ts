import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { planConfigChanges, readGameConfig, writeGameConfig, resolveMapping } from '../src/config/index.ts';
import type { ConfigSchema, SettingDef } from '../src/config/schema.ts';
import { detectGame } from '../src/detect/index.ts';
import { loadRegistry } from '../src/registry/index.ts';
import { parseIni } from '../src/util/ini.ts';

const reg = loadRegistry();
const schemas = reg.configSchemas as Map<string, ConfigSchema>;
const schema = schemas.get('xunity-autotranslator')!;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-cfg-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function exe(): Buffer {
  const b = Buffer.alloc(512);
  b.writeUInt16LE(0x5a4d, 0);
  b.writeUInt32LE(0x80, 0x3c);
  b.writeUInt32LE(0x4550, 0x80);
  b.writeUInt16LE(0x8664, 0x84);
  return b;
}

// A config shaped like the real generated file: leading comment, inline
// comments, a section IndieDeck knows nothing about, and a Migrations tag.
const REAL_CONFIG = [
  '[Service]',
  'Endpoint=GoogleTranslate     ;Which translation service to use',
  'FallbackEndpoint=',
  '',
  '; users often leave notes in here',
  '[General]',
  'Language=en',
  'FromLanguage=ja',
  '',
  '[Behaviour]',
  'MaxCharactersPerTranslation=2000',
  'FallbackFontTextMeshPro=',
  'SomeFutureOption=True',
  '',
  '[DeepLLegitimate]',
  'ApiKey=super-secret-key-1234',
  'Free=False',
  '',
  '[Migrations]',
  'Enable=True',
  'Tag=5.4.5',
  '',
  '[SomePluginNobodyKnows]',
  'MyValue=123',
].join('\r\n');

function makeGame(name: string, options: { config?: string; dllVersion?: string } = {}): string {
  const root = path.join(tmp, name);
  const write = (rel: string, data: string | Buffer): void => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };
  write('Game.exe', exe());
  write('UnityPlayer.dll', 'stub');
  write('Game_Data/globalgamemanagers', Buffer.concat([Buffer.alloc(48), Buffer.from('2021.3.16f1\0')]));
  write('Game_Data/Managed/Assembly-CSharp.dll', 'stub');
  write('BepInEx/core/BepInEx.dll', 'stub');
  write('BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll', 'stub');
  if (options.config !== undefined) write('BepInEx/config/AutoTranslatorConfig.ini', options.config);
  return root;
}

/* ------------------------------------------------------ §83 version schema */

test('a setting maps to different sections depending on the installed version', () => {
  const targetLanguage = schema.settings.find((s) => s.id === 'xunity.targetLanguage')!;

  const modern = resolveMapping(targetLanguage, '5.6.1')!;
  assert.equal(modern.section, 'General');
  assert.equal(modern.key, 'Language');
  assert.equal(modern.assumed, false);

  const legacy = resolveMapping(targetLanguage, '3.8.0')!;
  assert.equal(legacy.section, 'AutoTranslator', 'the pre-4.x layout is a different section');
  assert.equal(legacy.assumed, false);
});

test('an unknown version falls back to the newest layout and says it is assuming', () => {
  const targetLanguage = schema.settings.find((s) => s.id === 'xunity.targetLanguage')!;
  const guess = resolveMapping(targetLanguage, undefined)!;
  assert.equal(guess.section, 'General');
  assert.equal(guess.assumed, true, 'the caller can tell this was not a declared mapping');
  assert.equal(guess.confidence, 'inferred');
});

test('a setting that does not exist in the installed version is hidden', () => {
  const uiElements = schema.settings.find((s) => s.id === 'xunity.enableUIElements')!;
  assert.deepEqual(uiElements.availability, { min: '5.6.0' });

  const stub: SettingDef = uiElements;
  assert.ok(resolveMapping(stub, '5.6.1'), 'present on 5.6+');
});

/* --------------------------------------------------------- §41/§42 reading */

test('reading a config reports known values, unknown keys and coverage', async () => {
  const root = makeGame('cfg-read', { config: REAL_CONFIG });
  const profile = detectGame(reg, root)!;
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');

  assert.equal(config.values.find((v) => v.id === 'xunity.targetLanguage')?.value, 'en');
  assert.equal(config.values.find((v) => v.id === 'xunity.endpoint')?.value, 'GoogleTranslate');

  const unknownKeys = config.unknown.map((u) => `${u.section}.${u.key}`);
  assert.ok(unknownKeys.includes('SomePluginNobodyKnows.MyValue'), 'a foreign section is reported, not dropped');
  assert.ok(unknownKeys.includes('Behaviour.SomeFutureOption'), 'a future option is reported');
  assert.ok(config.coverage.described > 0 && config.coverage.total >= config.coverage.described);
});

test('the installed version comes from the assembly, not the Migrations tag', async () => {
  const root = makeGame('cfg-version', { config: REAL_CONFIG });
  const profile = detectGame(reg, root)!;
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');

  // The stub DLL has no version resource, so detection falls through to the tag
  // and must say so rather than presenting it as fact.
  assert.equal(config.detected.source, 'config-tag');
  assert.equal(config.detected.version, '5.4.5');
  assert.equal(config.detected.confidence, 'community');
  assert.ok(config.warnings.some((w) => /Migrations tag/.test(w.text)));
});

test('a missing config file is reported as "not generated yet", not as an error', async () => {
  const root = makeGame('cfg-missing');
  const profile = detectGame(reg, root)!;
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');

  assert.equal(config.location.exists, false);
  assert.equal(config.location.path, 'BepInEx/config/AutoTranslatorConfig.ini');
  assert.ok(config.warnings.some((w) => /does not exist yet/.test(w.text)));
  assert.equal(config.values.find((v) => v.id === 'xunity.targetLanguage')?.value, 'en', 'defaults fill in');
});

/* ---------------------------------------------------------- §84 redaction */

test('credentials are redacted on read and in the change diff', async () => {
  const root = makeGame('cfg-secrets', { config: REAL_CONFIG });
  const profile = detectGame(reg, root)!;

  const masked = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');
  const deepl = masked.providers.find((p) => p.provider.id === 'DeepLTranslateLegitimate')!;
  const apiKey = deepl.fields.find((f) => f.key === 'ApiKey')!;
  assert.equal(apiKey.value.includes('super-secret'), false, 'the key never leaves in the clear by default');
  assert.match(apiKey.value, /1234$/, 'the last characters are kept so the user can recognise it');

  const revealed = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator', { revealSecrets: true });
  assert.equal(
    revealed.providers.find((p) => p.provider.id === 'DeepLTranslateLegitimate')!.fields.find((f) => f.key === 'ApiKey')!.value,
    'super-secret-key-1234',
  );

  const plan = planConfigChanges(schema, masked, [
    { id: 'provider:DeepLTranslateLegitimate:ApiKey', value: 'another-secret-value-9876' },
  ]);
  const diffEntry = plan.changes.find((c) => c.key === 'ApiKey')!;
  assert.equal(diffEntry.isSecret, true);
  assert.equal(diffEntry.to.includes('another-secret'), false, 'the diff shown to the user is redacted');
  assert.equal(plan.patch['DeepLLegitimate']?.['ApiKey'], 'another-secret-value-9876', 'but the real value is written');
});

/* ------------------------------------------------------------- validation */

test('validation rejects a bad language code and an unknown engine', () => {
  const base = {
    translatorId: 'xunity-autotranslator',
    translatorName: 'X',
    detected: { source: 'assembly' as const, confidence: 'verified' as const, version: '5.6.1' },
    location: { path: 'x.ini', variant: 'bepinex', confidence: 'verified' as const, exists: true },
    values: [],
    providers: [],
    unknown: [],
    coverage: { described: 0, total: 0 },
    warnings: [],
  };

  const bad = planConfigChanges(schema, base, [
    { id: 'xunity.targetLanguage', value: 'Korean' },
    { id: 'xunity.endpoint', value: 'NotARealEngine' },
    { id: 'xunity.maxCharactersPerTranslation', value: 'lots' },
  ]);
  assert.equal(bad.valid, false);
  assert.equal(bad.issues.filter((i) => i.severity === 'error').length, 3);

  const good = planConfigChanges(schema, base, [
    { id: 'xunity.targetLanguage', value: 'ko' },
    { id: 'xunity.endpoint', value: 'PapagoTranslate' },
    { id: 'xunity.maxCharactersPerTranslation', value: '1500' },
  ]);
  assert.equal(good.valid, true);
  assert.equal(good.patch['General']?.['Language'], 'ko');
  assert.equal(good.patch['Service']?.['Endpoint'], 'PapagoTranslate');
});

test('an engine that cannot do the chosen language pair is flagged', async () => {
  const root = makeGame('cfg-langs', { config: REAL_CONFIG });
  const profile = detectGame(reg, root)!;
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');

  // ezTrans XP is a Japanese-to-Korean engine only.
  const wrong = planConfigChanges(schema, config, [
    { id: 'xunity.endpoint', value: 'ezTransXP' },
    { id: 'xunity.sourceLanguage', value: 'en' },
    { id: 'xunity.targetLanguage', value: 'de' },
  ]);
  assert.ok(wrong.issues.some((i) => i.id === 'xunity.sourceLanguage' && i.severity === 'warn'));
  assert.ok(wrong.issues.some((i) => i.id === 'xunity.targetLanguage' && i.severity === 'warn'));

  const right = planConfigChanges(schema, config, [
    { id: 'xunity.endpoint', value: 'ezTransXP' },
    { id: 'xunity.sourceLanguage', value: 'ja' },
    { id: 'xunity.targetLanguage', value: 'ko' },
  ]);
  assert.equal(right.issues.some((i) => i.id.startsWith('xunity.') && i.severity === 'warn' && /language/.test(i.message)), false);
});

test('a provider missing its required credential is warned about, not silently accepted', async () => {
  const root = makeGame('cfg-creds', { config: REAL_CONFIG.replace('ApiKey=super-secret-key-1234', 'ApiKey=') });
  const profile = detectGame(reg, root)!;
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');

  const plan = planConfigChanges(schema, config, [{ id: 'xunity.endpoint', value: 'DeepLTranslateLegitimate' }]);
  assert.ok(
    plan.issues.some((i) => i.id === 'provider:DeepLTranslateLegitimate:ApiKey' && /not set/.test(i.message)),
    'the user is told translation will fail without the key',
  );
  assert.equal(plan.valid, true, 'a missing key is a warning, not a hard block - they may fill it in later');
});

/* -------------------------------------------------------- §82 preservation */

test('writing a change preserves comments, unknown keys, order and line endings', async () => {
  const root = makeGame('cfg-write', { config: REAL_CONFIG });
  const profile = detectGame(reg, root)!;
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');

  const plan = planConfigChanges(schema, config, [
    { id: 'xunity.targetLanguage', value: 'ko' },
    { id: 'xunity.endpoint', value: 'PapagoTranslate' },
  ]);
  assert.equal(plan.valid, true);

  const result = await writeGameConfig(profile, config, plan);
  assert.equal(result.changed, 2);
  assert.ok(result.backup, 'the original was backed up');

  const after = await fsp.readFile(path.join(root, 'BepInEx/config/AutoTranslatorConfig.ini'), 'utf8');
  const parsed = parseIni(after);

  assert.equal(parsed['General']?.['Language'], 'ko');
  assert.equal(parsed['Service']?.['Endpoint'], 'PapagoTranslate');
  assert.match(after, /;Which translation service to use/, 'the inline comment survives');
  assert.match(after, /; users often leave notes in here/, 'the standalone comment survives');
  assert.equal(parsed['SomePluginNobodyKnows']?.['MyValue'], '123', 'a foreign section is untouched');
  assert.equal(parsed['Behaviour']?.['SomeFutureOption'], 'True', 'an unknown key is untouched');
  assert.equal(parsed['Migrations']?.['Tag'], '5.4.5', 'the migration tag is not rewritten');
  assert.ok(after.includes('\r\n'), 'CRLF line endings are preserved');

  assert.deepEqual(
    Object.keys(parsed),
    ['Service', 'General', 'Behaviour', 'DeepLLegitimate', 'Migrations', 'SomePluginNobodyKnows'],
    'section order is unchanged',
  );

  const backup = await fsp.readFile(path.join(root, result.backup!), 'utf8');
  assert.equal(backup, REAL_CONFIG, 'the backup is the untouched original');
});

test('a dry run reports the diff and writes nothing', async () => {
  const root = makeGame('cfg-dryrun', { config: REAL_CONFIG });
  const profile = detectGame(reg, root)!;
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');

  const plan = planConfigChanges(schema, config, [{ id: 'xunity.targetLanguage', value: 'ko' }]);
  const result = await writeGameConfig(profile, config, plan, { dryRun: true });

  assert.deepEqual(result.diff, ['[General] Language: en -> ko']);
  assert.equal(await fsp.readFile(path.join(root, 'BepInEx/config/AutoTranslatorConfig.ini'), 'utf8'), REAL_CONFIG);
});

test('an invalid plan is refused rather than half-written', async () => {
  const root = makeGame('cfg-invalid', { config: REAL_CONFIG });
  const profile = detectGame(reg, root)!;
  const config = await readGameConfig(reg, schemas, profile, 'xunity-autotranslator');

  const plan = planConfigChanges(schema, config, [{ id: 'xunity.targetLanguage', value: 'not-a-language' }]);
  await assert.rejects(() => writeGameConfig(profile, config, plan), /invalid config plan/);
  assert.equal(await fsp.readFile(path.join(root, 'BepInEx/config/AutoTranslatorConfig.ini'), 'utf8'), REAL_CONFIG);
});

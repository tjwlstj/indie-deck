import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { detectGame, loadRegistry, type ConfigSchema, type GameConfig, type SettingDef } from '../src/index.ts';
import { buildTranslationConfigComparison, compareTranslationConfig } from '../../desktop/src/translation-config-comparison.ts';

const registry = loadRegistry(), parent = path.resolve(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(parent, 'indiedeck-config-comparison-'));
after(() => { assert.equal(path.dirname(temporary), parent); fs.rmSync(temporary, { recursive: true, force: true }); });
function setting(id: string, extra: Partial<SettingDef> = {}): SettingDef {
  return { id, ui: { label: id, category: 'basic', type: 'string' }, versions: [{ min: '5.0.0', section: 'General', key: id }], default: 'reference', ...extra };
}
const schema: ConfigSchema = {
  schemaVersion: 1, translator: 'xunity-autotranslator', versionDetection: { order: [] },
  configLocations: [{ variant: 'bepinex', path: 'BepInEx/config/AutoTranslatorConfig.ini', confidence: 'verified' }, { variant: 'melonmod', path: 'UserData/AutoTranslatorConfig.ini', confidence: 'community' }],
  categories: [{ id: 'basic', label: 'Basic' }], providers: [],
  settings: [
    setting('retained'),
    setting('moved', { versions: [{ max: '5.4.9', section: 'Old', key: 'Previous', confidence: 'inferred' }, { min: '5.5.0', section: 'General', key: 'Current' }] }),
    setting('added', { availability: { min: '5.6.0' }, versions: [{ min: '5.6.0', section: 'Behaviour', key: 'Added' }], default: 'True' }),
    setting('removed', { availability: { max: '5.5.9' } }),
    setting('missing'),
    setting('credential', { ui: { label: 'Credential', category: 'credentials', type: 'secret' }, default: 'synthetic-default-secret' }),
    setting('future', { versions: [{ min: '6.0.0', section: 'Future', key: 'Future' }] }),
  ],
};
function current(): GameConfig {
  return {
    translatorId: 'xunity-autotranslator', translatorName: 'XUnity',
    detected: { version: '5.4.5', source: 'assembly', confidence: 'verified' },
    location: { variant: 'bepinex', path: schema.configLocations[0]!.path, exists: true, confidence: 'verified' },
    values: schema.settings.filter((entry) => !['added', 'future'].includes(entry.id)).map((entry) => ({
      id: entry.id, label: entry.ui.label, category: entry.ui.category, type: entry.ui.type,
      value: entry.id === 'credential' ? 'synthetic-current-secret' : entry.id === 'missing' ? 'reference' : 'custom-value',
      present: entry.id !== 'missing', isDefault: entry.id === 'missing',
      section: entry.id === 'moved' ? 'Old' : 'General', key: entry.id === 'moved' ? 'Previous' : entry.id,
      assumed: false, confidence: 'verified', ui: entry.ui,
    })),
    providers: [{ provider: { id: 'Custom', label: 'Custom', tier: ['local'], fields: [{ key: 'Delay', label: 'Delay', type: 'number', min: 0, max: 60 }] }, selected: true,
      fields: [
        { key: 'ApiKey', label: 'Key', type: 'secret', value: 'provider-secret-do-not-send', required: true, isSecret: true, present: true },
        { key: 'Url', label: 'Url', type: 'string', value: 'https://private.invalid/path?token=private-query-token', required: true, isSecret: false, present: true },
        { key: 'Enabled', label: 'Enabled', type: 'boolean', value: 'True', required: false, isSecret: false, present: true },
        { key: 'Delay', label: 'Delay', type: 'number', value: '0.4', required: false, isSecret: false, present: true },
        { key: 'AppId', label: 'App', type: 'string', value: 'private-app-id', required: false, isSecret: false, present: true },
      ] }],
    unknown: [{ section: 'Private', key: 'Authorization', value: 'unknown-secret-not-in-report' }],
    coverage: { described: 5, total: 6 }, warnings: [],
  };
}

test('comparison distinguishes preserved custom values, declared additions, missing keys, moves and unavailable targets', () => {
  const report = compareTranslationConfig(schema, current(), { version: '5.6.1', variantId: 'bepinex' }, true);
  const row = (id: string) => report.rows.find((entry) => entry.id === id)!;
  assert.equal(row('retained').status, 'retained'); assert.equal(row('retained').currentValue, 'custom-value');
  assert.equal(row('retained').targetDefault, 'reference'); assert.equal(row('retained').customValue, true);
  assert.equal(row('moved').status, 'relocated'); assert.equal(row('moved').currentLocation!.confidence, 'inferred');
  assert.equal(row('moved').currentLocation!.section, 'Old'); assert.equal(row('moved').targetLocation!.section, 'General');
  assert.equal(row('added').status, 'new-default'); assert.equal(row('added').introduced, true);
  assert.equal(row('missing').status, 'new-default'); assert.equal(row('missing').introduced, false); assert.equal(row('missing').currentPresent, false);
  assert.equal(row('removed').status, 'unsupported'); assert.equal(row('future').status, 'unmapped');
  assert.equal(report.preservesConfig, true); assert.equal(report.migrationSimulated, false);
  assert.equal(report.coverage.total, 6); assert.equal(report.coverage.schemaSettings, schema.settings.length);
});

test('unknown current versions and unregistered target versions never manufacture precise migration claims', () => {
  const unknown = current(); delete unknown.detected.version; unknown.detected.source = 'unknown'; unknown.detected.confidence = 'unverified';
  const unconfirmed = compareTranslationConfig(schema, unknown, { version: '5.6.1', variantId: 'bepinex', currentVersions: ['5.4.5', '5.5.2'] }, true);
  assert.equal(unconfirmed.currentVersion.ambiguous, true);
  assert.equal(unconfirmed.rows.some((row) => row.status === 'relocated'), false);
  assert.equal(unconfirmed.rows.find((row) => row.id === 'retained')!.status, 'unmapped');
  const unknownTarget = compareTranslationConfig(schema, current(), { version: '99.0.0', variantId: 'bepinex' }, false);
  assert.equal(unknownTarget.rows.every((row) => row.status === 'unmapped'), true);
  assert.equal(unknownTarget.coverage.targetMapped, 0);
  const ambiguous = compareTranslationConfig(schema, current(), { version: '5.6.1', currentVersions: ['5.4.5', '5.6.1'] }, true);
  assert.equal(ambiguous.rows.some((row) => ['retained', 'relocated'].includes(row.status) || row.introduced), false);
});

test('a receipt conflicting with one observed payload version cannot establish precise current options or provider compatibility', () => {
  const state = current(); state.detected = { version: '5.5.1', source: 'receipt', confidence: 'verified' };
  state.providers[0]!.provider.requiresTranslatorVersion = { min: '5.5.2' };
  const report = compareTranslationConfig(schema, state, { version: '5.6.1', currentVersions: ['5.4.0'] }, true);
  assert.equal(report.currentVersion.version, '5.5.1'); assert.equal(report.currentVersion.source, 'receipt');
  assert.equal(report.currentVersion.ambiguous, true);
  assert.equal(report.rows.some((row) => row.introduced || ['retained', 'relocated', 'new-default'].includes(row.status)), false);
  assert.equal(report.rows.find((row) => row.id === 'removed')!.status, 'unsupported');
  assert.equal(report.providers[0]!.currentMeetsRequirement, undefined); assert.equal(report.providers[0]!.targetMeetsRequirement, true);
});

test('equivalent receipt and four-part payload versions do not introduce an ambiguity', () => {
  const state = current(); state.detected = { version: '5.5.2', source: 'receipt', confidence: 'verified' };
  state.providers[0]!.provider.requiresTranslatorVersion = { min: '5.5.2' };
  const report = compareTranslationConfig(schema, state, { version: '5.6.1', currentVersions: ['5.5.2.0'] }, true);
  assert.equal(report.currentVersion.ambiguous, false);
  assert.equal(report.rows.find((row) => row.id === 'retained')!.status, 'retained');
  assert.equal(report.rows.find((row) => row.id === 'added')!.introduced, true);
  assert.equal(report.providers[0]!.currentMeetsRequirement, true); assert.equal(report.providers[0]!.targetMeetsRequirement, true);
});

test('declared provider version requirements distinguish old and target builds and include an explicitly selected fallback', () => {
  const state = current();
  state.providers[0]!.provider.requiresTranslatorVersion = { min: '5.5.2', reason: 'Registered auth-header requirement' };
  state.providers.push({ provider: { id: 'Fallback', label: 'Fallback', tier: ['local'], fields: [], requiresTranslatorVersion: { min: '5.5.2' } }, selected: false, fields: [] });
  state.values.push({ ...state.values[0]!, id: 'xunity.fallbackEndpoint', value: 'Fallback' });
  const report = compareTranslationConfig(schema, state, { version: '5.6.1' }, true);
  assert.equal(report.providers[0]!.currentMeetsRequirement, false); assert.equal(report.providers[0]!.targetMeetsRequirement, true);
  assert.equal(report.providers[0]!.versionRequirement!.min, '5.5.2');
  assert.deepEqual(report.providers[1]!.roles, ['fallback']); assert.equal(report.providers[1]!.selected, true);
  assert.equal(report.providers[1]!.currentMeetsRequirement, false); assert.equal(report.providers[1]!.targetMeetsRequirement, true);
});

test('provider requirements remain unconfirmed when old or target versions are unknown', () => {
  const state = current(); delete state.detected.version;
  state.providers[0]!.provider.requiresTranslatorVersion = { min: '5.5.2' };
  const unknown = compareTranslationConfig(schema, state, { version: '99.0.0' }, false).providers[0]!;
  assert.equal(unknown.currentMeetsRequirement, undefined); assert.equal(unknown.targetMeetsRequirement, undefined);
  const ambiguous = current(); ambiguous.providers[0]!.provider.requiresTranslatorVersion = { min: '5.5.2' };
  assert.equal(compareTranslationConfig(schema, ambiguous, { version: '5.6.1', currentVersions: ['5.4.5', '5.6.1'] }, true).providers[0]!.currentMeetsRequirement, undefined);
});

test('a stale Migrations tag remains a hint and cannot prove new options or old provider incompatibility', () => {
  const state = current(); state.detected.source = 'config-tag'; state.detected.confidence = 'community';
  state.providers[0]!.provider.requiresTranslatorVersion = { min: '5.5.2' };
  const report = compareTranslationConfig(schema, state, { version: '5.6.1' }, true);
  assert.equal(report.currentVersion.version, '5.4.5'); assert.equal(report.currentVersion.source, 'config-tag');
  assert.equal(report.rows.some((row) => row.introduced || ['retained', 'relocated', 'new-default'].includes(row.status)), false);
  assert.equal(report.rows.find((row) => row.id === 'removed')!.status, 'unsupported');
  assert.equal(report.providers[0]!.currentMeetsRequirement, undefined); assert.equal(report.providers[0]!.targetMeetsRequirement, true);
});

test('large unknown-key lists retain accurate counts while bounding the public report and omitting all values', () => {
  const state = current(); state.unknown = Array.from({ length: 207 }, (_, index) => ({ section: 'Other', key: `Option${index}`, value: 'private-value-never-returned' }));
  const report = compareTranslationConfig(schema, state, { version: '5.6.1' }, true);
  assert.equal(report.unknownKeyCount, 207); assert.equal(report.unknownKeys.length, 200); assert.equal(report.unknownKeysTruncated, true);
  assert.equal(JSON.stringify(report).includes('private-value-never-returned'), false);
  const largeVersion = current(); largeVersion.detected.version = '1'.repeat(65) + '.0';
  assert.equal(compareTranslationConfig(schema, largeVersion, { version: '5.6.1' }, true).currentVersion.version, undefined);
});

test('comparison emits no credential, service URL, AppId or unknown values while retaining safe numeric and boolean options', () => {
  const report = compareTranslationConfig(schema, current(), { version: '5.6.1', variantId: 'bepinex' }, true);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['synthetic-default-secret', 'synthetic-current-secret', 'provider-secret-do-not-send', 'private-query-token', 'private-app-id', 'unknown-secret-not-in-report']) assert.equal(serialized.includes(forbidden), false);
  const secret = report.rows.find((row) => row.id === 'credential')!;
  assert.equal(secret.configured, true); assert.equal(secret.currentValue, undefined); assert.equal(secret.targetDefault, undefined);
  const fields = report.providers[0]!.fields;
  assert.equal(fields.find((field) => field.key === 'Url')!.configured, true);
  assert.equal(fields.find((field) => field.key === 'Url')!.currentValue, undefined);
  assert.equal(fields.find((field) => field.key === 'Enabled')!.currentValue, 'True');
  assert.equal(fields.find((field) => field.key === 'Delay')!.currentValue, '0.4');
  assert.deepEqual(report.unknownKeys, [{ section: 'Private', key: 'Authorization' }]);
  const invalid = current(); invalid.providers[0]!.fields.find((field) => field.key === 'Delay')!.value = '999';
  assert.equal(compareTranslationConfig(schema, invalid, { version: '5.6.1' }, true).providers[0]!.fields.find((field) => field.key === 'Delay')!.currentValue, undefined);
});

test('a target variant config-file move is disclosed without copying or claiming the target will consume old settings', () => {
  const report = compareTranslationConfig(schema, current(), { version: '5.6.1', variantId: 'melonmod' }, true);
  assert.equal(report.configPathChanged, true);
  assert.deepEqual(report.targetConfigFile, { path: 'UserData/AutoTranslatorConfig.ini', confidence: 'community' });
  assert.equal(report.configFile.preservedByReinstall, true);
  assert.equal(report.rows.find((row) => row.id === 'retained')!.status, 'relocated');
  assert.equal(report.rows.find((row) => row.id === 'retained')!.targetLocation!.file, 'UserData/AutoTranslatorConfig.ini');
});

function game(name: string, ini?: string): string {
  const root = path.join(temporary, name);
  const write = (relative: string, bytes: string | Buffer) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const executable = Buffer.alloc(512); executable.writeUInt16LE(0x5a4d); executable.writeUInt32LE(0x80, 0x3c); executable.writeUInt32LE(0x4550, 0x80); executable.writeUInt16LE(0x8664, 0x84);
  write('Game.exe', executable); write('UnityPlayer.dll', 'stub'); write('Game_Data/globalgamemanagers', '2021.3.16f1'); write('Game_Data/Managed/Assembly-CSharp.dll', 'stub');
  write('BepInEx/core/BepInEx.dll', 'stub'); write('BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll', 'stub');
  if (ini !== undefined) write('BepInEx/config/AutoTranslatorConfig.ini', ini);
  return root;
}
const fixture = '[Service]\nEndpoint=DeepLTranslateLegitimate\n[General]\nLanguage=ko\nFromLanguage=ja\n[DeepLLegitimate]\nApiKey=synthetic-file-secret\nFree=True\n[Migrations]\nTag=5.5.2\n[Other]\nAuthorization=unknown-file-secret\n';

test('read-only builder reports real partial schema coverage and target additions without changing game bytes', async () => {
  const root = game('readonly', fixture), profile = detectGame(registry, root)!;
  const file = path.join(root, 'BepInEx/config/AutoTranslatorConfig.ini'), before = fs.readFileSync(file);
  const report = await buildTranslationConfigComparison(registry, profile, { version: '5.6.1', variantId: 'bepinex', currentVersions: ['5.5.2'] });
  assert.equal(report.available, true); assert.equal(report.targetRegistered, true); assert.equal(report.currentVersion.version, '5.5.2');
  assert.equal(report.currentVersion.source, 'config-tag'); assert.equal(report.currentVersion.confidence, 'community');
  assert.equal(report.rows.find((row) => row.id === 'xunity.enableUIElements')!.introduced, false);
  assert.equal(report.rows.find((row) => row.id === 'xunity.enableUIElements')!.status, 'unmapped');
  assert.equal(report.rows.find((row) => row.id === 'xunity.targetLanguage')!.currentValue, 'ko');
  assert.equal(report.rows.find((row) => row.id === 'xunity.targetLanguage')!.targetDefault, 'en');
  assert.equal(JSON.stringify(report).includes('synthetic-file-secret'), false); assert.equal(JSON.stringify(report).includes('unknown-file-secret'), false);
  assert.equal(report.providers.find((provider) => provider.id === 'DeepLTranslateLegitimate')!.fields.find((field) => field.key === 'Free')!.currentValue, 'True');
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(root, '.indiedeck/backups')), false);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), crypto.createHash('sha256').update(before).digest('hex'));
  const unavailableTarget = await buildTranslationConfigComparison(registry, profile, { version: '99.0.0', variantId: 'bepinex' });
  assert.equal(unavailableTarget.targetRegistered, false); assert.equal(unavailableTarget.rows.every((row) => row.status === 'unmapped'), true);
});

test('missing configs and absent schemas have honest read-only report states', async () => {
  const profile = detectGame(registry, game('missing'))!;
  const report = await buildTranslationConfigComparison(registry, profile, { version: '5.6.1', variantId: 'bepinex' });
  assert.equal(report.available, true); assert.equal(report.configFile.exists, false); assert.equal(report.currentVersion.source, 'unknown');
  assert.equal(report.rows.some((row) => row.status === 'relocated'), false);
  const absent = await buildTranslationConfigComparison({ ...registry, configSchemas: new Map() }, profile, { version: '5.6.1' });
  assert.equal(absent.available, false); assert.equal(absent.reasonKey, 'ui.configComparison.reason.schemaUnavailable');
});

test('comparison refuses linked config ancestry without reading or changing the linked target', async (context) => {
  const root = game('linked'), outside = path.join(temporary, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'AutoTranslatorConfig.ini'), fixture);
  try { fs.symlinkSync(outside, path.join(root, 'BepInEx/config'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { context.skip('Local directory link privilege unavailable'); return; }
  const report = await buildTranslationConfigComparison(registry, detectGame(registry, root)!, { version: '5.6.1', variantId: 'bepinex' });
  assert.equal(report.available, false); assert.equal(report.reasonKey, 'ui.configComparison.reason.readUnavailable');
  assert.equal(fs.readFileSync(path.join(outside, 'AutoTranslatorConfig.ini'), 'utf8'), fixture);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ConfigSchema } from '../src/index.ts';
import type { TranslationConfigComparison } from '../../desktop/src/translation-config-comparison.ts';
import { TRANSLATION_CONFIG_HISTORY_FILE, TranslationConfigHistory, TranslationConfigHistoryError } from '../../desktop/src/translation-config-history.ts';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'indiedeck-config-history-'));
after(async () => { assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); await fs.rm(temporary, { recursive: true, force: true }); });
const schema: ConfigSchema = {
  schemaVersion: 1, translator: 'xunity-autotranslator', versionDetection: { order: [] }, categories: [],
  configLocations: [{ variant: 'bepinex', path: 'BepInEx/config/AutoTranslatorConfig.ini', confidence: 'verified' }],
  settings: [
    { id: 'xunity.targetLanguage', ui: { label: 'Target language', category: 'basic', type: 'language' }, versions: [{ section: 'General', key: 'Language' }], default: 'en' },
    { id: 'xunity.endpoint', ui: { label: 'Engine', category: 'basic', type: 'provider-select' }, versions: [{ section: 'General', key: 'Endpoint' }], default: 'GoogleTranslate' },
    { id: 'xunity.boolean', ui: { label: 'Toggle', category: 'basic', type: 'boolean' }, versions: [{ section: 'General', key: 'Toggle' }], default: 'True' },
    { id: 'xunity.count', ui: { label: 'Count', category: 'basic', type: 'integer', min: 1, max: 100 }, versions: [{ section: 'General', key: 'Count' }], default: '1' },
    { id: 'xunity.choice', ui: { label: 'Choice', category: 'basic', type: 'enum', options: ['one', 'two'] }, versions: [{ section: 'General', key: 'Choice' }], default: 'one' },
    { id: 'xunity.directory', ui: { label: 'Directory', category: 'files', type: 'directory' }, versions: [{ section: 'Files', key: 'Directory' }], default: 'Translation' },
    { id: 'xunity.string', ui: { label: 'Text', category: 'files', type: 'string' }, versions: [{ section: 'Files', key: 'Text' }], default: 'text' },
    { id: 'xunity.apiKey', ui: { label: 'API key', category: 'credentials', type: 'secret' }, versions: [{ section: 'Service', key: 'ApiKey' }] },
  ],
  providers: [{ id: 'GoogleTranslate', label: 'Google', tier: [], requiresTranslatorVersion: { min: '5.0.0', reason: 'Registered requirement' }, fields: [
    { key: 'ApiKey', label: 'API key', type: 'secret' }, { key: 'Url', label: 'URL', type: 'string' },
    { key: 'Enabled', label: 'Enabled', type: 'boolean' }, { key: 'Delay', label: 'Delay', type: 'number', min: 0, max: 60 },
  ] }],
};
const id = (n: number) => n.toString(16).padStart(16, '0');
async function fixture(name: string) { const dir = path.join(temporary, name); await fs.mkdir(dir); return dir; }
function report(language = 'ko'): TranslationConfigComparison {
  const values = [language, 'GoogleTranslate', 'False', '4', 'two', 'C:\\private\\game', 'https://private.invalid/?token=private-secret', 'synthetic-credential'];
  return {
    available: true, translatorId: schema.translator, currentVersion: { version: '5.4.0', source: 'assembly', confidence: 'verified', ambiguous: false },
    targetVersion: '5.6.1', targetVariantId: 'bepinex', targetRegistered: true,
    configFile: { path: schema.configLocations[0]!.path, exists: true, preservedByReinstall: true, pathChanged: false }, configPathChanged: false,
    coverage: { described: 8, total: 9, schemaSettings: 8, targetMapped: 8 },
    rows: schema.settings.map((setting, i) => ({ id: setting.id, label: 'untrusted-label-private-secret', category: setting.ui.category, type: setting.ui.type,
      currentValue: values[i], targetDefault: setting.default, status: 'retained', isSecret: setting.ui.type === 'secret', configured: true, introduced: false,
      currentPresent: true, customValue: true, currentLocation: { section: setting.versions[0]!.section, key: setting.versions[0]!.key, confidence: 'verified', assumed: false, file: schema.configLocations[0]!.path } })),
    providers: [{ id: 'GoogleTranslate', label: 'private-provider-label', selected: true, roles: ['primary'],
      versionRequirement: { min: '5.0.0', reason: 'private-reason' }, currentMeetsRequirement: true, targetMeetsRequirement: true,
      fields: [
        { key: 'ApiKey', label: 'private-label', type: 'secret', isSecret: true, configured: true, currentValue: 'secret-that-must-not-persist' },
        { key: 'Url', label: 'private-label', type: 'string', isSecret: false, configured: true, currentValue: 'https://private.invalid/?token=private-secret' },
        { key: 'Enabled', label: 'Enabled', type: 'boolean', isSecret: false, configured: true, currentValue: 'True' },
        { key: 'Delay', label: 'Delay', type: 'number', isSecret: false, configured: true, currentValue: '0.4' },
      ] }],
    unknownKeys: [{ section: 'unknown-private-section', key: 'unknown-private-token' }], unknownKeyCount: 1, unknownKeysTruncated: false,
    summary: { retained: 8, relocated: 0, newDefaults: 0, unsupported: 0, unmapped: 0 }, preservesConfig: true, migrationSimulated: false,
  };
}

test('latest safe comparison survives a new store instance without opening a game folder', async () => {
  const dir = await fixture('restart'), first = new TranslationConfigHistory(dir, schema);
  assert.deepEqual(await first.get(id(1)), { state: 'ready' });
  const saved = await first.save(id(1), report());
  assert.equal(saved.gameId, id(1)); assert.ok(Number.isFinite(Date.parse(saved.recordedAt)));
  const next = await new TranslationConfigHistory(dir, schema).get(id(1));
  assert.equal(next.state, 'ready'); assert.equal(next.record?.report.rows[0]!.currentValue, 'ko');
  assert.deepEqual(next.record?.hiddenValueIds, ['xunity.directory', 'xunity.string']);
  assert.equal((await fs.readdir(dir)).length, 1);
});

test('disk projection removes credentials, private paths, arbitrary text, unknown names and extra properties', async () => {
  const dir = await fixture('privacy'), source = report();
  Object.assign(source, { privateExtra: 'private-top-level-secret' });
  Object.assign(source.rows[0]!, { privateExtra: 'private-row-secret' });
  source.configFile.path = 'C:\\private\\game\\config.ini';
  source.rows[0]!.currentLocation!.file = 'C:\\private\\game\\config.ini';
  source.rows[0]!.currentLocation!.section = 'unregistered-private-section';
  await new TranslationConfigHistory(dir, schema).save(id(2), source);
  const text = await fs.readFile(path.join(dir, TRANSLATION_CONFIG_HISTORY_FILE), 'utf8');
  assert.doesNotMatch(text, /private|synthetic-credential|secret-that-must-not|https:|C:\\\\|unknown-private/);
  const persisted = JSON.parse(text).records[0];
  assert.equal(persisted.report.configFile.path, ''); assert.equal(persisted.report.rows[0].currentLocation, undefined);
  assert.equal(persisted.report.rows[0].label, '');
  assert.equal(persisted.report.providers[0].versionRequirement.reason, undefined);
  assert.equal(persisted.report.rows.find((row: { id: string }) => row.id === 'xunity.apiKey').currentValue, undefined);
  assert.equal(persisted.report.providers[0].fields.find((field: { key: string }) => field.key === 'Url').currentValue, undefined);
  assert.equal(persisted.report.providers[0].fields.find((field: { key: string }) => field.key === 'Enabled').currentValue, 'True');
  assert.equal(persisted.report.providers[0].fields.find((field: { key: string }) => field.key === 'Delay').currentValue, '0.4');
  assert.equal(persisted.report.unknownKeyCount, 1); assert.deepEqual(persisted.report.unknownKeys, []);
});

test('only safe declared values persist, including engine identity, numeric bounds and enum membership', async () => {
  const dir = await fixture('safe-values'), store = new TranslationConfigHistory(dir, schema);
  const source = report('credential-instead-of-language');
  source.rows[1]!.currentValue = 'https://private.invalid/'; source.rows[2]!.currentValue = 'true?token=secret';
  source.rows[3]!.currentValue = '100000000000'; source.rows[4]!.currentValue = 'unregistered';
  source.providers[0]!.fields.find((field) => field.key === 'Delay')!.currentValue = '120';
  const saved = await store.save(id(3), source);
  assert.ok(source.rows.slice(0, 5).every((row) => saved.hiddenValueIds.includes(row.id)));
  assert.ok(saved.report.rows.slice(0, 5).every((row) => row.currentValue === undefined && row.targetDefault === undefined));
  assert.equal(saved.report.providers[0]!.fields.find((field) => field.key === 'Delay')!.currentValue, undefined);
});

test('new comparisons replace one game and retention evicts oldest other games at twenty', async () => {
  const dir = await fixture('retention'), store = new TranslationConfigHistory(dir, schema);
  for (let game = 1; game <= 20; game++) await store.save(id(game), report());
  await store.save(id(1), report('ja')); await store.save(id(21), report());
  assert.equal((await store.get(id(2))).record, undefined);
  assert.equal((await store.get(id(1))).record!.report.rows[0]!.currentValue, 'ja');
  const stored = JSON.parse(await fs.readFile(path.join(dir, TRANSLATION_CONFIG_HISTORY_FILE), 'utf8'));
  assert.equal(stored.records.length, 20); assert.equal(stored.records.filter((record: { gameId: string }) => record.gameId === id(1)).length, 1);
});

test('concurrent saves across instances serialize without losing unrelated records and a failed mutation unlocks the queue', async () => {
  const dir = await fixture('queue'), a = new TranslationConfigHistory(dir, schema), b = new TranslationConfigHistory(dir, schema);
  await Promise.all(Array.from({ length: 10 }, (_, n) => (n % 2 ? a : b).save(id(n), report())));
  await assert.rejects(a.save('../invalid', report()), TranslationConfigHistoryError);
  await b.save(id(10), report());
  for (let n = 0; n <= 10; n++) assert.equal((await a.get(id(n))).record?.gameId, id(n));
});

test('removing one history record survives restart and does not change another game or create a missing store', async () => {
  const dir = await fixture('remove'), store = new TranslationConfigHistory(dir, schema);
  await store.remove(id(1)); assert.deepEqual(await fs.readdir(dir), []);
  await store.save(id(1), report()); await store.save(id(2), report('ja')); await store.remove(id(1));
  const restarted = new TranslationConfigHistory(dir, schema);
  assert.equal((await restarted.get(id(1))).record, undefined); assert.equal((await restarted.get(id(2))).record?.report.rows[0]!.currentValue, 'ja');
});

test('damaged and oversized history preserve exact bytes and block saving and removal', async () => {
  for (const [name, contents, reason] of [['json', '{"schemaVersion":1,', 'corrupt'], ['oversize', 'x'.repeat(2 * 1024 * 1024 + 1), 'too-large']] as const) {
    const dir = await fixture(name), file = path.join(dir, TRANSLATION_CONFIG_HISTORY_FILE), store = new TranslationConfigHistory(dir, schema);
    await fs.writeFile(file, contents);
    assert.deepEqual(await store.get(id(1)), { state: 'unavailable', reason });
    for (const action of [() => store.save(id(1), report()), () => store.remove(id(1))]) await assert.rejects(action(), (error: unknown) => error instanceof TranslationConfigHistoryError && error.reason === reason && !error.message.includes(dir));
    assert.equal(await fs.readFile(file, 'utf8'), contents); assert.deepEqual(await fs.readdir(dir), [TRANSLATION_CONFIG_HISTORY_FILE]);
  }
});

test('schema-invalid stored JSON cannot inject labels, values, extra keys or false hidden-value evidence', async () => {
  const seedDir = await fixture('schema-seed'), seed = new TranslationConfigHistory(seedDir, schema);
  await seed.save(id(1), report());
  const original = JSON.parse(await fs.readFile(path.join(seedDir, TRANSLATION_CONFIG_HISTORY_FILE), 'utf8'));
  const mutations = [
    (value: typeof original) => { value.records[0].report.rows[0].label = 'private-label'; },
    (value: typeof original) => { value.records[0].report.rows[0].currentValue = 'secret-in-language'; },
    (value: typeof original) => { value.records[0].report.privateProperty = 'credential'; },
    (value: typeof original) => { value.records[0].hiddenValueIds.push('xunity.targetLanguage'); },
    (value: typeof original) => { value.records[0].recordedAt = 'not-a-timestamp'; },
    (value: typeof original) => { value.records.push(value.records[0]); },
    (value: typeof original) => { value.schemaVersion = 2; },
  ];
  for (let n = 0; n < mutations.length; n++) {
    const dir = await fixture(`invalid-${n}`), value = structuredClone(original); mutations[n]!(value);
    const text = JSON.stringify(value), file = path.join(dir, TRANSLATION_CONFIG_HISTORY_FILE); await fs.writeFile(file, text);
    const store = new TranslationConfigHistory(dir, schema);
    assert.equal((await store.get(id(1))).state, 'unavailable'); await assert.rejects(store.save(id(2), report()), TranslationConfigHistoryError);
    assert.equal(await fs.readFile(file, 'utf8'), text);
  }
});

test('linked history ancestry and linked files are refused without reading or changing targets', async (context) => {
  const external = await fixture('external'), normal = await fixture('links');
  const externalFile = path.join(external, TRANSLATION_CONFIG_HISTORY_FILE), contents = 'sensitive-external-bytes'; await fs.writeFile(externalFile, contents);
  const link = path.join(normal, 'directory-link'); await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new TranslationConfigHistory(path.join(link, 'nested'), schema);
  assert.equal((await store.get(id(1))).reason, 'unsafe'); await assert.rejects(store.save(id(1), report()), TranslationConfigHistoryError);
  assert.equal(await fs.readFile(externalFile, 'utf8'), contents); assert.deepEqual(await fs.readdir(external), [TRANSLATION_CONFIG_HISTORY_FILE]);
  const hardDir = await fixture('hardlink'), hardFile = path.join(hardDir, TRANSLATION_CONFIG_HISTORY_FILE); await fs.link(externalFile, hardFile);
  const hardStore = new TranslationConfigHistory(hardDir, schema);
  assert.equal((await hardStore.get(id(1))).reason, 'unsafe'); await assert.rejects(hardStore.remove(id(1)), TranslationConfigHistoryError);
  assert.equal(await fs.readFile(externalFile, 'utf8'), contents);
  const fileDir = await fixture('file-link');
  try { await fs.symlink(externalFile, path.join(fileDir, TRANSLATION_CONFIG_HISTORY_FILE)); }
  catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { context.diagnostic('File symlinks unavailable; junction and hard-link refusal verified.'); return; } throw error; }
  const fileStore = new TranslationConfigHistory(fileDir, schema);
  assert.equal((await fileStore.get(id(1))).reason, 'unsafe'); await assert.rejects(fileStore.save(id(1), report()), TranslationConfigHistoryError);
  assert.equal(await fs.readFile(externalFile, 'utf8'), contents);
});

test('caller mutation after reading cannot alter the stored report', async () => {
  const dir = await fixture('clone'), store = new TranslationConfigHistory(dir, schema);
  const saved = await store.save(id(1), report()); saved.report.rows[0]!.currentValue = 'ja';
  const first = await store.get(id(1)); first.record!.report.rows[0]!.currentValue = 'en';
  assert.equal((await store.get(id(1))).record!.report.rows[0]!.currentValue, 'ko');
});

test('cosmetic schema labels and requirement explanations can change without invalidating saved history', async () => {
  const dir = await fixture('new-labels'), store = new TranslationConfigHistory(dir, schema);
  await store.save(id(1), report());
  const file = path.join(dir, TRANSLATION_CONFIG_HISTORY_FILE), before = await fs.readFile(file);
  const nextSchema = structuredClone(schema);
  nextSchema.settings[0]!.ui.label = 'Updated target label';
  nextSchema.providers[0]!.label = 'Updated engine label';
  nextSchema.providers[0]!.fields[0]!.label = 'Updated credential label';
  nextSchema.providers[0]!.requiresTranslatorVersion!.reason = 'Updated version explanation';
  const result = await new TranslationConfigHistory(dir, nextSchema).get(id(1));
  assert.equal(result.state, 'ready');
  assert.equal(result.record!.report.rows[0]!.label, 'Updated target label');
  assert.equal(result.record!.report.providers[0]!.label, 'Updated engine label');
  assert.equal(result.record!.report.providers[0]!.fields[0]!.label, 'Updated credential label');
  assert.equal(result.record!.report.providers[0]!.versionRequirement!.reason, 'Updated version explanation');
  assert.deepEqual(await fs.readFile(file), before);
});

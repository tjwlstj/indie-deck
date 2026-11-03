import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { tRegistry, type ConfigSchema, type SettingDef } from '@indiedeck/core';
import type { TranslationConfigComparison, TranslationConfigComparisonLocation } from './translation-config-comparison.ts';

export const TRANSLATION_CONFIG_HISTORY_FILE = 'translation-option-history.json';
export const TRANSLATION_CONFIG_HISTORY_LIMIT = 20;
const BYTE_LIMIT = 2 * 1024 * 1024;
const GAME_ID = /^[0-9a-f]{16}$/;
const VERSION = /^\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.]+)?$/;
const CONFIDENCE = ['verified', 'inferred', 'community', 'unverified'];
const SOURCES = ['receipt', 'assembly', 'config-tag', 'unknown'];
const STATUS = ['retained', 'relocated', 'new-default', 'unsupported', 'unmapped'];
const queues = new Map<string, Promise<void>>();
export type TranslationConfigHistoryReason = 'corrupt' | 'unsafe' | 'too-large' | 'io';
export class TranslationConfigHistoryError extends Error {
  readonly reason: TranslationConfigHistoryReason;
  constructor(reason: TranslationConfigHistoryReason) { super(`translation-option-history:${reason}`); this.reason = reason; }
}
export interface TranslationConfigHistoryRecord {
  gameId: string; recordedAt: string; report: TranslationConfigComparison; hiddenValueIds: string[];
}
export interface TranslationConfigHistoryResult {
  state: 'ready' | 'unavailable'; record?: TranslationConfigHistoryRecord; reason?: TranslationConfigHistoryReason;
}
interface Snapshot { schemaVersion: 1; records: TranslationConfigHistoryRecord[] }
interface Loaded { snapshot: Snapshot; fingerprint?: string }
function fail(reason: TranslationConfigHistoryReason = 'corrupt'): never { throw new TranslationConfigHistoryError(reason); }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) fail(); return value as number; }
function release(value: unknown): string | undefined { return typeof value === 'string' && value.length <= 64 && VERSION.test(value) ? value : undefined; }
function choice(value: unknown, choices: string[], fallback: string): string { return typeof value === 'string' && choices.includes(value) ? value : fallback; }
function optionalBool(target: object, source: Record<string, unknown>, key: string): void {
  if (typeof source[key] === 'boolean') Object.assign(target, { [key]: source[key] });
}
function safeValue(value: unknown, setting: SettingDef, schema: ConfigSchema): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  const ui = setting.ui;
  if (ui.type === 'boolean') return /^(?:true|false)$/i.test(value);
  if (ui.type === 'language') return /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(value) || setting.id === 'xunity.sourceLanguage' && value === 'auto';
  if (ui.type === 'provider-select') return value === '' && ui.allowEmpty === true || schema.providers.some((item) => item.id === value);
  if (ui.type === 'enum') return ui.options?.includes(value) === true;
  if (ui.type === 'integer' || ui.type === 'number') {
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) return false;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= 1e9 && (ui.type !== 'integer' || Number.isInteger(number)) &&
      (ui.min === undefined || number >= ui.min) && (ui.max === undefined || number <= ui.max);
  }
  return false;
}
function relativeFile(value: unknown, schema: ConfigSchema): string | undefined {
  return typeof value === 'string' && schema.configLocations.some((item) => item.path === value) ? value : undefined;
}
function location(value: unknown, setting: SettingDef, schema: ConfigSchema): TranslationConfigComparisonLocation | undefined {
  if (!object(value) || !setting.versions.some((item) => item.section === value.section && item.key === value.key)) return undefined;
  const file = relativeFile(value.file, schema);
  return { section: value.section as string, key: value.key as string, assumed: bool(value.assumed),
    confidence: choice(value.confidence, CONFIDENCE, 'unverified'), ...(file ? { file } : {}) };
}

/** Disk projection uses schema-owned labels/locations and bounded semantic
 * values only. Text, paths, credentials, unknown names and unknown fields never
 * enter the file. Reports remain review data, never installation authority. */
function project(input: unknown, schema: ConfigSchema): { report: TranslationConfigComparison; hiddenValueIds: string[] } {
  if (!object(input) || input.translatorId !== schema.translator || !object(input.currentVersion) || !object(input.configFile) ||
    !object(input.coverage) || !Array.isArray(input.rows) || input.rows.length > 500 || !Array.isArray(input.providers) || input.providers.length > 100) fail();
  const current = input.currentVersion, config = input.configFile, coverage = input.coverage;
  const currentVersion = release(current.version), targetVersion = release(input.targetVersion);
  const currentPath = relativeFile(config.path, schema) ?? '', targetPath = relativeFile(config.targetPath, schema);
  const targetFile = object(input.targetConfigFile) ? relativeFile(input.targetConfigFile.path, schema) : undefined;
  const variant = schema.configLocations.find((item) => item.variant === input.targetVariantId)?.variant;
  const report: TranslationConfigComparison = {
    available: bool(input.available), translatorId: schema.translator,
    currentVersion: { ...(currentVersion ? { version: currentVersion } : {}), source: choice(current.source, SOURCES, 'unknown'),
      confidence: choice(current.confidence, CONFIDENCE, 'unverified'), ambiguous: bool(current.ambiguous) },
    ...(targetVersion ? { targetVersion } : {}), ...(variant ? { targetVariantId: variant } : {}), targetRegistered: bool(input.targetRegistered),
    configFile: { path: currentPath, exists: bool(config.exists), preservedByReinstall: true, pathChanged: bool(config.pathChanged), ...(targetPath ? { targetPath } : {}) },
    ...(targetFile ? { targetConfigFile: { path: targetFile, confidence: choice((input.targetConfigFile as Record<string, unknown>).confidence, CONFIDENCE, 'unverified') } } : {}),
    configPathChanged: bool(input.configPathChanged),
    coverage: { described: count(coverage.described), total: count(coverage.total), schemaSettings: count(coverage.schemaSettings), targetMapped: count(coverage.targetMapped) },
    rows: [], providers: [], unknownKeys: [], unknownKeyCount: count(input.unknownKeyCount), unknownKeysTruncated: count(input.unknownKeyCount) > 0,
    summary: { retained: 0, relocated: 0, newDefaults: 0, unsupported: 0, unmapped: 0 }, preservesConfig: true, migrationSimulated: false,
  };
  if (input.reasonKey === 'ui.configComparison.reason.schemaUnavailable' || input.reasonKey === 'ui.configComparison.reason.readUnavailable') report.reasonKey = input.reasonKey;
  const hiddenValueIds: string[] = [], seen = new Set<string>();
  for (const value of input.rows) {
    if (!object(value)) fail();
    const setting = schema.settings.find((item) => item.id === value.id);
    if (!setting || seen.has(setting.id)) continue;
    seen.add(setting.id);
    const secret = setting.ui.type === 'secret' || /secret|token|password|credential|api.?key|authorization/i.test(setting.id + ' ' + setting.versions.map((item) => item.key).join(' '));
    const row: TranslationConfigComparison['rows'][number] = {
      id: setting.id, label: '', category: setting.ui.category, type: setting.ui.type,
      status: choice(value.status, STATUS, 'unmapped') as TranslationConfigComparison['rows'][number]['status'], isSecret: secret, introduced: bool(value.introduced),
    };
    const currentLocation = location(value.currentLocation, setting, schema), targetLocation = location(value.targetLocation, setting, schema);
    if (currentLocation) row.currentLocation = currentLocation;
    if (targetLocation) row.targetLocation = targetLocation;
    for (const key of ['configured', 'customValue', 'currentIsDefault', 'currentPresent']) optionalBool(row, value, key);
    if (!secret) {
      const hidden = value.currentValue !== undefined && !safeValue(value.currentValue, setting, schema) || value.targetDefault !== undefined && !safeValue(value.targetDefault, setting, schema);
      if (hidden) hiddenValueIds.push(setting.id);
      else {
        if (typeof value.currentValue === 'string') row.currentValue = value.currentValue;
        if (typeof value.targetDefault === 'string') row.targetDefault = value.targetDefault;
      }
    }
    report.rows.push(row);
    report.summary[row.status === 'new-default' ? 'newDefaults' : row.status] += 1;
  }
  for (const value of input.providers) {
    if (!object(value) || !Array.isArray(value.fields) || value.fields.length > 100) fail();
    const definition = schema.providers.find((item) => item.id === value.id);
    if (!definition || report.providers.some((item) => item.id === definition.id)) continue;
    const provider: TranslationConfigComparison['providers'][number] = { id: definition.id, label: '', selected: bool(value.selected),
      roles: Array.isArray(value.roles) ? [...new Set(value.roles.filter((role): role is 'primary' | 'fallback' => role === 'primary' || role === 'fallback'))] : [], fields: [] };
    if (object(value.versionRequirement)) {
      const min = release(value.versionRequirement.min), max = release(value.versionRequirement.max);
      provider.versionRequirement = { ...(min ? { min } : {}), ...(max ? { max } : {}) };
      optionalBool(provider, value, 'currentMeetsRequirement'); optionalBool(provider, value, 'targetMeetsRequirement');
    }
    for (const raw of value.fields) {
      if (!object(raw)) fail();
      const field = definition.fields.find((item) => item.key === raw.key);
      if (!field || provider.fields.some((item) => item.key === field.key)) continue;
      const entry: TranslationConfigComparison['providers'][number]['fields'][number] = { key: field.key, label: '', type: field.type,
        isSecret: field.type === 'secret', configured: bool(raw.configured) };
      optionalBool(entry, raw, 'present');
      if ((field.type === 'boolean' || field.type === 'number') && safeValue(raw.currentValue,
        { id: field.key, ui: { label: field.label, category: '', type: field.type, min: field.min, max: field.max }, versions: [] }, schema)) entry.currentValue = raw.currentValue;
      provider.fields.push(entry);
    }
    report.providers.push(provider);
  }
  return { report, hiddenValueIds };
}

function validate(input: unknown, schema: ConfigSchema): Snapshot {
  if (!object(input) || input.schemaVersion !== 1 || !Array.isArray(input.records) || input.records.length > TRANSLATION_CONFIG_HISTORY_LIMIT ||
    Object.keys(input).some((key) => !['schemaVersion', 'records'].includes(key))) fail();
  const ids = new Set<string>(), records: TranslationConfigHistoryRecord[] = [];
  for (const raw of input.records) {
    if (!object(raw) || typeof raw.gameId !== 'string' || !GAME_ID.test(raw.gameId) || ids.has(raw.gameId) ||
      typeof raw.recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.recordedAt) ||
      !Number.isFinite(Date.parse(raw.recordedAt)) || !Array.isArray(raw.hiddenValueIds) || raw.hiddenValueIds.length > 500 ||
      raw.hiddenValueIds.some((id) => typeof id !== 'string' || !schema.settings.some((setting) => setting.id === id)) ||
      new Set(raw.hiddenValueIds).size !== raw.hiddenValueIds.length || Object.keys(raw).some((key) => !['gameId', 'recordedAt', 'report', 'hiddenValueIds'].includes(key))) fail();
    const projected = project(raw.report, schema);
    if (!isDeepStrictEqual(projected.report, raw.report)) fail();
    // Redaction is irreversible on disk. An explicitly hidden row has no values.
    if (raw.hiddenValueIds.some((id) => !projected.report.rows.some((row) => row.id === id && !row.isSecret && row.currentValue === undefined && row.targetDefault === undefined))) fail();
    ids.add(raw.gameId); records.push({ gameId: raw.gameId, recordedAt: raw.recordedAt, report: projected.report, hiddenValueIds: raw.hiddenValueIds as string[] });
  }
  return { schemaVersion: 1, records };
}
function localized(record: TranslationConfigHistoryRecord, schema: ConfigSchema): TranslationConfigHistoryRecord {
  const result = structuredClone(record);
  for (const row of result.report.rows) row.label = tRegistry(`configSchema.${result.report.translatorId}.settings.${row.id}.label`, schema.settings.find((item) => item.id === row.id)?.ui.label ?? row.id);
  for (const provider of result.report.providers) {
    const definition = schema.providers.find((item) => item.id === provider.id);
    provider.label = tRegistry(`configSchema.${result.report.translatorId}.providers.${provider.id}.label`, definition?.label ?? provider.id);
    for (const field of provider.fields) field.label = tRegistry(`configSchema.${result.report.translatorId}.providers.${provider.id}.fields.${field.key}.label`, definition?.fields.find((item) => item.key === field.key)?.label ?? field.key);
    // Only rehydrate a current explanation when it still describes the saved
    // version range. Historical ranges themselves remain unchanged.
    if (provider.versionRequirement && definition?.requiresTranslatorVersion?.reason &&
      provider.versionRequirement.min === definition.requiresTranslatorVersion.min && provider.versionRequirement.max === definition.requiresTranslatorVersion.max) {
      provider.versionRequirement.reason = tRegistry(`configSchema.${result.report.translatorId}.providers.${provider.id}.requiresTranslatorVersion.reason`, definition.requiresTranslatorVersion.reason);
    }
  }
  return result;
}
function sanitized(error: unknown): TranslationConfigHistoryError {
  return error instanceof TranslationConfigHistoryError ? error : new TranslationConfigHistoryError('io');
}
async function directory(target: string, create = false): Promise<boolean> {
  if (!path.isAbsolute(target) || /^\\\\[?.]\\/.test(target) || target.includes('\0')) fail('unsafe');
  const resolved = path.resolve(target), root = path.parse(resolved).root;
  let cursor = root;
  const ancestors = [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean).map((part) => { cursor = path.join(cursor, part); return cursor; })];
  for (const ancestor of ancestors) {
    let stat;
    try { stat = await fs.lstat(ancestor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fs.mkdir(ancestor); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(ancestor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe');
  }
  return true;
}

/** Opaque game ids identify the latest review only. No game folder is opened.
 * Every operation shares a process-local queue, including across store objects. */
export class TranslationConfigHistory {
  private readonly dataDir: string;
  private readonly schema: ConfigSchema;
  constructor(dataDir: string, schema: ConfigSchema) { this.dataDir = dataDir; this.schema = structuredClone(schema); }
  private queue<T>(action: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.dataDir).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(action, action), settled = result.then(() => {}, () => {});
    queues.set(key, settled);
    void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return result;
  }
  private async read(): Promise<Loaded> {
    if (!await directory(this.dataDir)) return { snapshot: { schemaVersion: 1, records: [] } };
    const file = path.join(this.dataDir, TRANSLATION_CONFIG_HISTORY_FILE);
    let before;
    try { before = await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { snapshot: { schemaVersion: 1, records: [] } }; throw error; }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) fail('unsafe');
    if (before.size > BYTE_LIMIT) fail('too-large');
    const handle = await fs.open(file, 'r');
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) fail('unsafe');
      const buffer = Buffer.alloc(BYTE_LIMIT + 1); let size = 0;
      while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
      if (size > BYTE_LIMIT) fail('too-large');
      bytes = buffer.subarray(0, size);
    } finally { await handle.close(); }
    await directory(this.dataDir);
    const after = await fs.lstat(file);
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('unsafe');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
    return { snapshot: validate(parsed, this.schema), fingerprint: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  private async write(snapshot: Snapshot, fingerprint: string | undefined): Promise<void> {
    const text = JSON.stringify(validate(snapshot, this.schema), null, 2);
    if (Buffer.byteLength(text) > BYTE_LIMIT) fail('too-large');
    await directory(this.dataDir, true);
    const file = path.join(this.dataDir, TRANSLATION_CONFIG_HISTORY_FILE), temporary = path.join(this.dataDir, `.translation-option-history.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      // Existing corruption or an external edit cannot be laundered by a save.
      const current = await this.read();
      if (current.fingerprint !== fingerprint) fail();
      await directory(this.dataDir);
      const tempStat = await fs.lstat(temporary);
      if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== 1) fail('unsafe');
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  get(gameId: string): Promise<TranslationConfigHistoryResult> {
    return this.queue(async () => {
      try {
        if (!GAME_ID.test(gameId)) fail();
        const loaded = await this.read(), record = loaded.snapshot.records.find((item) => item.gameId === gameId);
        return { state: 'ready', ...(record ? { record: localized(record, this.schema) } : {}) };
      } catch (error) { return { state: 'unavailable', reason: sanitized(error).reason }; }
    });
  }
  save(gameId: string, report: TranslationConfigComparison): Promise<TranslationConfigHistoryRecord> {
    return this.queue(async () => {
      try {
        if (!GAME_ID.test(gameId)) fail();
        const projection = project(report, this.schema), loaded = await this.read();
        const record: TranslationConfigHistoryRecord = { gameId, recordedAt: new Date().toISOString(), ...projection };
        const records = loaded.snapshot.records.filter((item) => item.gameId !== gameId);
        records.push(record);
        await this.write({ schemaVersion: 1, records: records.slice(-TRANSLATION_CONFIG_HISTORY_LIMIT) }, loaded.fingerprint);
        return localized(record, this.schema);
      } catch (error) { throw sanitized(error); }
    });
  }
  remove(gameId: string): Promise<void> {
    return this.queue(async () => {
      try {
        if (!GAME_ID.test(gameId)) fail();
        const loaded = await this.read(), records = loaded.snapshot.records.filter((item) => item.gameId !== gameId);
        if (records.length !== loaded.snapshot.records.length) await this.write({ schemaVersion: 1, records }, loaded.fingerprint);
      } catch (error) { throw sanitized(error); }
    });
  }
}

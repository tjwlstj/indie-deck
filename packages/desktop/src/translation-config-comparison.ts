import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  readGameConfig, resolveMapping, satisfiesRange, tRegistry,
  type ConfigSchema, type GameConfig, type GameProfile, type Registry, type SettingDef,
} from '@indiedeck/core';

const TRANSLATOR = 'xunity-autotranslator';
export type TranslationConfigComparisonStatus = 'retained' | 'relocated' | 'new-default' | 'unsupported' | 'unmapped';
export interface TranslationConfigComparisonLocation {
  section: string; key: string; file?: string; assumed: boolean; confidence: string;
}
export interface TranslationConfigComparisonRow {
  id: string; label: string; category: string; type: SettingDef['ui']['type'];
  currentValue?: string; targetDefault?: string;
  currentLocation?: TranslationConfigComparisonLocation; targetLocation?: TranslationConfigComparisonLocation;
  status: TranslationConfigComparisonStatus; isSecret: boolean; configured?: boolean;
  customValue?: boolean; currentIsDefault?: boolean; currentPresent?: boolean;
  /** Only true when explicit schema availability excludes the old version. */
  introduced: boolean;
}
export interface TranslationConfigComparisonTarget { version?: string; variantId?: string; currentVersions?: string[] }
export interface TranslationConfigComparison {
  available: boolean; reasonKey?: string; translatorId: string;
  currentVersion: { version?: string; source: string; confidence: string; ambiguous: boolean };
  targetVersion?: string; targetVariantId?: string; targetRegistered: boolean;
  configFile: { path: string; exists: boolean; preservedByReinstall: true; targetPath?: string; pathChanged: boolean };
  targetConfigFile?: { path: string; confidence: string };
  configPathChanged: boolean;
  coverage: { described: number; total: number; schemaSettings: number; targetMapped: number };
  rows: TranslationConfigComparisonRow[];
  providers: { id: string; label: string; selected: boolean; roles: ('primary' | 'fallback')[];
    versionRequirement?: { min?: string; max?: string; reason?: string }; currentMeetsRequirement?: boolean; targetMeetsRequirement?: boolean;
    fields: { key: string; label: string; type: string; isSecret: boolean; configured: boolean; present?: boolean; currentValue?: string }[] }[];
  unknownKeys: { section: string; key: string }[];
  unknownKeyCount: number; unknownKeysTruncated: boolean;
  summary: { retained: number; relocated: number; newDefaults: number; unsupported: number; unmapped: number };
  preservesConfig: true; migrationSimulated: false;
}

function version(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && /^\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.]+)?$/.test(value) ? value : undefined;
}
function available(setting: SettingDef, release: string | undefined): boolean | undefined {
  if (!setting.availability) return true;
  return release ? satisfiesRange(release, setting.availability) : undefined;
}
function safeName(value: string, max = 160): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max); }
function publicProviderValue(value: string, type: string, secret: boolean, min?: number, max?: number): string | undefined {
  if (secret) return undefined;
  if (type === 'boolean' && /^(?:true|false)$/i.test(value)) return value;
  if (type === 'number' && value.length <= 64 && /^[-+]?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && Math.abs(parsed) <= 1e9 && (min === undefined || parsed >= min) && (max === undefined || parsed <= max)) return value;
  }
  return undefined;
}
function empty(target: TranslationConfigComparisonTarget, registered: boolean): TranslationConfigComparison {
  return {
    available: false, translatorId: TRANSLATOR,
    currentVersion: { source: 'unknown', confidence: 'unverified', ambiguous: false },
    ...(version(target.version) ? { targetVersion: version(target.version) } : {}),
    ...(target.variantId ? { targetVariantId: target.variantId } : {}), targetRegistered: registered,
    configFile: { path: '', exists: false, preservedByReinstall: true, pathChanged: false }, configPathChanged: false,
    coverage: { described: 0, total: 0, schemaSettings: 0, targetMapped: 0 }, rows: [], providers: [], unknownKeys: [], unknownKeyCount: 0, unknownKeysTruncated: false,
    summary: { retained: 0, relocated: 0, newDefaults: 0, unsupported: 0, unmapped: 0 },
    preservesConfig: true, migrationSimulated: false,
  };
}

/** Pure comparison of the partial registered schema. Defaults are reference
 * values, not versioned upstream defaults or a patch that maintenance applies. */
export function compareTranslationConfig(
  schema: ConfigSchema, current: GameConfig, target: TranslationConfigComparisonTarget, targetRegistered: boolean,
): TranslationConfigComparison {
  const report = empty(target, targetRegistered);
  report.available = true;
  const currentVersion = version(current.detected.version), targetVersion = version(target.version);
  // A receipt can precede assembly detection in the schema. Its recorded
  // version must agree with separately observed payload versions before it
  // can support precise current-version comparisons.
  const detectedEvidence = currentVersion && ['receipt', 'assembly'].includes(current.detected.source) && current.detected.confidence === 'verified'
    ? [currentVersion] : [];
  report.currentVersion = {
    ...(currentVersion ? { version: currentVersion } : {}), source: current.detected.source,
    confidence: current.detected.confidence,
    ambiguous: new Set([...detectedEvidence, ...(target.currentVersions ?? [])].map(version).filter(Boolean).map((entry) => entry!.replace(/^(\d+\.\d+\.\d+)\.0$/, '$1'))).size > 1,
  };
  const currentEvidenceConfirmed = Boolean(currentVersion && !report.currentVersion.ambiguous &&
    ['receipt', 'assembly'].includes(current.detected.source) && current.detected.confidence === 'verified');
  const targetFile = schema.configLocations.find((location) => location.variant === target.variantId);
  const pathChanged = Boolean(targetFile && targetFile.path !== current.location.path);
  report.configFile = { path: current.location.path, exists: current.location.exists, preservedByReinstall: true,
    ...(targetFile ? { targetPath: targetFile.path } : {}), pathChanged };
  report.configPathChanged = pathChanged;
  if (targetFile) report.targetConfigFile = { path: targetFile.path, confidence: targetFile.confidence ?? 'community' };
  report.coverage = { ...current.coverage, schemaSettings: schema.settings.length, targetMapped: 0 };

  for (const setting of schema.settings) {
    const oldAvailable = available(setting, currentVersion), newAvailable = available(setting, targetVersion);
    const oldMapping = oldAvailable !== false ? resolveMapping(setting, currentVersion) : undefined;
    const newMapping = targetRegistered && targetVersion && newAvailable !== false ? resolveMapping(setting, targetVersion) : undefined;
    const value = current.values.find((entry) => entry.id === setting.id);
    const isSecret = setting.ui.type === 'secret' || /secret|token|password|credential|api.?key|authorization/i.test(setting.id + ' ' + (oldMapping?.key ?? ''));
    const introduced = Boolean(currentEvidenceConfirmed && targetVersion && targetRegistered && oldAvailable === false && newAvailable === true && !newMapping?.assumed);
    const row: TranslationConfigComparisonRow = {
      id: setting.id, label: value?.label ?? tRegistry(`configSchema.${schema.translator}.settings.${setting.id}.label`, setting.ui.label),
      category: setting.ui.category, type: setting.ui.type, status: 'unmapped', isSecret, introduced,
      ...(typeof value?.present === 'boolean' ? { currentPresent: value.present } : {}),
    };
    if (oldMapping) row.currentLocation = { ...oldMapping, file: current.location.path };
    if (newMapping) {
      row.targetLocation = { ...newMapping, ...(targetFile ? { file: targetFile.path } : {}) };
      if (!newMapping.assumed) report.coverage.targetMapped += 1;
    }
    if (isSecret) row.configured = Boolean(value?.value);
    else {
      if (value) { row.currentValue = value.value; row.currentIsDefault = value.isDefault; }
      if (setting.default !== undefined) row.targetDefault = setting.default;
      row.customValue = Boolean(value && value.present !== false && setting.default !== undefined && value.value !== setting.default);
    }
    if (targetRegistered && targetVersion && newAvailable === false) row.status = 'unsupported';
    else if (introduced) row.status = 'new-default';
    else if (!currentEvidenceConfirmed || !targetRegistered || !targetVersion || !oldMapping || oldMapping.assumed || !newMapping || newMapping.assumed) row.status = 'unmapped';
    else if (value?.present === false) row.status = 'new-default';
    else if (oldMapping.section !== newMapping.section || oldMapping.key !== newMapping.key || pathChanged) row.status = 'relocated';
    else row.status = 'retained';
    report.rows.push(row);
    const field = row.status === 'new-default' ? 'newDefaults' : row.status;
    report.summary[field] += 1;
  }
  // Credential/service strings are presence metadata only: a plain string may
  // carry a secret in a URL or header. Strict boolean/numeric options are safe.
  const primary = current.values.find((entry) => entry.id === 'xunity.endpoint')?.value;
  const fallback = current.values.find((entry) => entry.id === 'xunity.fallbackEndpoint')?.value;
  report.providers = current.providers.map((provider) => {
    const roles: ('primary' | 'fallback')[] = [];
    if (provider.provider.id === primary || provider.selected) roles.push('primary');
    if (provider.provider.id === fallback) roles.push('fallback');
    const requirement = provider.provider.requiresTranslatorVersion;
    return {
    id: provider.provider.id, label: provider.provider.label, selected: roles.length > 0, roles,
    ...(requirement ? { versionRequirement: { ...(requirement.min ? { min: requirement.min } : {}), ...(requirement.max ? { max: requirement.max } : {}),
      ...(requirement.reason ? { reason: tRegistry(`configSchema.${schema.translator}.providers.${provider.provider.id}.requiresTranslatorVersion.reason`, requirement.reason) } : {}) },
      ...(currentVersion && currentEvidenceConfirmed ? { currentMeetsRequirement: satisfiesRange(currentVersion, requirement) } : {}),
      ...(targetVersion && targetRegistered ? { targetMeetsRequirement: satisfiesRange(targetVersion, requirement) } : {}) } : {}),
    fields: provider.fields.map((field) => {
      const definition = provider.provider.fields.find((entry) => entry.key === field.key);
      const currentValue = publicProviderValue(field.value, field.type, field.isSecret, definition?.min, definition?.max);
      return { key: field.key, label: field.label, type: field.type, isSecret: field.isSecret,
        configured: Boolean(field.value), ...(typeof field.present === 'boolean' ? { present: field.present } : {}),
        ...(currentValue !== undefined ? { currentValue } : {}) };
    }),
  }; });
  // Unknown keys survive payload maintenance. Their values are never part of
  // this DTO, even if the existing generic reader did not classify a secret.
  report.unknownKeyCount = current.unknown.length;
  report.unknownKeysTruncated = current.unknown.length > 200;
  report.unknownKeys = current.unknown.slice(0, 200).map(({ section, key }) => ({ section: safeName(section), key: safeName(key) }));
  return report;
}

/** Fixed config/version inputs must be ordinary paths before the generic
 * reader is called. This report never follows a linked game/config target. */
async function checkInputs(profile: GameProfile, schema: ConfigSchema): Promise<void> {
  const root = path.resolve(profile.path);
  if (!path.isAbsolute(profile.path) || /^\\\\[?.]\\/.test(root)) throw new Error('unsafe');
  const ordinary = async (target: string, missing = false): Promise<import('node:fs').Stats | undefined> => {
    const anchor = path.parse(target).root;
    let current = anchor;
    const paths = [anchor, ...target.slice(anchor.length).split(path.sep).filter(Boolean).map((part) => { current = path.join(current, part); return current; })];
    for (let index = 0; index < paths.length; index += 1) {
      let stat;
      try { stat = await fsp.lstat(paths[index]!); }
      catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      if (stat.isSymbolicLink() || index < paths.length - 1 && !stat.isDirectory()) throw new Error('unsafe');
      if (index === paths.length - 1) return stat;
    }
    return undefined;
  };
  if (!(await ordinary(root))?.isDirectory()) throw new Error('unsafe');
  const relative = (value: string): string => {
    const normal = value.replace(/\\/g, '/');
    if (!normal || path.isAbsolute(value) || normal.split('/').some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f:]/.test(part))) throw new Error('unsafe');
    return path.join(root, ...normal.split('/'));
  };
  let configBytes = 0;
  for (const candidate of new Set(schema.configLocations.map((location) => location.path))) {
    const stat = await ordinary(relative(candidate), true);
    if (!stat) continue;
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('unsafe');
    configBytes += stat.size;
    if (configBytes > 2 * 1024 * 1024) throw new Error('unsafe');
  }
  for (const step of schema.versionDetection.order) for (const candidate of step.paths ?? []) {
    const stat = await ordinary(relative(candidate), true);
    if (stat && !stat.isFile()) throw new Error('unsafe');
  }
  const receipts = path.join(root, '.indiedeck', 'receipts'), receiptStat = await ordinary(receipts, true);
  if (receiptStat) {
    if (!receiptStat.isDirectory()) throw new Error('unsafe');
    const entries = await fsp.readdir(receipts);
    if (entries.length > 1000) throw new Error('unsafe');
    let bytes = 0;
    for (const name of entries.filter((entry) => entry.endsWith('.json'))) {
      const stat = await ordinary(path.join(receipts, name));
      if (!stat?.isFile() || stat.size > 1024 * 1024) throw new Error('unsafe');
      bytes += stat.size;
      if (bytes > 2 * 1024 * 1024) throw new Error('unsafe');
    }
  }
}

/** Read-only report. Maintenance remains the authority for eligibility and its
 * existing config-file fingerprint; failure here never broadens that authority. */
export async function buildTranslationConfigComparison(
  registry: Registry, profile: GameProfile, target: TranslationConfigComparisonTarget,
): Promise<TranslationConfigComparison> {
  const targetVersion = version(target.version);
  const registered = Boolean(targetVersion && registry.translators.find((item) => item.id === TRANSLATOR)?.versions.some((item) => item.version === targetVersion));
  const fallback = empty(target, registered);
  const schema = registry.configSchemas.get(TRANSLATOR);
  if (!schema) return { ...fallback, reasonKey: 'ui.configComparison.reason.schemaUnavailable' };
  try {
    await checkInputs(profile, schema);
    const current = await readGameConfig(registry, registry.configSchemas, profile, TRANSLATOR);
    return compareTranslationConfig(schema, current, target, registered);
  } catch {
    return { ...fallback, reasonKey: 'ui.configComparison.reason.readUnavailable' };
  }
}

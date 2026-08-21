import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Confidence, GameProfile, Registry } from '../types.ts';
import { message, t, tRegistry, type Message } from '../i18n/index.ts';
import { BACKUP_DIR, readReceipts } from '../install/apply.ts';
import { withTransaction } from '../install/transaction.ts';
import { pathExists } from '../util/fsx.ts';
import { applyIni, parseIni, type IniData } from '../util/ini.ts';
import { peVersionString } from '../util/pe.ts';
import { FsProbe } from '../util/fsx.ts';
import { satisfiesRange } from '../util/version.ts';
import {
  isAvailable,
  providerById,
  resolveMapping,
  settingById,
  type ConfigSchema,
  type ProviderDef,
  type SettingDef,
} from './schema.ts';

export * from './schema.ts';

/* --------------------------------------------------------- version detection */

export interface DetectedTranslatorVersion {
  version?: string;
  source: 'receipt' | 'assembly' | 'config-tag' | 'unknown';
  confidence: Confidence;
  note?: string;
}

/**
 * Works out which translator build is installed, in the order the schema
 * declares. The assembly on disk outranks the config's own Migrations tag,
 * because that tag records the last migration that ran - usually the installed
 * version, but not by construction.
 */
export async function detectTranslatorVersion(
  schema: ConfigSchema,
  profile: GameProfile,
): Promise<DetectedTranslatorVersion> {
  const probe = new FsProbe(profile.path);

  for (const step of schema.versionDetection.order) {
    if (step.kind === 'receipt') {
      const receipts = await readReceipts(profile.path);
      const hit = receipts.find((r) => r.kind === 'translator' && r.componentId === schema.translator);
      if (hit?.version) {
        const out: DetectedTranslatorVersion = { version: hit.version, source: 'receipt', confidence: step.confidence };
        if (step.note) out.note = step.note;
        return out;
      }
      continue;
    }

    if (step.kind === 'peFileVersion') {
      for (const candidate of step.paths ?? []) {
        if (!probe.hasFile(candidate)) continue;
        const version = peVersionString(probe, candidate, 3 * 1024 * 1024);
        if (version) {
          const out: DetectedTranslatorVersion = { version, source: 'assembly', confidence: step.confidence };
          if (step.note) out.note = step.note;
          return out;
        }
      }
      continue;
    }

    if (step.kind === 'configTag') {
      const location = await findConfigPath(schema, profile);
      if (!location) continue;
      const text = await fsp.readFile(path.join(profile.path, location.path), 'utf8').catch(() => '');
      const tag = parseIni(text)[step.section ?? '']?.[step.key ?? ''];
      if (tag) {
        const out: DetectedTranslatorVersion = { version: tag, source: 'config-tag', confidence: step.confidence };
        if (step.note) out.note = step.note;
        return out;
      }
    }
  }

  return {
    source: 'unknown',
    confidence: 'unverified',
    note: 'No installed version could be determined; the newest known config layout is assumed.',
  };
}

/* -------------------------------------------------------------- config file */

export interface ConfigFileLocation {
  path: string;
  variant: string;
  confidence: Confidence;
  exists: boolean;
}

/** Finds the config file for whichever variant is actually installed. */
export async function findConfigPath(schema: ConfigSchema, profile: GameProfile): Promise<ConfigFileLocation | undefined> {
  const installed = profile.installedTranslators.find((t) => t.translatorId === schema.translator);

  const ordered = [...schema.configLocations].sort((a, b) => {
    const score = (loc: { variant: string }) => (loc.variant === installed?.variantId ? 0 : 1);
    return score(a) - score(b);
  });

  for (const location of ordered) {
    if (await pathExists(path.join(profile.path, location.path))) {
      return { path: location.path, variant: location.variant, confidence: location.confidence ?? 'community', exists: true };
    }
  }

  // Nothing on disk yet - the plugin writes it on first launch. Report where it
  // will appear so the UI can say so rather than showing nothing.
  const expected = ordered.find((l) => l.variant === installed?.variantId) ?? ordered[0];
  if (!expected) return undefined;
  return { path: expected.path, variant: expected.variant, confidence: expected.confidence ?? 'community', exists: false };
}

/* ------------------------------------------------------------------ reading */

export interface ConfigValue {
  id: string;
  label: string;
  category: string;
  type: SettingDef['ui']['type'];
  value: string;
  isDefault: boolean;
  section: string;
  key: string;
  /** The mapping was guessed because no declared range covered this version. */
  assumed: boolean;
  confidence: Confidence;
  help?: string;
  deprecated?: boolean;
  ui: SettingDef['ui'];
  default?: string;
}

export interface ProviderState {
  provider: ProviderDef;
  selected: boolean;
  fields: { key: string; label: string; type: ProviderField['type']; value: string; required: boolean; isSecret: boolean }[];
}

type ProviderField = ProviderDef['fields'][number];

export interface GameConfig {
  translatorId: string;
  translatorName: string;
  detected: DetectedTranslatorVersion;
  location: ConfigFileLocation;
  /** Settings the schema describes, in UI order. */
  values: ConfigValue[];
  /** Provider sections with their credential fields, current values included. */
  providers: ProviderState[];
  /**
   * Keys present in the file that the schema says nothing about. They are never
   * touched, and the expert view shows them so nothing looks lost.
   */
  unknown: { section: string; key: string; value: string }[];
  /** How much of the file the schema actually describes. */
  coverage: { described: number; total: number };
  warnings: Message[];
}

const SECRET_TYPES = new Set(['secret']);

function redact(value: string): string {
  if (!value) return '';
  return value.length <= 4 ? '••••' : `${'•'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

export interface ReadConfigOptions {
  /** Return credential values in the clear. Off by default. */
  revealSecrets?: boolean;
}

export async function readGameConfig(
  reg: Registry,
  schemas: Map<string, ConfigSchema>,
  profile: GameProfile,
  translatorId: string,
  options: ReadConfigOptions = {},
): Promise<GameConfig> {
  const schema = schemas.get(translatorId);
  if (!schema) {
    throw new Error(
      t('core.config.error.no-schema', { translator: translatorId }, `No config schema is registered for "${translatorId}".`),
    );
  }

  const detected = await detectTranslatorVersion(schema, profile);
  const location = await findConfigPath(schema, profile);
  if (!location) {
    throw new Error(
      t(
        'core.config.error.no-location',
        { translator: translatorId },
        `Could not work out where ${translatorId} keeps its config in this game.`,
      ),
    );
  }

  const absolute = path.join(profile.path, location.path);
  const text = location.exists ? await fsp.readFile(absolute, 'utf8') : '';
  const data = parseIni(text);
  const warnings: Message[] = [];

  if (!location.exists) {
    warnings.push(
      message(
        'core.config.warning.file-missing',
        { path: location.path },
        '{path} does not exist yet - it is generated the first time the game runs with the plugin installed. Values written now will be applied when it appears.',
      ),
    );
  }
  if (detected.source === 'unknown') {
    warnings.push(
      message(
        'core.config.warning.version-unknown',
        {},
        'The installed version could not be determined, so the newest known config layout is assumed.',
      ),
    );
  } else if (detected.source === 'config-tag') {
    warnings.push(
      message(
        'core.config.warning.version-from-tag',
        { version: detected.version },
        "Version {version} was read from the config's own Migrations tag, not from the installed assembly - treat it as a hint.",
      ),
    );
  }

  const describedKeys = new Set<string>();
  const values: ConfigValue[] = [];

  for (const setting of schema.settings) {
    if (!isAvailable(setting, detected.version)) continue;
    const mapping = resolveMapping(setting, detected.version);
    if (!mapping) continue;

    describedKeys.add(`${mapping.section.toLowerCase()}.${mapping.key.toLowerCase()}`);
    const raw = data[mapping.section]?.[mapping.key];
    const value = raw ?? setting.default ?? '';

    const entry: ConfigValue = {
      id: setting.id,
      label: tRegistry(`configSchema.${schema.translator}.settings.${setting.id}.label`, setting.ui.label),
      category: setting.ui.category,
      type: setting.ui.type,
      value: SECRET_TYPES.has(setting.ui.type) && !options.revealSecrets ? redact(value) : value,
      isDefault: raw === undefined || raw === setting.default,
      section: mapping.section,
      key: mapping.key,
      assumed: mapping.assumed,
      confidence: mapping.confidence,
      ui: setting.ui,
    };
    if (setting.help) entry.help = tRegistry(`configSchema.${schema.translator}.settings.${setting.id}.help`, setting.help);
    if (setting.ui.deprecated) entry.deprecated = true;
    if (setting.default !== undefined) entry.default = setting.default;
    values.push(entry);
  }

  values.sort((a, b) => {
    const catA = schema.categories.findIndex((c) => c.id === a.category);
    const catB = schema.categories.findIndex((c) => c.id === b.category);
    return catA - catB || (a.ui.order ?? 0) - (b.ui.order ?? 0);
  });

  const selectedEndpoint = data['Service']?.['Endpoint'] ?? values.find((v) => v.id === 'xunity.endpoint')?.value ?? '';
  const providers: ProviderState[] = schema.providers.map((provider) => {
    const fields = provider.fields.map((field) => {
      if (provider.section) describedKeys.add(`${provider.section.toLowerCase()}.${field.key.toLowerCase()}`);
      const raw = provider.section ? (data[provider.section]?.[field.key] ?? '') : '';
      return {
        key: field.key,
        label: tRegistry(
          `configSchema.${schema.translator}.providers.${provider.id}.fields.${field.key}.label`,
          field.label,
        ),
        type: field.type,
        value: field.type === 'secret' && !options.revealSecrets ? redact(raw) : raw,
        required: field.required === true,
        isSecret: field.type === 'secret',
      };
    });
    const label = tRegistry(`configSchema.${schema.translator}.providers.${provider.id}.label`, provider.label);
    const note = provider.note
      ? tRegistry(`configSchema.${schema.translator}.providers.${provider.id}.note`, provider.note)
      : undefined;
    return {
      provider: { ...provider, label, ...(note ? { note } : {}) },
      selected: provider.id === selectedEndpoint,
      fields,
    };
  });

  const unknown: GameConfig['unknown'] = [];
  let total = 0;
  for (const [section, kv] of Object.entries(data)) {
    for (const [key, value] of Object.entries(kv)) {
      total += 1;
      if (describedKeys.has(`${section.toLowerCase()}.${key.toLowerCase()}`)) continue;
      unknown.push({ section, key, value: /key|secret|token|password/i.test(key) ? redact(value) : value });
    }
  }

  const found = reg.translators.find((entry) => entry.id === translatorId);
  const translatorName = tRegistry(`registry.translators.${translatorId}.name`, found?.name ?? translatorId);
  return {
    translatorId,
    translatorName,
    detected,
    location,
    values,
    providers,
    unknown,
    coverage: { described: total - unknown.length, total },
    warnings,
  };
}

/* --------------------------------------------------------------- validation */

export interface ConfigChange {
  /** Semantic setting id, or `provider:<ProviderId>:<FieldKey>` for credentials. */
  id: string;
  value: string;
}

export interface ValidationIssue {
  id: string;
  severity: 'error' | 'warn' | 'info';
  /** Rendered in the active locale. */
  message: string;
  messageKey?: string;
  messageParams?: Record<string, string | number | undefined>;
}

function issueFrom(id: string, severity: ValidationIssue['severity'], msg: Message): ValidationIssue {
  const out: ValidationIssue = { id, severity, message: msg.text, messageKey: msg.key };
  if (msg.params) out.messageParams = msg.params;
  return out;
}

export interface ConfigPlan {
  changes: { id: string; section: string; key: string; from: string; to: string; isSecret: boolean }[];
  issues: ValidationIssue[];
  /** Section -> key -> value, ready to hand to applyIni. */
  patch: IniData;
  valid: boolean;
}

/** A renderer/log-safe plan. The executable INI patch never crosses the boundary. */
export type PublicConfigPlan = Omit<ConfigPlan, 'patch'>;

export function redactConfigPlan(plan: ConfigPlan): PublicConfigPlan {
  return {
    changes: plan.changes.map((change) => ({
      ...change,
      from: change.isSecret ? redact(change.from) : change.from,
      to: change.isSecret ? redact(change.to) : change.to,
    })),
    issues: plan.issues,
    valid: plan.valid,
  };
}

function parseProviderChangeId(id: string): { providerId: string; fieldKey: string } | undefined {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'provider') return undefined;
  return { providerId: parts[1]!, fieldKey: parts[2]! };
}

/**
 * Turns requested changes into a concrete INI patch, validating each one
 * against the schema and the game's own state first.
 */
export function planConfigChanges(
  schema: ConfigSchema,
  current: GameConfig,
  changes: ConfigChange[],
  context: { fontBundles?: string[] } = {},
): ConfigPlan {
  const issues: ValidationIssue[] = [];
  const patch: IniData = {};
  const planned: ConfigPlan['changes'] = [];

  const put = (section: string, key: string, value: string): void => {
    patch[section] ??= {};
    patch[section]![key] = value;
  };

  // Applying the endpoint change first means later validation sees the intended
  // provider, not the one that happens to be in the file.
  const endpointChange = changes.find((c) => c.id === 'xunity.endpoint');
  const targetEndpoint = endpointChange?.value ?? current.values.find((v) => v.id === 'xunity.endpoint')?.value ?? '';
  const provider = providerById(schema, targetEndpoint);

  for (const change of changes) {
    const providerRef = parseProviderChangeId(change.id);
    if (providerRef) {
      const def = providerById(schema, providerRef.providerId);
      const field = def?.fields.find((f) => f.key === providerRef.fieldKey);
      if (!def || !field || !def.section) {
        issues.push(
          issueFrom(change.id, 'error', message('core.config.validation.unknown-credential', { id: change.id }, 'Unknown credential field "{id}".')),
        );
        continue;
      }
      const fieldIssue = validateScalar(field.type, change.value, field);
      if (fieldIssue) {
        issues.push(issueFrom(change.id, 'error', message(fieldIssue.key, { ...fieldIssue.params, label: field.label }, `{label}: ${fieldIssue.text}`)));
        continue;
      }
      const before = current.providers.find((p) => p.provider.id === def.id)?.fields.find((f) => f.key === field.key);
      put(def.section, field.key, change.value);
      planned.push({
        id: change.id,
        section: def.section,
        key: field.key,
        from: before?.value ?? '',
        to: field.type === 'secret' ? redact(change.value) : change.value,
        isSecret: field.type === 'secret',
      });
      continue;
    }

    const setting = settingById(schema, change.id);
    if (!setting) {
      issues.push(issueFrom(change.id, 'error', message('core.config.validation.unknown-setting', { id: change.id }, 'Unknown setting "{id}".')));
      continue;
    }
    if (!isAvailable(setting, current.detected.version)) {
      issues.push(
        issueFrom(
          change.id,
          'error',
          message(
            'core.config.validation.setting-unavailable',
            { label: setting.ui.label, version: current.detected.version },
            '{label} does not exist in version {version}.',
          ),
        ),
      );
      continue;
    }
    const mapping = resolveMapping(setting, current.detected.version);
    if (!mapping) {
      issues.push(
        issueFrom(
          change.id,
          'error',
          message('core.config.validation.no-location', { label: setting.ui.label }, 'No config location known for {label}.'),
        ),
      );
      continue;
    }

    const problem = validateSetting(setting, change.value, schema, context);
    if (problem) {
      issues.push(issueFrom(change.id, 'error', problem));
      continue;
    }
    if (mapping.assumed) {
      issues.push(
        issueFrom(
          change.id,
          'warn',
          message(
            'core.config.validation.assumed-mapping',
            { label: setting.ui.label, section: mapping.section, key: mapping.key },
            '{label} is being written to [{section}] {key}, assumed from the newest known layout because the installed version is unclear.',
          ),
        ),
      );
    }
    if (setting.ui.deprecated) {
      issues.push(
        issueFrom(
          change.id,
          'info',
          message('core.config.validation.deprecated', { label: setting.ui.label }, '{label} is deprecated upstream.'),
        ),
      );
    }

    const before = current.values.find((v) => v.id === setting.id);
    put(mapping.section, mapping.key, change.value);
    planned.push({
      id: change.id,
      section: mapping.section,
      key: mapping.key,
      from: before?.value ?? '',
      to: setting.ui.type === 'secret' ? redact(change.value) : change.value,
      isSecret: setting.ui.type === 'secret',
    });
  }

  // Cross-field checks against the resulting state.
  if (provider) {
    issues.push(...validateProviderFit(provider, schema, current, changes));
  } else if (targetEndpoint) {
    issues.push(
      issueFrom(
        'xunity.endpoint',
        'warn',
        message(
          'core.config.validation.unknown-provider',
          { endpoint: targetEndpoint },
          '"{endpoint}" is not a provider IndieDeck knows about; its credential fields cannot be checked.',
        ),
      ),
    );
  }

  return { changes: planned, issues, patch, valid: !issues.some((i) => i.severity === 'error') };
}

function validateScalar(
  type: string,
  value: string,
  bounds: { min?: number; max?: number } = {},
): Message | undefined {
  if (type === 'boolean') {
    if (!/^(true|false)$/i.test(value)) return message('core.config.invalid.boolean', {}, 'must be True or False');
    return undefined;
  }
  if (type === 'integer' || type === 'number') {
    if (value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return message('core.config.invalid.number', {}, 'must be a number');
    if (type === 'integer' && !Number.isInteger(parsed)) {
      return message('core.config.invalid.integer', {}, 'must be a whole number');
    }
    if (bounds.min !== undefined && parsed < bounds.min) {
      return message('core.config.invalid.min', { min: bounds.min }, 'must be at least {min}');
    }
    if (bounds.max !== undefined && parsed > bounds.max) {
      return message('core.config.invalid.max', { max: bounds.max }, 'must be at most {max}');
    }
  }
  return undefined;
}

function validateSetting(
  setting: SettingDef,
  value: string,
  schema: ConfigSchema,
  context: { fontBundles?: string[] },
): Message | undefined {
  const ui = setting.ui;

  if (ui.type === 'provider-select') {
    if (value === '' && ui.allowEmpty) return undefined;
    if (!providerById(schema, value)) {
      return message('core.config.invalid.engine', { value }, '"{value}" is not a known translation engine.');
    }
    return undefined;
  }
  if (ui.type === 'language') {
    if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(value)) {
      return message(
        'core.config.invalid.language',
        { value },
        '"{value}" is not a language code (expected e.g. ko, ja, zh-CN).',
      );
    }
    return undefined;
  }
  if (ui.type === 'font-bundle') {
    if (value === '') return undefined;
    if (context.fontBundles && context.fontBundles.length > 0 && !context.fontBundles.includes(value)) {
      return message(
        'core.config.invalid.font-bundle',
        { value, bundles: context.fontBundles.join(', ') },
        '"{value}" is not among the font bundles present in the game folder ({bundles}).',
      );
    }
    return undefined;
  }
  return validateScalar(ui.type, value, { ...(ui.min !== undefined ? { min: ui.min } : {}), ...(ui.max !== undefined ? { max: ui.max } : {}) });
}

/** Endpoint-level checks: credentials present, version new enough, languages supported. */
function validateProviderFit(
  provider: ProviderDef,
  schema: ConfigSchema,
  current: GameConfig,
  changes: ConfigChange[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const valueOf = (id: string): string =>
    changes.find((c) => c.id === id)?.value ?? current.values.find((v) => v.id === id)?.value ?? '';

  if (provider.requiresTranslatorVersion && current.detected.version) {
    if (!satisfiesRange(current.detected.version, provider.requiresTranslatorVersion)) {
      const reasonKey = `configSchema.${schema.translator}.providers.${provider.id}.requiresTranslatorVersion.reason`;
      issues.push(
        issueFrom(
          'xunity.endpoint',
          'warn',
          provider.requiresTranslatorVersion.reason
            ? { key: reasonKey, text: tRegistry(reasonKey, provider.requiresTranslatorVersion.reason) }
            : message(
                'core.config.validation.provider-version',
                {
                  provider: provider.label,
                  min: provider.requiresTranslatorVersion.min ?? '',
                  installed: current.detected.version,
                },
                '{provider} needs translator {min} or newer; {installed} is installed.',
              ),
        ),
      );
    }
  }

  for (const field of provider.fields) {
    if (!field.required) continue;
    const changed = changes.find((c) => c.id === `provider:${provider.id}:${field.key}`)?.value;
    const existing = current.providers.find((p) => p.provider.id === provider.id)?.fields.find((f) => f.key === field.key)?.value;
    if (!changed && !existing) {
      issues.push(
        issueFrom(
          `provider:${provider.id}:${field.key}`,
          'warn',
          message(
            'core.config.validation.missing-credential',
            { provider: provider.label, field: field.label },
            '{provider} needs {field}, which is not set. Translation will fail until it is.',
          ),
        ),
      );
    }
  }

  if (provider.languages) {
    const source = valueOf('xunity.sourceLanguage');
    const target = valueOf('xunity.targetLanguage');
    if (source && !provider.languages.source.includes(source)) {
      issues.push(
        issueFrom(
          'xunity.sourceLanguage',
          'warn',
          message(
            'core.config.validation.language-unsupported-source',
            { provider: provider.label, language: source, note: provider.languages.note ? ` - ${provider.languages.note}` : '' },
            '{provider} does not list "{language}" as a source language{note}.',
          ),
        ),
      );
    }
    if (target && !provider.languages.target.includes(target)) {
      issues.push(
        issueFrom(
          'xunity.targetLanguage',
          'warn',
          message(
            'core.config.validation.language-unsupported-target',
            { provider: provider.label, language: target, note: provider.languages.note ? ` - ${provider.languages.note}` : '' },
            '{provider} does not list "{language}" as a target language{note}.',
          ),
        ),
      );
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ writing */

export interface WriteConfigResult {
  path: string;
  changed: number;
  backup?: string;
  diff: string[];
}

/**
 * Applies a validated plan.
 *
 * The file is patched line by line and written through a transaction, so the
 * comments upstream generates, the key order, the line endings and every key
 * the schema does not describe all survive, and a failure restores the original.
 */
export async function writeGameConfig(
  profile: GameProfile,
  config: GameConfig,
  plan: ConfigPlan,
  options: { dryRun?: boolean } = {},
): Promise<WriteConfigResult> {
  if (!plan.valid) throw new Error(t('core.config.error.invalid-plan', {}, 'Refusing to write an invalid config plan.'));
  if (plan.changes.length === 0) {
    return { path: config.location.path, changed: 0, diff: [] };
  }

  const absolute = path.join(profile.path, config.location.path);
  const existing = (await pathExists(absolute)) ? await fsp.readFile(absolute, 'utf8') : '';
  const updated = applyIni(existing, plan.patch);

  const diff = plan.changes.map((change) => {
    const from = change.isSecret ? redact(change.from) : change.from;
    const to = change.isSecret ? redact(change.to) : change.to;
    return `[${change.section}] ${change.key}: ${from || '(empty)'} -> ${to || '(empty)'}`;
  });

  if (options.dryRun) return { path: config.location.path, changed: plan.changes.length, diff };

  const { entries } = await withTransaction({ root: profile.path, backupDir: BACKUP_DIR }, async (tx) => {
    await tx.write(config.location.path, updated);
    return undefined;
  });

  const result: WriteConfigResult = { path: config.location.path, changed: plan.changes.length, diff };
  const backup = entries.find((e) => e.path === config.location.path.replace(/\\/g, '/'))?.backup;
  if (backup) result.backup = backup;
  return result;
}

/** Restores a config file from a backup an earlier write produced. */
export async function restoreConfigBackup(profile: GameProfile, backupRelative: string, targetRelative: string): Promise<void> {
  const from = path.join(profile.path, backupRelative);
  if (!(await pathExists(from))) throw new Error(`Backup ${backupRelative} is gone.`);
  await withTransaction({ root: profile.path, backupDir: BACKUP_DIR }, async (tx) => {
    await tx.write(targetRelative, await fsp.readFile(from));
    return undefined;
  });
}

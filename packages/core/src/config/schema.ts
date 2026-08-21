import fs from 'node:fs';
import path from 'node:path';
import type { Confidence } from '../types.ts';
import { satisfiesRange } from '../util/version.ts';

/**
 * A translator's config layout, expressed per version range.
 *
 * The point of the indirection is that a GUI form must not be pinned to one
 * version's INI layout. Everything upstream of here talks about a stable
 * semantic id - `xunity.targetLanguage` - and this module answers "for the
 * version actually installed, which section and key is that?".
 */

export interface VersionMapping {
  min?: string;
  max?: string;
  section: string;
  key: string;
  confidence?: Confidence;
}

export interface SettingUi {
  category: string;
  label: string;
  type:
    | 'boolean'
    | 'integer'
    | 'number'
    | 'string'
    | 'secret'
    | 'language'
    | 'provider-select'
    | 'font-bundle'
    | 'directory'
    | 'enum';
  order?: number;
  min?: number;
  max?: number;
  options?: string[];
  allowEmpty?: boolean;
  deprecated?: boolean;
}

export interface SettingDef {
  id: string;
  ui: SettingUi;
  versions: VersionMapping[];
  default?: string;
  help?: string;
  /** Setting does not exist at all outside this range. */
  availability?: { min?: string; max?: string };
}

export interface ProviderField {
  key: string;
  type: 'string' | 'secret' | 'boolean' | 'number' | 'directory';
  label: string;
  required?: boolean;
  optional?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
}

export interface ProviderDef {
  id: string;
  label: string;
  tier: string[];
  section?: string;
  fields: ProviderField[];
  note?: string;
  languages?: { source: string[]; target: string[]; confidence?: Confidence; note?: string };
  requiresTranslatorVersion?: { min?: string; max?: string; reason?: string };
}

export interface ConfigLocation {
  variant: string;
  path: string;
  confidence?: Confidence;
}

export interface VersionDetectionStep {
  kind: 'receipt' | 'peFileVersion' | 'configTag';
  paths?: string[];
  section?: string;
  key?: string;
  confidence: Confidence;
  note?: string;
}

export interface ConfigSchema {
  schemaVersion: number;
  translator: string;
  notes?: string;
  versionDetection: { order: VersionDetectionStep[] };
  configLocations: ConfigLocation[];
  providers: ProviderDef[];
  categories: { id: string; label: string }[];
  settings: SettingDef[];
}

/** Loads every `registry/configs/*.json`, keyed by translator id. */
export function loadConfigSchemas(registryDir: string): Map<string, ConfigSchema> {
  const dir = path.join(registryDir, 'configs');
  const schemas = new Map<string, ConfigSchema>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return schemas;
  }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const schema = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ConfigSchema;
      schemas.set(schema.translator, schema);
    } catch (err) {
      throw new Error(`Failed to read config schema ${name}: ${(err as Error).message}`);
    }
  }
  return schemas;
}

export interface ResolvedMapping {
  section: string;
  key: string;
  confidence: Confidence;
  /** True when no mapping declared a range covering this version. */
  assumed: boolean;
}

/**
 * Picks the mapping for a version. An unknown version falls back to the newest
 * mapping and says so, rather than refusing to show anything - but the caller
 * is expected to surface `assumed`.
 */
export function resolveMapping(setting: SettingDef, version: string | undefined): ResolvedMapping | undefined {
  if (setting.versions.length === 0) return undefined;

  if (version) {
    const match = setting.versions.find((m) => satisfiesRangeStrict(version, m));
    if (match) {
      return { section: match.section, key: match.key, confidence: match.confidence ?? 'verified', assumed: false };
    }
  }

  // No version, or no declared range covers it: use the mapping with the
  // highest `min`, which is the newest layout this schema knows about.
  const newest = [...setting.versions].sort((a, b) => (a.min ?? '0').localeCompare(b.min ?? '0')).at(-1)!;
  return { section: newest.section, key: newest.key, confidence: 'inferred', assumed: true };
}

function satisfiesRangeStrict(version: string, range: { min?: string; max?: string }): boolean {
  // Unlike the resolver's permissive check, a mapping must genuinely contain the
  // version: picking the wrong section writes a key the plugin never reads.
  if (!range.min && !range.max) return true;
  return satisfiesRange(version, range);
}

export function isAvailable(setting: SettingDef, version: string | undefined): boolean {
  if (!setting.availability) return true;
  if (!version) return true; // unknown version: show it rather than hide it
  return satisfiesRange(version, setting.availability);
}

export function providerById(schema: ConfigSchema, id: string): ProviderDef | undefined {
  return schema.providers.find((p) => p.id === id);
}

export function settingById(schema: ConfigSchema, id: string): SettingDef | undefined {
  return schema.settings.find((s) => s.id === id);
}

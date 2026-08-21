import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigSchemas, type ConfigSchema } from '../config/schema.ts';
import type {
  CompatRule,
  EngineDef,
  LoaderDef,
  Registry,
  TranslatorDef,
  TranslatorVariant,
  TranslatorVersion,
} from '../types.ts';

const FILES = ['engines.json', 'loaders.json', 'translators.json', 'compat.json', 'fonts.json'] as const;

/** Walks up from this module looking for the repo's `registry/` directory. */
export function findRegistryDir(startFrom?: string): string {
  const envDir = process.env['INDIEDECK_REGISTRY'];
  if (envDir && fs.existsSync(path.join(envDir, 'engines.json'))) return envDir;

  let dir = startFrom ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'registry');
    if (fs.existsSync(path.join(candidate, 'engines.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate the IndieDeck registry directory. Set INDIEDECK_REGISTRY to the folder holding engines.json.',
  );
}

function readJson<T>(dir: string, file: string): T {
  const full = path.join(dir, file);
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8')) as T;
  } catch (err) {
    throw new Error(`Failed to read registry file ${full}: ${(err as Error).message}`);
  }
}

export function loadRegistry(registryDir?: string): Registry {
  const dir = registryDir ?? findRegistryDir();
  const engines = readJson<{ engines: EngineDef[]; updated: string }>(dir, 'engines.json');
  const loaders = readJson<{ loaders: LoaderDef[]; updated: string }>(dir, 'loaders.json');
  const translators = readJson<{ translators: TranslatorDef[]; updated: string }>(dir, 'translators.json');
  const compat = readJson<{ rules: CompatRule[]; channelPreference: Registry['compat']['channelPreference']; updated: string }>(
    dir,
    'compat.json',
  );
  const fonts = readJson<Registry['fonts'] & { updated: string }>(dir, 'fonts.json');

  return {
    engines: engines.engines,
    loaders: loaders.loaders,
    translators: translators.translators,
    compat: { channelPreference: compat.channelPreference ?? ['stable', 'prerelease', 'bleeding-edge'], rules: compat.rules },
    fonts,
    configSchemas: loadConfigSchemas(dir),
    meta: {
      updated: {
        engines: engines.updated,
        loaders: loaders.updated,
        translators: translators.updated,
        compat: compat.updated,
        fonts: fonts.updated,
      },
    },
  };
}

/* ------------------------------------------------------------------ lookups */

export function engineById(reg: Registry, id: string): EngineDef | undefined {
  return reg.engines.find((e) => e.id === id);
}

export function loaderById(reg: Registry, id: string): LoaderDef | undefined {
  return reg.loaders.find((l) => l.id === id);
}

export function translatorById(reg: Registry, id: string): TranslatorDef | undefined {
  return reg.translators.find((t) => t.id === id);
}

export function loadersProviding(reg: Registry, capability: string): LoaderDef[] {
  return reg.loaders.filter((l) => l.provides.includes(capability));
}

export function variantOf(t: TranslatorDef, variantId: string): TranslatorVariant | undefined {
  return t.variants.find((v) => v.id === variantId);
}

export function versionsForVariant(t: TranslatorDef, variantId: string): TranslatorVersion[] {
  return t.versions.filter((v) => v.variants.includes(variantId));
}

export function translatorsForEngine(reg: Registry, engineId: string): TranslatorDef[] {
  return reg.translators.filter((t) => t.engines.includes(engineId) || t.engines.includes('*'));
}

/* --------------------------------------------------------------- validation */

export interface RegistryIssue {
  level: 'error' | 'warn';
  where: string;
  message: string;
}

/** Structural self-check: every cross-reference in the registry resolves. */
export function validateRegistry(reg: Registry): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const engineIds = new Set(reg.engines.map((e) => e.id));
  const loaderIds = new Set(reg.loaders.map((l) => l.id));
  const translatorIds = new Set(reg.translators.map((t) => t.id));
  const capabilities = new Set(reg.loaders.flatMap((l) => l.provides));

  for (const e of reg.engines) {
    for (const l of e.loaders) {
      if (!loaderIds.has(l)) issues.push({ level: 'error', where: `engines/${e.id}`, message: `unknown loader "${l}"` });
    }
    for (const t of e.translators) {
      if (!translatorIds.has(t)) issues.push({ level: 'error', where: `engines/${e.id}`, message: `unknown translator "${t}"` });
    }
    if (e.rules.length === 0) issues.push({ level: 'warn', where: `engines/${e.id}`, message: 'no detection rules' });
    const maxScore = e.rules.reduce((sum, r) => sum + r.score, 0);
    if (maxScore < e.minScore) {
      issues.push({
        level: 'error',
        where: `engines/${e.id}`,
        message: `minScore ${e.minScore} is unreachable (rules total ${maxScore})`,
      });
    }
  }

  for (const l of reg.loaders) {
    for (const e of l.engines) {
      if (!engineIds.has(e)) issues.push({ level: 'error', where: `loaders/${l.id}`, message: `unknown engine "${e}"` });
    }
  }

  for (const t of reg.translators) {
    for (const e of t.engines) {
      if (e !== '*' && !engineIds.has(e)) {
        issues.push({ level: 'error', where: `translators/${t.id}`, message: `unknown engine "${e}"` });
      }
    }
    const variantIds = new Set(t.variants.map((v) => v.id));
    for (const v of t.variants) {
      const cap = v.requiresLoader?.capability;
      if (cap && !capabilities.has(cap) && !v.requiresLoader?.bundled) {
        issues.push({
          level: 'warn',
          where: `translators/${t.id}/${v.id}`,
          message: `requires capability "${cap}" that no registered loader provides`,
        });
      }
      for (const pref of v.requiresLoader?.prefer ?? []) {
        if (!loaderIds.has(pref)) {
          issues.push({ level: 'error', where: `translators/${t.id}/${v.id}`, message: `prefers unknown loader "${pref}"` });
        }
      }
    }
    for (const ver of t.versions) {
      for (const v of ver.variants) {
        if (!variantIds.has(v)) {
          issues.push({ level: 'error', where: `translators/${t.id}@${ver.version}`, message: `unknown variant "${v}"` });
        }
      }
    }
    if (!t.detectOnly && t.variants.length > 0 && t.versions.length === 0) {
      issues.push({ level: 'warn', where: `translators/${t.id}`, message: 'has variants but no versions' });
    }
  }

  for (const rule of reg.compat.rules) {
    const t = rule.when['translator'];
    if (typeof t === 'string' && !translatorIds.has(t)) {
      issues.push({ level: 'error', where: `compat/${rule.id}`, message: `unknown translator "${t}"` });
    }
    const l = rule.when['loaderId'];
    if (typeof l === 'string' && !loaderIds.has(l)) {
      issues.push({ level: 'error', where: `compat/${rule.id}`, message: `unknown loader "${l}"` });
    }
    if (rule.severity !== 'prefer' && !rule.message) {
      issues.push({ level: 'warn', where: `compat/${rule.id}`, message: 'rule has no message to show the user' });
    }
  }

  return issues;
}

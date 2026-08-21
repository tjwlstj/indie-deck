import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigSchemas } from '../config/schema.ts';
import { PROBE_IDS } from '../detect/probes.ts';
import { RULE_PREDICATES } from '../resolve/index.ts';
import { t } from '../i18n/index.ts';
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
    t(
      'core.error.registry-missing',
      {},
      'Could not locate the IndieDeck registry directory. Set INDIEDECK_REGISTRY to the folder holding engines.json.',
    ),
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

/**
 * A "native" loader is the engine's own folder - RPG Maker's js/plugins,
 * Ren'Py's game/ - not something IndieDeck installs. loaders.json already says
 * so via `install.kind`, so nothing should keep its own list.
 */
export function isNativeLoader(reg: Registry, loaderId: string): boolean {
  const loader = reg.loaders.find((l) => l.id === loaderId);
  return loader?.install.kind === 'native' || loader?.install.kind === 'manual';
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
  const predicates = new Set<string>(RULE_PREDICATES);
  const probeIds = new Set<string>(PROBE_IDS);

  for (const e of reg.engines) {
    for (const l of e.loaders) {
      if (!loaderIds.has(l)) issues.push({ level: 'error', where: `engines/${e.id}`, message: `unknown loader "${l}"` });
    }
    for (const t of e.translators) {
      if (!translatorIds.has(t)) issues.push({ level: 'error', where: `engines/${e.id}`, message: `unknown translator "${t}"` });
    }
    for (const probe of e.probes) {
      if (!probeIds.has(probe)) {
        issues.push({
          level: 'error',
          where: `engines/${e.id}`,
          message: `unknown probe "${probe}" - it would be skipped silently. Known: ${[...probeIds].join(', ')}`,
        });
      }
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

  const MOD_ENTRY = new Set(['dll', 'dll-or-folder', 'folder', 'js', 'rpy']);
  const MOD_DISABLE = new Set(['rename-suffix', 'move-to-disabled', 'registry-flag']);

  for (const l of reg.loaders) {
    for (const e of l.engines) {
      if (!engineIds.has(e)) issues.push({ level: 'error', where: `loaders/${l.id}`, message: `unknown engine "${e}"` });
    }

    const layout = l.modLayout;
    if (!layout) continue;
    if (!MOD_ENTRY.has(layout.entry)) {
      issues.push({ level: 'error', where: `loaders/${l.id}/modLayout`, message: `unknown entry kind "${layout.entry}"` });
    }
    if (!MOD_DISABLE.has(layout.disable)) {
      issues.push({ level: 'error', where: `loaders/${l.id}/modLayout`, message: `unknown disable strategy "${layout.disable}"` });
    }
    if (layout.disable === 'registry-flag' && !layout.registryFile) {
      issues.push({
        level: 'error',
        where: `loaders/${l.id}/modLayout`,
        message: 'disable "registry-flag" needs a registryFile',
      });
    }
    if (layout.disable === 'registry-flag' && !layout.registryFormat) {
      issues.push({
        level: 'warn',
        where: `loaders/${l.id}/modLayout`,
        message: 'registry-flag without a registryFormat falls back to the RPG Maker plugins.js parser',
      });
    }
    if (layout.disable === 'move-to-disabled' && !layout.disabledDir) {
      issues.push({
        level: 'warn',
        where: `loaders/${l.id}/modLayout`,
        message: 'disable "move-to-disabled" without disabledDir uses "<dir>.disabled"',
      });
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

    // engines.json and translators.json both record the relationship. They have
    // to agree, or a translator is offered for an engine that does not list it
    // (or worse, silently never offered at all).
    for (const engineId of t.engines) {
      if (engineId === '*') continue;
      const engine = reg.engines.find((e) => e.id === engineId);
      if (engine && !engine.translators.includes(t.id)) {
        issues.push({
          level: 'error',
          where: `translators/${t.id}`,
          message: `claims engine "${engineId}", but engines/${engineId} does not list this translator`,
        });
      }
    }
  }

  for (const engine of reg.engines) {
    for (const translatorId of engine.translators) {
      const translator = reg.translators.find((x) => x.id === translatorId);
      if (translator && !translator.engines.includes(engine.id) && !translator.engines.includes('*')) {
        issues.push({
          level: 'error',
          where: `engines/${engine.id}`,
          message: `lists translator "${translatorId}", which does not claim this engine`,
        });
      }
    }
    for (const loaderId of engine.loaders) {
      const loader = reg.loaders.find((x) => x.id === loaderId);
      if (loader && !loader.engines.includes(engine.id)) {
        issues.push({
          level: 'error',
          where: `engines/${engine.id}`,
          message: `lists loader "${loaderId}", which does not claim this engine`,
        });
      }
    }
  }

  for (const rule of reg.compat.rules) {
    const translator = rule.when['translator'];
    if (typeof translator === 'string' && !translatorIds.has(translator)) {
      issues.push({ level: 'error', where: `compat/${rule.id}`, message: `unknown translator "${translator}"` });
    }
    const loader = rule.when['loaderId'];
    if (typeof loader === 'string' && !loaderIds.has(loader)) {
      issues.push({ level: 'error', where: `compat/${rule.id}`, message: `unknown loader "${loader}"` });
    }
    if (rule.severity !== 'prefer' && !rule.message) {
      issues.push({ level: 'warn', where: `compat/${rule.id}`, message: 'rule has no message to show the user' });
    }

    // A misspelled predicate used to disable the rule in silence, which turns a
    // "block" into nothing at all.
    for (const key of Object.keys(rule.when)) {
      if (!predicates.has(key)) {
        issues.push({
          level: 'error',
          where: `compat/${rule.id}`,
          message: `unknown \`when\` predicate "${key}" - the rule would never fire. Known: ${[...predicates].join(', ')}`,
        });
      }
    }

    // The registry's own promise: an unverified claim may advise, never block.
    if (rule.severity === 'block' && rule.confidence === 'unverified') {
      issues.push({
        level: 'error',
        where: `compat/${rule.id}`,
        message: 'an unverified rule must not block an install',
      });
    }
  }

  return issues;
}

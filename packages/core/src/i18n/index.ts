import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Translation for everything IndieDeck says.
 *
 * Two rules shape this module:
 *
 * 1. **English is the fallback, never a requirement.** A message with no entry
 *    in the active catalogue renders its English source text. A new compat rule
 *    or a new setting therefore works the moment it is written, and a
 *    translation can follow later without blocking anything.
 *
 * 2. **Messages carry their key and parameters, not just their text.** Core
 *    renders `text` in the active locale for simple consumers, but the key and
 *    params travel with it so the launcher can re-render the same finding when
 *    the user switches language, without re-running the resolver.
 */

export const LOCALES = [
  { code: 'en', label: 'English', englishLabel: 'English' },
  { code: 'ko', label: '한국어', englishLabel: 'Korean' },
] as const;

export type LocaleCode = (typeof LOCALES)[number]['code'];

export const DEFAULT_LOCALE: LocaleCode = 'en';

export type Catalog = Record<string, string>;

const catalogs = new Map<string, Catalog>();
let activeLocale: LocaleCode = DEFAULT_LOCALE;
let loadedFrom: string | undefined;

/* ---------------------------------------------------------------- loading */

/** Walks up from this module looking for the repo's `locales/` directory. */
export function findLocalesDir(startFrom?: string): string | undefined {
  const fromEnv = process.env['INDIEDECK_LOCALES'];
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'en.json'))) return fromEnv;

  let dir = startFrom ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'locales');
    if (fs.existsSync(path.join(candidate, 'en.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Loads every `locales/*.json`. Missing catalogues are not an error: the app
 * runs in English with no locale files at all.
 */
export function loadCatalogs(localesDir?: string): void {
  const dir = localesDir ?? findLocalesDir();
  if (!dir) return;
  loadedFrom = dir;

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const code = path.basename(name, '.json');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
      catalogs.set(code, flatten(raw));
    } catch (err) {
      // A broken catalogue must not take the app down - fall back to English.
      console.error(`[indiedeck] locale ${code} could not be read: ${(err as Error).message}`);
    }
  }
}

/** Catalogues are authored nested for readability and flattened to dotted keys. */
function flatten(value: Record<string, unknown>, prefix = '', out: Catalog = {}): Catalog {
  for (const [key, entry] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === 'string') out[full] = entry;
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      flatten(entry as Record<string, unknown>, full, out);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- locale */

export function normaliseLocale(value: string | undefined): LocaleCode | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase().replace('_', '-');
  const exact = LOCALES.find((l) => l.code === lower);
  if (exact) return exact.code;
  const base = lower.split('-')[0];
  return LOCALES.find((l) => l.code === base)?.code;
}

/** Best guess from the environment, for a first run with no saved preference. */
export function detectSystemLocale(): LocaleCode {
  const candidates = [
    process.env['INDIEDECK_LANG'],
    process.env['LC_ALL'],
    process.env['LANG'],
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : undefined,
  ];
  for (const candidate of candidates) {
    const match = normaliseLocale(candidate);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/**
 * Sets the locale for everything core renders from now on.
 * `system` resolves against the environment; an unknown code falls back to English.
 */
export function setLocale(locale: string | undefined): LocaleCode {
  if (catalogs.size === 0) loadCatalogs();
  activeLocale = locale === 'system' || locale === undefined ? detectSystemLocale() : normaliseLocale(locale) ?? DEFAULT_LOCALE;
  return activeLocale;
}

export function getLocale(): LocaleCode {
  return activeLocale;
}

export function availableLocales(): { code: LocaleCode; label: string; englishLabel: string; keys: number }[] {
  if (catalogs.size === 0) loadCatalogs();
  return LOCALES.map((l) => ({ ...l, keys: catalogs.get(l.code) ? Object.keys(catalogs.get(l.code)!).length : 0 }));
}

/**
 * The flattened catalogue for a locale, merged over English.
 *
 * The launcher's renderer has no filesystem access, so the main process ships
 * it this object once per language switch and the renderer does its own
 * lookups against it.
 */
export function getCatalog(locale: LocaleCode = activeLocale): Catalog {
  if (catalogs.size === 0) loadCatalogs();
  return { ...(catalogs.get(DEFAULT_LOCALE) ?? {}), ...(catalogs.get(locale) ?? {}) };
}

export function catalogSource(): string | undefined {
  return loadedFrom;
}

/* -------------------------------------------------------------- rendering */

/** Replaces `{name}` placeholders. A missing param is left visible, not blanked. */
export function interpolate(template: string, params?: Record<string, string | number | undefined>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Looks a key up in the active catalogue.
 *
 * `fallback` is the English source text written at the call site. It is what
 * renders when the key is untranslated, which is also what makes it safe to add
 * new messages without touching any locale file.
 */
export function t(key: string, params?: Record<string, string | number | undefined>, fallback?: string): string {
  if (catalogs.size === 0) loadCatalogs();
  const catalog = catalogs.get(activeLocale);
  const template = catalog?.[key] ?? catalogs.get(DEFAULT_LOCALE)?.[key] ?? fallback ?? key;
  return interpolate(template, params);
}

export function hasKey(key: string, locale: LocaleCode = activeLocale): boolean {
  if (catalogs.size === 0) loadCatalogs();
  return catalogs.get(locale)?.[key] !== undefined;
}

/* --------------------------------------------------------------- messages */

/**
 * A translated string that remembers how it was made.
 *
 * `text` is rendered in the active locale for consumers that just want to print
 * something; `key` and `params` let the launcher re-render it after a language
 * switch without recomputing the thing that produced it.
 */
export interface Message {
  key: string;
  params?: Record<string, string | number | undefined>;
  text: string;
}

export function message(
  key: string,
  params?: Record<string, string | number | undefined>,
  fallback?: string,
): Message {
  const result: Message = { key, text: t(key, params, fallback) };
  if (params && Object.keys(params).length > 0) result.params = params;
  return result;
}

/** Re-renders a message in the current locale - used after a language switch. */
export function retranslate(msg: Message, fallback?: string): string {
  return t(msg.key, msg.params, fallback ?? msg.text);
}

/**
 * Translates a registry-sourced string, falling back to the English text the
 * JSON already carries. `registry.engines.unity.name`, `compat.<ruleId>.message`
 * and so on - so a contributor adds data in English and a translator adds keys,
 * and neither has to wait for the other.
 */
export function tRegistry(key: string, englishFromRegistry: string | undefined, params?: Record<string, string | number | undefined>): string {
  return t(key, params, englishFromRegistry ?? key);
}

/* ------------------------------------------------------------ maintenance */

export interface CatalogReport {
  locale: LocaleCode;
  keys: number;
  missing: string[];
  extra: string[];
}

/** Compares each catalogue against English - used by `indiedeck locales check`. */
export function auditCatalogs(): CatalogReport[] {
  if (catalogs.size === 0) loadCatalogs();
  const english = catalogs.get(DEFAULT_LOCALE) ?? {};
  const englishKeys = new Set(Object.keys(english));

  return LOCALES.filter((l) => l.code !== DEFAULT_LOCALE).map((l) => {
    const catalog = catalogs.get(l.code) ?? {};
    const keys = Object.keys(catalog);
    return {
      locale: l.code,
      keys: keys.length,
      missing: [...englishKeys].filter((k) => catalog[k] === undefined).sort(),
      extra: keys.filter((k) => !englishKeys.has(k)).sort(),
    };
  });
}

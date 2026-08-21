/**
 * The extension points, tested as contracts.
 *
 * These exist so that adding an engine, a loader, a compat rule or a locale
 * fails loudly rather than silently doing nothing - the failure mode that made
 * a misspelled predicate disable a whole rule.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { PROBE_IDS } from '../src/detect/probes.ts';
import { auditCatalogs, getCatalog, setLocale, t, tRegistry } from '../src/i18n/index.ts';
import { appendModsTxt, parseModsTxt, REGISTRY_FORMATS, setModsTxtStatus } from '../src/mods/index.ts';
import { loadRegistry, validateRegistry } from '../src/registry/index.ts';
import { RULE_PREDICATES } from '../src/resolve/index.ts';
import type { Registry } from '../src/types.ts';

const reg = loadRegistry();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-ext-'));
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  setLocale('en');
});

/** A deep-enough copy to mutate one field without touching the shared registry. */
function clone(): Registry {
  return {
    ...reg,
    engines: reg.engines.map((e) => ({ ...e, probes: [...e.probes], translators: [...e.translators], loaders: [...e.loaders] })),
    loaders: reg.loaders.map((l) => ({ ...l, engines: [...l.engines] })),
    translators: reg.translators.map((x) => ({ ...x, engines: [...x.engines] })),
    compat: { ...reg.compat, rules: reg.compat.rules.map((r) => ({ ...r, when: { ...r.when } })) },
  };
}

/* ----------------------------------------------------------- the registry */

test('the shipped registry passes its own validation', () => {
  assert.deepEqual(
    validateRegistry(reg).filter((i) => i.level === 'error'),
    [],
  );
});

test('a misspelled rule predicate is an error, not a silently dead rule', () => {
  const broken = clone();
  broken.compat.rules[0]!.when = { backendd: 'il2cpp' };

  const issues = validateRegistry(broken);
  assert.ok(
    issues.some((i) => i.level === 'error' && /unknown `when` predicate "backendd"/.test(i.message)),
    'the typo is reported with the list of valid predicates',
  );
});

test('every predicate the matcher understands is in the declared list', () => {
  const source = fs.readFileSync(new URL('../src/resolve/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function matchesWhen');
  const end = source.indexOf('\n}', start);
  const cases = [...source.slice(start, end).matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]!);

  for (const predicate of cases) {
    assert.ok(RULE_PREDICATES.includes(predicate as never), `${predicate} is handled but not declared`);
  }
  for (const declared of RULE_PREDICATES) {
    assert.ok(cases.includes(declared), `${declared} is declared but not handled`);
  }
});

test('an unknown engine probe is an error rather than a skipped probe', () => {
  const broken = clone();
  broken.engines[0]!.probes = ['unityBackend', 'noSuchProbe'];

  assert.ok(validateRegistry(broken).some((i) => i.level === 'error' && /unknown probe "noSuchProbe"/.test(i.message)));
  assert.ok(PROBE_IDS.includes('unityBackend'), 'the real probe ids are exported for validation');
});

test('engines.json and translators.json must agree in both directions', () => {
  const broken = clone();
  const unity = broken.engines.find((e) => e.id === 'unity')!;
  unity.translators = unity.translators.filter((x) => x !== 'xunity-autotranslator');

  const issues = validateRegistry(broken);
  assert.ok(
    issues.some((i) => i.level === 'error' && /does not list this translator/.test(i.message)),
    'a translator claiming an engine that does not list it is caught',
  );
});

test('an unverified rule may not block an install', () => {
  const broken = clone();
  const rule = broken.compat.rules.find((r) => r.confidence === 'unverified')!;
  rule.severity = 'block';

  assert.ok(validateRegistry(broken).some((i) => /unverified rule must not block/.test(i.message)));
});

test('a mod layout that says registry-flag must say which file', () => {
  const broken = clone();
  const loader = broken.loaders.find((l) => l.modLayout?.disable === 'registry-flag')!;
  broken.loaders = broken.loaders.map((l) =>
    l.id === loader.id ? { ...l, modLayout: { ...l.modLayout!, registryFile: undefined } } : l,
  );

  assert.ok(validateRegistry(broken).some((i) => /needs a registryFile/.test(i.message)));
});

/* ------------------------------------------------------- registry formats */

test('UE4SS mods.txt is parsed by its own format, not the plugins.js regex', () => {
  const modsTxt = ['; UE4SS mods', 'BPModLoaderMod : 1', 'ConsoleEnablerMod : 0', '', 'Keybinds : 1'].join('\n');

  assert.deepEqual(parseModsTxt(modsTxt), [
    { name: 'BPModLoaderMod', status: true },
    { name: 'ConsoleEnablerMod', status: false },
    { name: 'Keybinds', status: true },
  ]);

  // The old behaviour: the RPG Maker parser found nothing in this file at all,
  // so every UE4SS mod showed as disabled and could never be toggled.
  assert.deepEqual(REGISTRY_FORMATS['plugins-js']!.parse(modsTxt), []);

  const toggled = setModsTxtStatus(modsTxt, 'ConsoleEnablerMod', true);
  assert.equal(parseModsTxt(toggled).find((r) => r.name === 'ConsoleEnablerMod')?.status, true);
  assert.match(toggled, /; UE4SS mods/, 'the comment survives');

  const added = appendModsTxt(modsTxt, 'NewMod');
  assert.equal(parseModsTxt(added).at(-1)?.name, 'NewMod');
});

test('both registry formats round-trip through the shared interface', () => {
  for (const [name, format] of Object.entries(REGISTRY_FORMATS)) {
    const seed = name === 'plugins-js' ? 'var $plugins = [\n];\n' : '';
    const withMod = format.append(seed, 'Example');
    assert.deepEqual(
      format.parse(withMod).map((r) => r.name),
      ['Example'],
      `${name} append/parse round trip`,
    );
    assert.equal(format.parse(format.setStatus(withMod, 'Example', false))[0]?.status, false, `${name} setStatus`);
  }
});

/* ------------------------------------------------------------------ i18n */

test('an untranslated key falls back to the English written at the call site', () => {
  setLocale('ko');
  assert.equal(
    t('core.audit.no-such-key-at-all', { x: 1 }, 'fallback text with {x}'),
    'fallback text with 1',
    'a brand new message works before anyone translates it',
  );
  setLocale('en');
});

test('registry text falls back to the JSON value, and a locale key overrides it', () => {
  setLocale('en');
  assert.equal(tRegistry('registry.engines.wolf-rpg.name', 'Wolf RPG Editor'), 'Wolf RPG Editor');

  setLocale('ko');
  assert.notEqual(
    tRegistry('registry.engines.wolf-rpg.name', 'Wolf RPG Editor'),
    'Wolf RPG Editor',
    'the Korean catalogue overrides the registry value',
  );
  assert.equal(
    tRegistry('registry.engines.made-up-engine.name', 'Made Up'),
    'Made Up',
    'an engine with no translation still shows its registry name',
  );
  setLocale('en');
});

test('every compat rule that can block has a Korean message', () => {
  setLocale('ko');
  const catalog = getCatalog('ko');
  const missing = reg.compat.rules
    .filter((rule) => rule.severity === 'block' || rule.severity === 'warn')
    .filter((rule) => catalog[`compat.${rule.id}.message`] === undefined)
    .map((rule) => rule.id);

  assert.deepEqual(missing, [], 'a rule that stops or warns a user should not do it in English only');
  setLocale('en');
});

test('the Korean catalogue covers every key the English one declares', () => {
  const [korean] = auditCatalogs();
  assert.ok(korean);
  // Registry-backed prefixes live in registry/ in English and are overridden
  // per locale, so they are not part of the English reference set.
  assert.deepEqual(korean.missing, [], 'no ui/cli/core key is left untranslated');
});

test('interpolation leaves an unknown placeholder visible rather than blanking it', () => {
  setLocale('en');
  assert.equal(t('core.no.such.key', {}, 'needs "{capability}"'), 'needs "{capability}"');
  assert.equal(t('core.no.such.key', { capability: 'bepinex' }, 'needs "{capability}"'), 'needs "bepinex"');
});

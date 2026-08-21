# Extending IndieDeck

The project is arranged so that the common additions are **data edits, not code
edits**, and so that a mistake in that data is an error rather than something
that silently does nothing.

Each section below is one task, start to finish: what to touch, what validates
it, and what to test.

```
registry/*.json     what IndieDeck knows        ← most contributions land here
locales/*.json      what IndieDeck says
packages/core       what IndieDeck does
packages/cli        one command table
packages/desktop    one section table
```

Run `npm test && node packages/cli/dist/index.js registry check` after any of
these. The registry self-check is not cosmetic: it rejects a misspelled rule
predicate, an unknown probe id, an engine and a translator that disagree about
each other, and a mod layout that cannot work.

---

## Add a game engine

**Edit:** `registry/engines.json` only.

```jsonc
{
  "id": "my-engine",
  "name": "My Engine",
  "family": "custom",
  "priority": 60,          // tie-break when two engines score equally
  "minScore": 55,          // corroboration alone must not reach this
  "rules": [
    { "kind": "file",    "value": "myengine.dll", "score": 55 },
    { "kind": "extRoot", "value": ".mypak",       "score": 30 },
    { "kind": "dir",     "value": "data",         "score": 5 }
  ],
  "probes": ["peArch"],    // validated against the real probe ids
  "loaders": [],
  "translators": ["mort", "lunatranslator"]
}
```

One high-score rule that is unique to the engine, plus low-score corroboration.
`mods/`, `data/`, `resources/` and `package.json` are shared by many engines — a
rule scoring high on any of those alone will misfire.

`engines[].translators` and `translators[].engines` are both stored, and
`registry check` now requires them to agree in both directions, so add the
engine id to each translator you list.

**Test:** add a case to `packages/core/test/detect.test.ts` that builds a
synthetic folder with those files. Detection tests never touch a real game.

**Need a new probe?** Probes are code — add a function in
`packages/core/src/detect/probes.ts` and an entry in the `PROBES` map. `PROBE_IDS`
is derived from that map, so `registry check` starts accepting the new id
immediately and keeps rejecting typos.

---

## Add a translator

**Edit:** `registry/translators.json`, plus the engine's `translators` list.

- `variants[]` — which build of it; each declares `requiresLoader`, its
  constraints, and how it installs.
- `versions[]` — which releases exist and which variants each one publishes.
  `tag` is the release tag, which is not always the asset version (XUAT's `v5.6`
  tag ships assets named `5.6.0`).
- `installedMarkers` / `variant.payloadPaths` — specific enough that an unrelated
  folder cannot match. Prefer a named file over a bare directory: `Mods/` matched
  a Godot game's own `mods/` folder once.
- Closed source or not fetchable? Set `detectOnly: true` and give a `homepage`.
  IndieDeck detects it and links out rather than pretending it can install it.

`registry check --online` compares your asset names against the real GitHub
release, so a typo shows up as a mismatch rather than a 404 at install time.

**Still code, for now:** version detection and the audit's translator-specific
gates are keyed to `xunity-autotranslator` in `packages/core/src/config/index.ts`
and `packages/core/src/audit/index.ts`. A second installable translator works for
detection, planning and install; its version detection needs a `versionDetection`
block in a config schema (below).

---

## Add a mod loader

**Edit:** `registry/loaders.json`.

The mod-host part is `modLayout`, which is the whole extension point:

```jsonc
"modLayout": {
  "dir": "MyLoader/mods",
  "entry": "folder",              // dll | dll-or-folder | folder | js | rpy
  "disable": "registry-flag",     // rename-suffix | move-to-disabled | registry-flag
  "registryFile": "MyLoader/mods.txt",
  "registryFormat": "lines"       // which parser reads that file
}
```

`disable` (how a mod is switched off) and `registryFormat` (what the registry
file looks like) are deliberately separate. They used to be conflated, and UE4SS
mods were parsed with the RPG Maker `plugins.js` regex — which found nothing, so
every UE4SS mod showed as disabled and could not be toggled.

**A new registry-file format is one entry** in `REGISTRY_FORMATS` in
`packages/core/src/mods/index.ts`:

```ts
export const REGISTRY_FORMATS: Record<string, RegistryFormat> = {
  'plugins-js': { parse: parsePluginsJs, setStatus: setPluginStatus, append: appendPlugin },
  lines:        { parse: parseModsTxt,   setStatus: setModsTxtStatus, append: appendModsTxt },
};
```

Implement `parse` / `setStatus` / `append`, and edit the file textually — never
by re-serialising it. `registry check` rejects a `registry-flag` layout with no
`registryFile`, and warns when no `registryFormat` is declared.

---

## Add a compatibility rule

**Edit:** `registry/compat.json`.

```jsonc
{
  "id": "kebab-case-and-specific",
  "severity": "block | warn | info | prefer",
  "confidence": "verified | inferred | community | unverified",
  "sources": ["https://..."],
  "when": { "backend": "il2cpp", "variantIn": ["bepinex"] },
  "message": "What the user should understand, in one or two sentences."
}
```

Two invariants the validator now enforces:

1. **Every `when` key must be a declared predicate.** The list is
   `RULE_PREDICATES` in `packages/core/src/resolve/index.ts`, and a test asserts
   it matches the matcher's `switch` in both directions. A misspelled predicate
   used to disable the whole rule in silence — a `block` quietly became nothing.
2. **An `unverified` rule may not block.** Confidence is not decoration: it
   decides whether a claim can stop an install.

**Adding a predicate** means a `case` in `matchesWhen`, an entry in
`RULE_PREDICATES`, and a line in `registry/schema/compat.schema.json`. The test
fails if you forget one of the first two.

**Translate it:** put `compat.<ruleId>.message` in `locales/ko.json`. A rule with
no translation still shows its English text, and a test requires every rule that
blocks or warns to have a Korean message — a rule that stops someone should not
do it in a language they may not read.

---

## Add a config schema for another tool

**Edit:** a new `registry/configs/<tool>.json`, validated by
`registry/schema/config.schema.json`. No code change: the loader picks up every
file in that directory, and the CLI and the launcher render whatever it declares.

The idea is that the UI addresses a setting by a stable semantic id, and the
schema says where that lives *per version*:

```jsonc
{
  "id": "mytool.language",
  "ui": { "category": "basic", "label": "Language", "type": "language" },
  "versions": [
    { "min": "2.0.0", "section": "General", "key": "Language" },
    { "max": "1.999", "section": "Main",    "key": "Lang", "confidence": "inferred" }
  ],
  "default": "en"
}
```

- `availability` hides a setting entirely outside a version range, rather than
  writing a key the tool will ignore.
- `providers[].languages` is optional and should only be filled in when the
  coverage is genuinely known. Absent means "unknown", never "unsupported".
- `versionDetection.order` decides how the installed version is found. Put the
  authoritative source first; a version-looking key inside the config file is a
  hint, so it goes last and carries a lower confidence.

Full walkthrough: [config-manager.md](config-manager.md).

---

## Add a CLI command

**Edit:** `packages/cli/src/registry.ts` — one entry:

```ts
{
  name: 'export',
  group: 'library',
  args: '<game>',
  summaryKey: 'cli.help.export',
  summary: 'Write a portable report for one game',
  flags: '--format json|md',
  run: cmdExport,
}
```

Help text and the dispatch map are both rendered from this table, so they cannot
drift. Help layout uses the CJK-aware `pad()`/`width()` from `ui.ts`, so a
translated summary still lines up.

Write `cmdExport` in `packages/cli/src/commands.ts` following the existing
shape: read through `resolveGameArg`, render through `out(ctx, data, render)` so
`--json` works for free, and put any new user-facing string in `locales/en.json`
under `cli.*` with the English text as the call-site fallback.

---

## Add a panel to the launcher

**Edit:** `packages/desktop/renderer/panels/index.js` — one entry:

```js
export const SECTIONS = [
  { id: 'header',  render: renderHeader },
  { id: 'facts',   render: renderFacts },
  { id: 'audit',   render: renderAudit,  when: (ctx) => ctx.audit.issues.length > 0 },
  { id: 'plans',   render: renderPlans },
  { id: 'config',  render: renderConfigSection,
    when: (ctx) => ctx.profile.installedTranslators.length > 0 },
  { id: 'mods',    render: renderMods },
];
```

Each section gets `(panel, ctx, refresh, onInstall)` where `ctx` is exactly what
`game:detail` returned. `when` decides whether it appears at all.

**Needs new data?** Widen the `game:detail` handler in
`packages/desktop/src/main.ts`. **Needs a new action?** Add an IPC handler there
and one line in `preload.cjs`. Two rules hold:

- The renderer sends **ids, not paths**. It never names a file, an executable or
  a plan object; the main process resolves the id against its own tables and
  rebuilds the privileged object itself.
- Renderer arguments are untrusted. Coerce and bound them in the handler.

---

## Add a language

**Edit:** copy `locales/en.json` to `locales/<code>.json` and translate, then add
the code to `LOCALES` in `packages/core/src/i18n/index.ts`.

Three things make this safe to do incrementally:

- **English is the fallback, never a requirement.** Every `t()` call carries its
  English source text, so an untranslated key renders in English and a new
  message works before anyone translates it.
- **Registry text is overridden, not duplicated.** `compat.*`, `registry.*` and
  `configSchema.*` keys override the English already in `registry/`, so a
  contributor adds a rule in English and a translator adds a key, and neither
  waits for the other.
- **Messages carry their key and params.** Core renders `text` for simple
  consumers, but `messageKey` and `messageParams` travel with every finding, so
  the launcher re-renders after a language switch without re-running the
  resolver.

`auditCatalogs()` reports keys the new catalogue is missing, and a test asserts
Korean has no gaps. Nothing keys off English prose — the CI smoke test waits on
`document.body.dataset.libraryState`, not on the words in the status bar.

---

## Things that are still code, and why

Honest list of what a contributor cannot do from `registry/` today:

| Task | Where the code is | Why it is not data yet |
| --- | --- | --- |
| A new detection probe | `detect/probes.ts` | it reads binary formats; the id is validated, the body is code |
| A new mod registry-file format | `mods/index.ts` `REGISTRY_FORMATS` | a parser is code, but the map is a one-line extension point |
| Translator version detection | `config/index.ts` | driven by a schema's `versionDetection`, but the receipt lookup is keyed to translators |
| Translator-specific audit gates | `audit/index.ts` | the DeepL and Input-System checks name `xunity-autotranslator` directly |
| Install step kinds | `install/apply.ts` | each `PlanStep.action` is a case in one switch |

These are tracked in [roadmap.md](roadmap.md). If one of them is in your way,
that is worth an issue — the shape of the fix is usually "move the literal into
the schema", and the schema already has a place for it.

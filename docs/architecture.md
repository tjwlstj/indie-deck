# Architecture

```
registry/*.json          data: engines, loaders, translators, compat rules, fonts
        |
packages/core            detect -> resolve -> install, plus audit and library
        |
packages/cli             argument parsing and rendering only
```

The split matters: every fact about the outside world lives in `registry/`, and
`packages/core` is the machinery that applies it. Adding support for a new
translator is usually a JSON edit, not a code change.

## detect

`detectGame(registry, path)` returns a **GameProfile**.

1. `FsProbe` lists the folder once and indexes it case-insensitively, so the
   dozens of signature checks that follow cost no extra syscalls.
2. Executable candidates are collected, with known helpers (crash handlers,
   uninstallers, `*.console.exe`) filtered out. The primary one is the executable
   paired with a `_Data` folder, else the one matching the folder name, else the
   largest.
3. Every engine in `engines.json` is scored against its signature rules. Rules
   can capture a match (`_Data` → `$dataDir`) for later rules to reference.
   Highest total above `minScore` wins; `priority` breaks ties.
4. The winning engine's **probes** run: Unity backend and version, Ren'Py version
   from `vc_version.py`, RPG Maker title from `System.json`, Godot version from
   the `.pck` header, RGSS variant from `Game.ini`, architecture from the PE
   header.
5. Installed loaders, translators and TMP font bundles are detected from the
   registry's `installedMarkers`, including negative markers — BepInEx 5 and 6
   both ship `BepInEx.dll`, so `BepInEx.Core.dll` is what tells them apart.

Deep probes read IL2CPP metadata (tens of megabytes) to find TextMeshPro and the
new Input System. They are off during bulk scans and on for single-game commands.

`scanLibrary` walks roots to a configurable depth and does **not** descend into a
folder that already matched — installers commonly nest the real game one level
down, which is why the default depth is 2.

## resolve

`resolvePlans(registry, profile, options)` produces a ranked list of
`TranslatorPlan`s. For each (translator, variant, version):

1. Static variant constraints — engine, backend, arch, Unity range.
2. Loader selection. An already-installed provider wins outright; otherwise the
   best version is chosen, preferring stable, and falling back to the newest
   build when a loader has no stable line at all (BepInEx 6).
3. Every rule in `compat.json` whose `when` matches is applied: `block` removes
   the candidate, `warn` scores it down and surfaces a finding, `prefer` shifts
   the score, `info` annotates.
4. If a rule asks for a font bundle, one is picked for the game's Unity line.
5. Concrete install steps and a config patch are generated.

Two deliberate properties:

- **An unknown version never blocks.** `unityVersionBelow` requires a known
  version to fire, and `satisfiesRange(undefined, …)` is true. Not knowing
  something is not evidence against it.
- **Unverified rules cannot block.** They are scored down far more gently than
  verified warnings, because their job is to inform, not to override the user.

## install

Every write goes through a **file transaction** (`install/transaction.ts`). The
distinction it enforces is the one that makes uninstall safe:

| operation | meaning | what uninstall does |
| --- | --- | --- |
| `create` | the file did not exist | delete it |
| `modify` | it did, and was displaced | restore the backup |
| `snapshot` | copied before an external patcher ran | restore the backup |

Deleting a file we merely overwrote destroys data that was never ours - a game's
own `plugins.js`, or a file another mod owns. The transaction resolves an
archive's file list *before* extracting so anything it is about to land on is
backed up first, and `rollback()` walks the journal backwards if any step
throws, leaving the folder byte-for-byte as it was.

Uninstall also refuses to delete a file whose hash no longer matches what
IndieDeck wrote: if the user hand-edited it afterwards, it is reported as
`keptModified` and left alone.

`applyPlan` walks the steps inside that transaction:

- **download** — streamed to a `.part` file and hashed as it arrives, so a
  128 MB archive never sits in memory and a truncated transfer can never be
  mistaken for a finished one. The file is renamed into the content-addressed
  cache under `~/.indiedeck/cache` only after the hash is known, and only if it
  matches when the registry pins a `sha256`. Integrity is reported as
  `verified` / `unverified` (nothing published upstream to compare against) /
  `mismatch` (discarded, never cached). GitHub release assets are resolved
  through the API; `GITHUB_TOKEN` is used when present to avoid rate limits.
- **extract** — the ZIP reader in `install/unzip.ts` handles stored and deflate
  entries over `node:zlib`, rejects Zip64 with a clear message, and refuses
  absolute paths and `..` traversal before writing anything.
- **copy** — `.7z` archives (the TMP fonts) are unpacked with whatever 7z-capable
  extractor exists on the machine: 7-Zip if installed, otherwise the bsdtar that
  ships in `System32` on Windows 10+. The extraction is cached, so the 128 MB
  font archive is unpacked once.
- **run** — refused unless `allowRun` is set. ReiPatcher rewrites game
  assemblies, so `Managed/` is snapshotted first.
- **config** — `applyIni` rewrites individual keys and preserves every comment,
  unknown key and the file's line endings, because upstream regenerates that file
  with its documentation inline.

Each install writes a **receipt** to `<game>/.indiedeck/receipts/` holding the
typed entry list above. `uninstallReceipt` reverses it newest-first and prunes
the directories it emptied. Receipts written by 0.1.0 (a flat `files[]` plus a
separate `backups[]`) are migrated on read, so installs made by the first
release stay removable.

## audit

`auditGame` is the part that pays for itself on a library that has been modded by
hand for years. It looks for states that produce no error message:

| code | what it catches |
| --- | --- |
| `font-bundle-mismatch` | TMP atlas present but none matches the game's Unity line |
| `font-bundle-clutter` | leftover atlases for other Unity versions |
| `loaders-stacked` | two mod loaders installed at once |
| `translator-payload-orphaned` | plugin files with no loader that can load them |
| `translator-outdated` | a newer release exists |
| `translator-endpoint-too-old` | installed version predates a fix the endpoint needs |

## mods

One model over very different hosts, driven by `modLayout` in `loaders.json`:

| host | directory | disable strategy |
| --- | --- | --- |
| BepInEx 5/6 | `BepInEx/plugins` | rename to `.disabled` |
| MelonLoader | `Mods` | rename to `.disabled` |
| GDWeave | `GDWeave/mods` | move to `mods.disabled` |
| UE4SS | `<Shipping>/ue4ss/Mods` | flag in `mods.txt` |
| RPG Maker | `js/plugins` | `status` flag in `plugins.js` |
| Ren'Py | `game` | rename to `.disabled` |

External loaders only appear as hosts once actually installed; native hosts
(RPG Maker, Ren'Py) always apply.

## The desktop trust boundary

The renderer is treated as untrusted even though it is our own code. It never
hands the main process a path, an executable or a plan object - it works in
opaque ids:

```
renderer                     main process
--------                     ------------
game.detail(gameId)     ->   resolve id -> path (own table)
                             re-detect the folder
                             resolve plans, cache them main-side
                        <-   profile + plans, each with an id

game.install(gameId,         look up ITS OWN cached plan
             planId)    ->   verify the plan targets that game
                             applyPlan(plan)

game.launch(gameId)     ->   re-detect, use the detected executable
```

So the worst a compromised renderer can ask for is "act on a game the main
process already knows about" - not "extract this archive into C:\Windows" or
"spawn this binary". Config writes are field-filtered, scan roots can only be
added through the OS folder picker opened by the main process, and
`shell.openExternal` accepts `https:` only.

## i18n

`packages/core/src/i18n` loads `locales/*.json` and renders every string core
produces. Two properties matter more than the mechanism:

- **English is the fallback, not a requirement.** Every `t(key, params, english)`
  call carries its source text, so a new message works before it is translated
  and a broken catalogue degrades to English instead of to keys.
- **Messages carry their key and params.** `AuditIssue`, `PlanFinding`,
  `PlanStep` and `ValidationIssue` all expose `messageKey` / `messageParams`
  next to the rendered `message`, so the launcher re-renders after a language
  switch without recomputing the thing that produced them.

Registry-sourced text (compat rule messages, engine names, config setting
labels) stays in `registry/` in English; a locale file overrides it under
`compat.*`, `registry.*` and `configSchema.*`. So a contributor adds a rule and
a translator adds a key, independently.

The renderer has no filesystem access, so the main process ships it a flattened
catalogue over IPC and `renderer/i18n.js` does the lookups. Static chrome opts in
with `data-i18n` attributes, which is why a language switch does not need
index.html touched.

Nothing keys off English prose. The CI smoke test waits on
`document.body.dataset.libraryState`, not on the words in the status bar.

## Extension points

| To add | Edit | Guarded by |
| --- | --- | --- |
| engine | `registry/engines.json` | probe ids and engine↔translator agreement |
| translator | `registry/translators.json` | cross-reference + `--online` asset check |
| mod loader | `registry/loaders.json` `modLayout` | entry/disable/registryFile validation |
| compat rule | `registry/compat.json` | declared predicate list, unverified-cannot-block |
| config schema | `registry/configs/*.json` | `registry/schema/config.schema.json` |
| CLI command | `packages/cli/src/registry.ts` | help and dispatch both render from it |
| launcher panel | `packages/desktop/renderer/panels/index.js` | one `SECTIONS` entry |
| language | `locales/*.json` | `auditCatalogs()` + a test |

Full walkthrough: [extending.md](extending.md).

## Dependency stance

Core has no runtime dependencies, and the only dev dependencies are TypeScript
and `@types/node`. This is a tool that writes files into game folders and
downloads binaries; a large transitive dependency tree is a poor trade for
convenience that `node:zlib` already provides.

Sources use erasable-only TypeScript syntax, so `node --experimental-strip-types`
runs them directly and the build step is only needed for publishing.

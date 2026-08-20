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

`applyPlan` walks the steps:

- **download** — content-addressed cache under `~/.indiedeck/cache`, SHA-256
  reported. GitHub release assets are resolved through the API; `GITHUB_TOKEN` is
  used when present to avoid rate limits.
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

Each install writes a **receipt** to `<game>/.indiedeck/receipts/` listing every
file written and every file displaced. `uninstallReceipt` removes exactly those
files, restores the backups, and prunes the directories it emptied.

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

## Dependency stance

Core has no runtime dependencies, and the only dev dependencies are TypeScript
and `@types/node`. This is a tool that writes files into game folders and
downloads binaries; a large transitive dependency tree is a poor trade for
convenience that `node:zlib` already provides.

Sources use erasable-only TypeScript syntax, so `node --experimental-strip-types`
runs them directly and the build step is only needed for publishing.

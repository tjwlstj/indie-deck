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
   XUnity additionally requires a recognised active plugin/patcher payload:
   retained settings, translation cache or Common DLL alone are not an
   installed-translator badge.

Deep probes read IL2CPP metadata (tens of megabytes) to find TextMeshPro and the
new Input System. They are off during bulk scans and on for single-game commands.

`scanLibrary` detects explicitly registered ordinary game roots themselves,
deduplicates overlapping roots, then walks library roots to a configurable
depth and does **not** descend into a
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
4. If a rule asks for a font bundle, one is picked for the game's Unity line,
   unless `includeFont: false` is selected.
5. Concrete install steps and a config patch are generated.

Two deliberate properties:

- **An unknown version never blocks.** `unityVersionBelow` requires a known
  version to fire, and `satisfiesRange(undefined, …)` is true. Not knowing
  something is not evidence against it.
- **Unverified rules cannot block.** They are scored down far more gently than
  verified warnings, because their job is to inform, not to override the user.

This is a curated rule engine, not learned recommendation: the game list is
disk-scanned, while the signatures, provider catalogue and score adjustments are
declared registry data. Detection confidence is not runtime success probability.

`recommendGameFont` reports a declared Unity/TMP/glyph match with its original
confidence. `resolveFontPlan` is a narrower maintenance path: one compatible
installed XUnity variant plus its loader, known Unity version and positive TMP
evidence are required. It never installs a loader or translator payload, and
only patches `Behaviour.FallbackFontTextMeshPro`. A present atlas is reused.
Unknown evidence prevents this specific font action even though normal
translator resolution may still return advisory candidates.

## install

Every write goes through a **file transaction** (`install/transaction.ts`). The
distinction it enforces is the one that makes uninstall safe:

| operation | meaning | what uninstall does |
| --- | --- | --- |
| `create` | the file did not exist | delete it |
| `modify` | it did, and was displaced | restore the backup |
| `snapshot` | copied before an external patcher ran | preserve when changed without a post-write hash; explicit force may restore |

Deleting a file we merely overwrote destroys data that was never ours - a game's
own `plugins.js`, or a file another mod owns. The transaction resolves an
archive's file list *before* extracting so anything it is about to land on is
backed up first, and `rollback()` walks the journal backwards if any step
throws. Its result distinguishes complete restoration from partial restoration;
external tools and failed I/O can leave changes that need manual review.

Uninstall preserves both created and modified files whose recorded post-install
hash no longer matches. A snapshot without that hash is preserved when its
current contents differ from its baseline backup. Unresolved entries remain in
the receipt, so a later retry still has the original recovery evidence.
Rollback reports I/O failures instead of treating every attempted restore as
complete. The file transaction is process-local; durable crash recovery and
atomic file-plus-receipt activation remain planned.

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
separate `backups[]`) are migrated on read by the core/CLI. Desktop automatic
removal has a stricter boundary: it requires canonical v2 records with explicit
operations and post-install hashes for created/modified files. It reads and
validates each record once, rejects linked receipt/target/backup paths and
out-of-scope backups, and protects the detected executable and its containing
directories. Legacy records need manual review before desktop removal. This
admission is bounded to 2 MiB per receipt, 10,000 entries and 128 records.
The opened file is read as a bounded snapshot, not an unbounded JSON read. This
does not guarantee atomic exclusion against an external process replacing a
target after validation.

Standalone fonts have a separate v2 `font` receipt. The translator's original
hash and baseline backup are not advanced. Health recognises one intact font
overlay only when its config post-hash matches the current file and its safe
internal backup hashes to the translator's prior config bytes. Changed
predecessors, damaged fonts, linked paths or ambiguous receipts remain drift.
Desktop removal undoes the font overlay before the translator receipt, restoring
the predecessor before the original removal checks. Removing a translator
receipt alone through the core API remains hash-protected and may preserve the
overlaid config rather than remove it.

The desktop caches separate authoritative with/without-font plans, exposes only
opaque ids, validates the selected operation purpose, and rebuilds the plan from
fresh disk evidence before writing. Font/config/metadata junctions and existing
same-name atlas overwrites are rejected. This remains a process-local preflight,
not atomic exclusion against a concurrent external writer.

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

## Local external-tool handoff

The desktop's `mtool.ts` is a separate Windows handoff adapter, not a core
translator installer. `LauncherConfig.externalTools.mtoolRoot` distinguishes
an omitted value (probe the fixed `D:\MTool` default), an explicit system-picked
folder, and `null` (disconnected, with no default fallback). A known bundle
parent or `Tool` folder is accepted. Validation only reads the public manifest
and bounded PE header, checks the expected `MToolClient`/`www/index.html`
layout, and rejects linked path ancestors. It does not authenticate a publisher
or inspect MTool's settings, game library or activation files.

Only `rpgmaker-mv`, `rpgmaker-mz` and `rpgmaker-rgss` profiles receive the
detail card. Main re-detects a registered game, validates the contained `.exe`,
revalidates the tool, then spawns `MTool.exe` with either no arguments or one
absolute game-executable argument. The working directory is the validated Tool
directory; `shell: false` prevents the path from becoming shell syntax. Renderer
requests contain only a main-owned game id; folder configuration comes from
main's system picker, not renderer-provided executable/argument text. The
handoff waits for spawn acknowledgement and shares the launcher's pending-write
gate, but does not supervise MTool's later task or reserve the game for its
whole external session.

The result explicitly reports `autoApply: false`. It means the open request
was acknowledged, not that MTool selected the game or translated it. The
separate **Refresh after applying** action uses the targeted game refresh and
normal revision merge to read external disk changes. No receipt or automatic
backup is created by opening MTool. MTool files, game changes, updates and
removal are outside IndieDeck ownership; users must back up first and avoid
concurrent external work and IndieDeck installs/mod edits. Wolf RPG and other
MTool-supported engines are not enabled by this adapter. Actual MTool runtime
selection and translation remain unverified; the
[official tutorial](https://mtool.app/tutorial.php?lang=en) and
[author's CLI discussion](https://bbs.mtool.app/topic/850/mtool%E5%90%AF%E5%8A%A8%E5%91%BD%E4%BB%A4%E6%98%AF%E5%90%A6%E6%9C%89%E5%8F%82%E6%95%B0/3)
are documented handoff guidance, not local runtime evidence.

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

maintenance.start(          look up ITS OWN cached plan
  {gameId, planId,      ->   re-detect and compare a fresh resolved plan
   kind, requestId})        reserve one operation and return operationId
                             queued file writer -> structured progress
                             targeted re-detect -> persist library revision
                        <-   terminal outcome + library/detail/config postState

game.launch(gameId)     ->   re-detect, use the detected executable
```

So the worst a compromised renderer can ask for is "act on a game the main
process already knows about" - not "extract this archive into C:\Windows" or
"spawn this binary". Config writes are field-filtered, scan roots can only be
added through the OS folder picker opened by the main process, and
`shell.openExternal` accepts `https:` only.

The renderer subscribes once to operation progress/outcomes, then requests the
active snapshot on boot. Main retains outcomes until ACK; ten unacknowledged
results block further starts instead of discarding recovery evidence. This
recovers renderer reloads within the same process, not an interrupted OS/app.
Library revisions are persisted by an atomic same-directory replacement.
Selection tokens and per-game snapshot revisions stop late detail/config
responses from overwriting a newer selection or post-mutation state.

## Launcher self-update

`launcher-updates.ts` wraps `electron-updater` behind a main-owned state
machine. A supported installed Windows build checks the stable GitHub Releases
feed about eight seconds after startup only if its snapshot remains idle, so the
timer cannot replace a manual action already in progress. It does not download
or install as a side effect: `autoDownload` and `autoInstallOnAppQuit` are false,
and Settings exposes separate check, download and confirmed restart/install
actions. Prereleases and downgrades are rejected.

The renderer receives bounded snapshots over fixed IPC calls and cannot provide
a feed URL, release URL, executable path or native updater options. Each snapshot
has a monotonic `seq`; the renderer subscribes to `updates:status` before asking
for `updates:current`, so a reload in the same main-process lifetime cannot
replace a newer progress/downloaded state with an older response. Raw provider
errors and download paths are not exposed. Mode admission is main-owned:
`PORTABLE_EXECUTABLE_DIR` selects portable, `app.isPackaged === false` selects a
source-development run, and policy disablement, non-Windows packages or a
missing packaged `app-update.yml` select disabled. Remaining supported Windows
packages are installed mode. Thus electron-builder's `win-unpacked` output is a
packaged layout and is not classified as development merely because its files
are unpacked. Portable, development and disabled modes never invoke native
update operations and instead expose the fixed official latest-release page for
manual replacement.

Check and download do not mutate game files, but restart/install has a stricter
gate. Main first confirms that the mutation queue and `OperationManager` are
idle and that Windows is not ending the session, then synchronously reserves
`updateRestartReserved`. Every later mutation admission rejects while reserved;
main checks the safety conditions again before native quit. Native installer
launch errors release the reservation and keep the verified download retryable.
This direct gate is required because `quitAndInstall()` closes windows before
Electron's normal quit notification, so the BrowserWindow close handler is not
the installation authority.

The installed path uses `autoRunAppAfterInstall = true` and
`quitAndInstall(false, true)`. The first argument deliberately keeps the assisted
NSIS wizard visible; after the user completes it, the updater is configured to
run IndieDeck again. This is not a silent or unattended install.

Controller and renderer-model tests use a mocked updater to verify explicit
actions, version admission, progress, reload sequencing, busy/shutdown gates and
failure retry. Korean and English desktop flows also run the real
main/preload/renderer event path in an installed-layout harness, but its native
updater methods are mocked and it never starts NSIS. Packaging checks separately
inspect the real NSIS artifact, blockmap, `latest.yml` and packaged provider
configuration. Release smoke disables network updates, and a public update
driven by the new 0.1.3 UI remains unverified until a real `0.1.3 → N+1` pair is
exercised.

## Unity translator maintenance

Existing managed translator installs cannot be reapplied through the desktop
Install action: overwriting their fixed-name receipts would lose the original
baseline. Duplicate/drifted payloads are also blocked with a visible reason.
The separate `translator-maintenance.ts` now offers bounded XUnity remove and
reinstall actions. Main-owned previews enumerate exact recognised files with
hashes, and confirmation is separate from scanning or the normal Install
action. Settings, translations, fonts, game executables and loaders are
preserved. Shared Common/ResourceRedirector/MonoMod/Cecil copies need unchanged
canonical translator ownership before maintenance can replace them; unknown
copies are preserved. Unknown dedicated-tree files, ambiguous ownership,
linked paths and ReiPatcher installations block maintenance.

Reinstall reuses a compatible existing BepInEx/MelonLoader host, validates the
entire registered ZIP before mutation, then quarantines old files and metadata
under `.indiedeck/backups/maintenance-<uuid>/`. It carries the original receipt
baselines and untouched config/font entries forward, retaining install
chronology. File budgets are 32 MiB each and 128 MiB per current snapshot/new
payload. Process-local failures restore the pre-operation state where possible;
partial rollback remains visible with recovery paths. This is not durable OS
crash recovery, arbitrary translator migration or loader replacement. The
general core/CLI installer has not been promoted to this maintenance contract.

## Game archive versions

`game-archives.ts` inspects OS-picked ZIP/7z/RAR sources and exposes display
metadata through an opaque candidate id. Main alone owns the source path and
binds import to its inspected SHA-256. Classic stored/deflate ZIP import streams
bounded entries into an owned hidden staging directory, verifies CRC and
output sizes, requires one detected game with an executable, then publishes a
new `game-versions/<uuid>` directory under launcher data. The actual game root
is registered so targeted refresh and ordinary full rescan retain the row.

Original archives, previous game versions and unrelated library folders are
never overwritten or deleted. Same-hash valid stored copies are reused.
Records contain original name/hash, import time, engine, optional user label
and a filename-derived version guess explicitly not asserted as game version.
No saves/mods/config are automatically migrated between versions. 7z/RAR are
recognised-only; ZIP64, encryption, split archives, unsupported encodings,
unsafe/linked/colliding paths and forged IndieDeck metadata are rejected.
Budgets are a source below 4 GiB, 50,000 entries, 32 GiB expanded and 16 path
components. Disk-space availability and game runtime compatibility are not
guaranteed. Import shares the pending-write gate and retains a monotonic
main-owned progress snapshot across renderer reload, not OS/app restart.

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

# Changelog

All notable changes to IndieDeck are documented here. Versions follow Semantic
Versioning while the project is pre-1.0.

## [Unreleased]

## [0.1.17] - 2026-11-10

### Added

- Fullscreen library mode with keyboard and standard gamepad navigation,
  repeat-safe activation, modal boundaries and visible focus states.
- Xbox/Steam registration details, user-selected Windows shortcut export and
  strict `--fullscreen` / opaque `--launch-game` entry options for both startup
  and an already running launcher. Official Windows gaming settings actions.
- Owned game session tracking, duplicate-launch prevention, configurable
  minimize-on-launch and optional restore, with quiet background image/controller
  work and a deferred startup update check.

### Security

- Launch directory/executable and identity checks remain required when the
  optional launch antivirus scan is off. Revalidate after scanning before spawn.
- Reject game-file maintenance/config/mod writes for tracked games and version
  activation while owned games are active. No game priority, affinity, power-plan
  or unrelated-process changes are introduced.

### Fixed

- Apply fullscreen startup intent when creating the native window and verify
  packaged startup before publishing. The unpublished v0.1.16 validation tag
  failed its packaged fullscreen startup gate and is superseded.

## [0.1.15] - 2026-11-10

### Added

- Manual cover images through a file picker, a picker starting in the game
  folder, and native file drag and drop. Validated copies are stored in launcher
  data, appear immediately in the library and persist across restarts.
- Manual cover removal restores the previous store selection or automatic image.
- Browser companion connection-data copy, pasted product URL/JSON preview,
  connection-file drop, editable display names and explicit links to ordinary
  installed games. Game detail offers a shortcut with its game preselected.

### Fixed

- Network errors containing signed CDN URLs no longer appear as signature
  failures solely because a URL contains a signature query parameter. This
  changes error presentation; it does not resolve a GitHub service outage.
- Failed Windows CI packaging remains nonzero through builder shutdown handlers.

## [0.1.14] - 2026-11-08

### Added

- Library sorting, favorites, and non-destructive same-name candidate views.
- A global opt-out for game launch scans (enabled by default); installation and
  MTool security checks continue to apply.
- Browser companion installation guidance, GOG cover search and bounded launch
  diagnostics for processes started by the launcher.
- The unpublished v0.1.13 validation tag is superseded after an upstream
  artifact download failed during release packaging.

## [0.1.12] - 2026-11-08

### Security

- Override vulnerable build-time minimatch versions with 11.0.5 while leaving
  unaffected older dependency branches unchanged. CI and release checks now
  reject moderate-or-higher dependency advisories.
- The override crosses upstream major-version ranges. Windows distribution and
  file-filter behavior are checked; macOS universal packaging is not verified.

## [0.1.11] - 2026-11-04

### Added

- A separate Microsoft Defender provider for Windows desktop security checks,
  with engine/signature status, scoped no-detection/attention/not-checked results,
  explicit intelligence updates, cancellation and renderer-reload recovery.
- Required checks for desktop translator/font archives before use, the game ZIP
  source and unpublished extraction stage before publication, each launched game
  executable, managed version directories before activation, and MTool/selected-
  game executables before handoff. Manual full game-folder checks are available
  from game details.
- Security settings and official Windows Security/Malware Zero help actions.
  Malware Zero remains a separate manual tool; its package and database are not
  embedded or reused.

### Hardened

- Canonical matching of the same local application document accepts Chromium's
  literal tilde and Node's `%7E` file-URL spelling for Windows short paths while
  retaining the exact window/frame, path, query and fragment restrictions.
  The failed v0.1.10 validation tag was not published as a release.
- Registered asset downloads require approved HTTPS sources and redirects,
  scoped GitHub authorization, transfer/time bounds and ordinary cache files.
- Main validates the exact application WebContents/frame/document for IPC,
  denies browser permissions and renderer remote requests, and restricts generic
  external links to canonical declared URLs.
- Game and external-tool process environments omit named credential families
  and Node/Electron injection controls while preserving normal OS/game values.
- ZIP preflight rejects Windows path aliases, selected external-decoder entries
  use protected arguments, and copied mod/font inputs are bound to inspected
  content before receipt-backed writes.
- Electron is updated to 43.8.7. Its official release note describes a Wayland
  hidden-parent-window crash fix; this update is not presented as a CVE fix.

### Scope notes

- The first scanner supports standard Windows layouts and defaults to 20,000
  files, 20 GiB and 15 minutes. Unavailable, stale or incomplete checks block the
  required desktop actions. Core/CLI scan callbacks are opt-in.
- The seven-day intelligence-age cutoff is an IndieDeck freshness policy, not
  a Microsoft definition-expiry date.
- Existing Defender cloud/real-time policies still apply. No silent elevation,
  protection disable, exclusion change, automatic cleanup or new game firewall
  is introduced. This is not an execution sandbox or a detection guarantee.
- The existing launcher-updater GitHub/SHA-512 path has no new antivirus gate.
- A real local native probe checked one unchanged 77-byte synthetic C-drive text
  file. It did not update intelligence or inspect real games, D-drive contents,
  Malware Zero databases or malware samples.
- Post-fix Korean/English source flows and local packaged ASAR security/history
  checks passed on Electron 43.8.7. The package checker verified 64 required
  entries and 73 critical runtime hashes.
  Post-fix source verification reported 532 tests: 530 passed, none failed and
  two skipped, plus build and registry checks. Actual portable startup passed
  both normal and native 8.3 TEMP/TMP cases with exit zero and screenshots.
  Exact-commit CI and public release remain separate checkpoints recorded after
  completion in the security verification document.

## [0.1.9] - 2026-11-03

### Added

- A separate game-detail card for the latest saved pre-reinstall comparison,
  including a recorded timestamp, review after app restart and explicit deletion
  of that game's record. The card remains available without an active translator
  payload or maintenance preview.
- A bounded local store retaining the latest report for at most 20 games. Only
  schema-allowed values and relative configuration paths are persisted;
  credentials, arbitrary text, directories and unknown key names are omitted.
  The saved view identifies values deliberately hidden from the record.

### Scope notes

- A saved report describes the earlier reinstall review. It does not restore
  settings, rerun detection or simulate upstream configuration migration.
- Damaged, oversized or linked history is preserved and blocks history writes.
  A history-save failure does not change a committed reinstall into an operation
  failure; the report remains available for the current session with a warning.
  Drive disconnection and incomplete scans do not automatically prune records.
- The full source suite reported 435 tests: 433 passed, none failed and two were
  skipped. This change adds 11 history-store and two renderer-helper cases.
  Korean and English history flows passed through four separate Electron
  processes each, covering persisted review, deletion, a later empty startup and
  damaged-file preservation with unchanged game bytes. Full desktop-flow,
  packaging and public-release results are separate checks.

## [0.1.8] - 2026-11-03

### Added

- Current-option and registered-schema reference comparison in Unity translator
  maintenance and reinstall confirmation. The report distinguishes missing file
  keys, declared version additions, mapping/file-location moves and unconfirmed
  evidence while keeping the existing configuration unchanged.
- Primary and fallback provider version requirements and configured-field status
  in the comparison, with credential, URL and identifier values omitted. Safe
  boolean and numeric provider options can show their current values.
- A way to reopen the pre-reinstall comparison from the completed operation and
  maintenance cards. Main retains the latest redacted report per game for at
  most 20 games through renderer reloads; quitting the application clears it.

### Fixed

- Saved non-secret provider fields and boolean options now reflect their actual
  values; primary and fallback settings appear as separate labelled groups.
- Translation settings appear earlier in game details, technical mapping
  information is collapsed, and save/backup feedback remains visible after the
  form refresh. Saving refreshes related game details without changing global
  defaults for new installations.

### Scope notes

- Registered schema defaults are partial reference data, not versioned upstream
  defaults or a plugin migration simulation. Reinstall does not reset or move the
  user's settings. Config-tag hints and conflicting versions, including a
  receipt/DLL disagreement, cannot establish a confirmed option-introduction
  claim.
- Tests use synthetic game/config fixtures and offline Electron flows. Live
  translation/API success and durable comparison history remain unverified or
  unimplemented respectively.
- The full source suite reported 422 tests: 420 passed, none failed and two were
  skipped, including 26 new core/comparison/renderer cases. Desktop flows and
  packaging/release checks are recorded separately.

## [0.1.7] - 2026-11-02

### Added

- Store/browser connection settings with fixed official site, login, library
  and client-download entry points, plus selected official-client protocol
  handoffs. Browser or launcher dispatch remains distinct from verified account
  access, ownership and completed installation.
- Optional explicit-click browser companion product-link export. Review a
  system-picked metadata file and optionally associate its product with a
  managed game without changing installation ownership or game files. Open the
  connected product pages from that game's detail view.
- Versioned connection persistence and renderer ordering guards; damaged
  connection data is preserved and blocks saved-state changes until recovered.

### Scope notes

- Personal browser profiles, passwords, cookies and history are not imported.
  Manual browser-extension loading remains separate from the launcher package.
  Direct OAuth/butlerd login, store downloads and Native Messaging remain planned.

## [0.1.6] - 2026-11-02

### Added

- Managed product, release and installation records around downloaded Classic
  ZIP games. A full package can be installed as a new game or explicitly linked
  as another version of an existing managed game. The first copy becomes active;
  later copies stay inactive until selected. Older copies remain in the library.
- Version selection in archive settings and managed game details, with a
  confirmation before joining a package to an existing game/edition. Labels and
  filename version hints are not treated as verified publisher versions.
- A durable managed-ZIP installation journal and recovery of published copies
  whose library registration was interrupted. Recovery retains previous active
  copies and only cleans staging directories whose identity and ownership match.

### Scope notes

- No save, configuration, mod or translator-receipt migration is performed.
  Shared save paths outside game folders may still be used by individual games.
  This journal does not change the process-local translator transaction scope.
- Store login/download clients, official-client handoffs, patches and additional
  archive formats remain planned.

### Verification notes

- Disposable ZIP/catalog fixtures exercise explicit grouping, old-version
  preservation, publish/register recovery without the source archive, repeated
  recovery, atomic activation-save failure, storage-identity mismatch, low disk
  space and ownership/link checks during stage cleanup. Real power loss and
  removable-drive disconnects are not simulated by these fixtures.
- Korean and English desktop flows drive product confirmation and explicit
  version activation/reload/revert through the real main/preload/renderer path;
  no purchased game, store account or game process is used.

## [0.1.5] - 2026-11-02

### Added

- Game artwork in the library and detail views. Local covers are used before
  automatic Steam artwork, while a user-selected Steam image takes precedence.
  Steam artwork can be found using a matching installed manifest or
  `steam_appid.txt`, or selected from an explicit title search. The latter sends
  the title to Steam and stores the selected app ID in launcher data.
- Bounded image decoding and download sizes, lazy loading, concurrency limits,
  main-owned game identity and Steam search-result validation. An app ID may be
  a development hint rather than proof of a correct match; users can select a
  different result. Cached image bytes are kept only in memory for the session.
- Local MTool handoff for Wolf RPG, Ren'Py and KiriKiri alongside RPG Maker.
  The user still controls translation inside MTool; success is not inferred.

### Security

- Updated Electron to 43.8.6 and patched affected build dependencies. The npm
  high-severity audit passes; 15 moderate advisory findings remain in the
  build-tool minimatch dependency tree.

### Verification notes

- Offline tests exercise the game artwork search/selection and saved mapping,
  including a renderer reload, with mocked Steam responses. Actual MTool/game
  execution and a public-feed upgrade from a previous version are not implied.

## [0.1.4] - 2026-10-05

### Fixed

- Drive-root and UNC library containment no longer append a duplicate separator,
  so a registered `D:\\` can display and address its discovered child games.
- Engine-marker-only parent directories no longer hide playable builds below
  them. Bulk discovery first requires a regular, non-helper executable before
  performing engine classification; direct `detectGame` diagnostics are intact.
- `Windows`, `Temp`, `Program Files` and `Users` are no longer globally forbidden
  game-folder names. Actual OS locations, metadata, dependencies and links remain
  excluded, and overlapping registered roots are deduplicated.

### Added

- Settings for a bounded 0–12-level scan depth, with 6 recommended for broad
  libraries. New configurations default to 6; existing saved choices, including
  2, are preserved. Save the depth and request a full rescan to apply it.
- Main-owned, reload-recoverable scan progress with visited/candidate/game counts,
  current directory, depth-limit and unreadable-directory notices, and explicit
  cancellation. Directory counts are not presented as a fabricated percentage.
- Cooperative asynchronous traversal with a 20,000-directory budget. Cancelled
  or over-budget scans retain the previous saved index. Access-error branches
  retain their previous rows rather than being interpreted as game deletions.
- Bulk engine scoring separately caps each engine's directory-listing probes at
  128. Inconclusive engines cannot swallow deeper games; unaffected engine
  signatures remain usable, and affected previous rows are retained with a notice.
- A source-linked discovery guide comparing Playnite candidate scanning with
  Lutris/Steam and Heroic/Legendary installation-manifest discovery. Store imports,
  unknown-engine registration and shortcut/batch execution are not implemented.

### Distribution notes

- The stable installer/update artifacts include this scanner and UI. Installed
  0.1.3 users can request the new release through Settings → Launcher updates;
  Portable users replace the executable manually. Native public-feed
  `0.1.3 → 0.1.4` installation is not claimed by offline updater tests.

## [0.1.3] - 2026-10-05

### Added

- Per-operation installation/removal progress with real loading bars, explicit
  stages, current-asset byte counts, collapsible logs and persistent result cards.
- Renderer reload recovery through main-owned operation snapshots and outcomes.
- Targeted game refresh after success or failure, atomically saved library
  revisions and one post-state for badges, audit, statistics, detail and config.
- Offline Korean/English Electron flows for install/removal and a mocked
  installed-layout launcher update, including progress, renderer reload, busy
  restart refusal, asynchronous native failure, retry and the restart mutation
  gate.
- Optional Unity TextMeshPro font recommendations by detected Unity line and
  target language, including opt-in translator-plan fonts and a bounded
  standalone fallback-font action for an existing compatible XUnity install.
- A local MTool handoff for RPG Maker MV/MZ and RGSS games, with an explicit
  bundle connection, single game-executable argument, open-only/manual fallback
  and targeted refresh. IndieDeck does not install, update or own MTool changes.
- Previewed cleanup and compatible reinstall for recognised Unity XUnity
  translator payloads, with retained backups, original-baseline receipt
  inheritance and process-local rollback. Unknown files, unsafe ownership and
  ReiPatcher installations remain blocked.
- Side-by-side classic ZIP game import with source hashes, optional labels and
  library registration. 7z and RAR are recognised but still require manual
  extraction.
- A Settings launcher-update card for installed builds. Startup performs a
  check-only request after eight seconds only while update state remains idle;
  checking again, downloading and confirming restart are separate user actions.
  Progress and downloaded state survive a renderer reload through a main-owned
  monotonic snapshot.

### Changed

- Launcher downloads and installs are no longer automatic. Native
  `autoDownload` and `autoInstallOnAppQuit` are disabled. After confirmation,
  IndieDeck closes and opens the assisted NSIS updater; the wizard is visible
  and the app is configured to relaunch after it finishes.
- Portable, source-development and updater-disabled preview modes expose a fixed
  official latest-release fallback instead of invoking the native updater.

### Security

- Updated Electron to 43.7.7 and `js-yaml` to 4.3.2 to incorporate their
  upstream security fixes.

### Fixed

- Late game/config responses can no longer replace a newer selection or mutation.
- User changes to modified files and unverified snapshots survive removal;
  unresolved entries retain their receipt for a later recovery attempt.
- Rollback gaps and receipt-write failures retain their actual file outcomes.
- Reusing an already installed loader no longer requests unnecessary user work.
- Concurrent file changes and game launches are rejected during maintenance;
  one launcher instance owns the mutation queue.
- The ordinary Desktop Install action continues to block reinstalls that would
  overwrite an original management baseline. Recognised XUnity payloads use the
  separate scoped cleanup/reinstall preview; other update/repair paths remain
  blocked rather than being treated as an ordinary install.
- Desktop removal validates the exact receipt object it will apply, rejects
  legacy/hashless/escaping or linked records and protects the detected executable.
- Copied font/mod files now retain post-install hashes; canonical receipt IDs
  accept safe Korean names and internal spaces. Copy/hash failures roll back
  instead of leaving an apparently successful, unremovable install.
- Update installation is refused while game-file mutations are pending or
  Windows is ending the session. The restart reservation is acquired before
  native quit, blocks new mutations, and is released after synchronous or
  asynchronous installer-launch failure so the verified download can be retried.

### Distribution notes

- Offline updater tests cover the controller and renderer state model with a
  mocked native updater. The Korean/English desktop flows use an installed-layout
  harness but do not launch native NSIS. Distribution checks cover the real NSIS
  artifacts, blockmap, `latest.yml` and packaged update configuration. None of
  those lanes proves a live public-feed installation.
- A public `0.1.2 → 0.1.3` update exercises the older 0.1.2 client. The new
  0.1.3 settings/download/restart flow remains unverified against a real public
  `0.1.3 → N+1` pair until that later stable release exists and is recorded.

## [0.1.2] - 2026-08-23

### Added

- The launcher now shows its own version: a chip beside the brand and a fuller
  about line (installed vs portable, update mode) in the new settings view.
- Assisted Windows installer. The setup wizard shows the product name and
  version and lets the user pick the installation directory.
- In-place upgrade across directories: the installer reads the previous
  installation location from the registry and targets that folder even when it
  is not the default, so an old copy elsewhere is detected, uninstalled and
  replaced where it stands.

### Changed

- Simplified top bar: brand with version, search, refresh and settings. Global
  options moved into an in-app settings page (general, translation defaults,
  library roots) - no navigation, so the CSP/IPC boundary of the single window
  is untouched. Plan resolution now reads saved defaults instead of DOM state.
- Game detail pins Play / Open folder in a sticky header visible at any scroll
  depth; launching is disabled with an explanation while a task runs, and the
  uninstall action moved out of the fixed bar to the translator plans it
  undoes.
- Empty library offers an add-folder call to action.

## [0.1.1] - 2026-08-23

### Added

- Disk-evidenced translator install health. Per game, the launcher now
  classifies installs as healthy, update-available, version-conflict,
  duplicate-variants, multiple-versions, orphaned, unmanaged, managed-drift,
  corrupt-receipt, newer-than-registry or version-unknown, keeping every issue
  instead of one verdict.
- A strict receipt reader that preserves damaged receipts as evidence rather
  than silently dropping them, distinguishing parse, schema and unsafe-entry
  failures.
- Ownership hashes: files recorded by a receipt are compared against what is on
  disk, so hand edits surface as drift instead of being overwritten later.
- Shared core test fixture module (fake game folders, PE version resources,
  receipt samples) used by the new installation-health tests.

### Changed

- Translator update findings compare against the best release compatible with
  the specific game - engine, backend, architecture and endpoint - instead of
  the newest registry-wide release.
- Logical loader variants that share marker paths are disambiguated by the
  game's scripting backend before any duplicate or orphaned finding fires.

### Documentation

- Added `docs/launcher-ux-guide.md`, the install/recovery UX implementation
  contract, including per-step definitions of done for the remaining rollout.

## [0.1.0] - 2026-08-21

### Added

- Windows x64 per-user installer and single-file portable executable.
- Tag-driven GitHub Release workflow with version consistency checks, tests,
  dependency audit, packaged-app smoke test and SHA-256 checksums.
- Installed-build update checks backed by GitHub Releases. Updates install only
  after the launcher closes normally; portable builds update manually.
- Korean and English catalogues across the desktop, CLI and compatibility
  findings.
- Declarative detection for 17 game engines, version-aware translator planning,
  transactional translator/mod management, configuration editing and health
  checks.

### Fixed

- Case-insensitive probe cache lookups now resolve the real directory spelling,
  so Linux CI and case-sensitive filesystems classify RPG Maker projects
  consistently.
- Renderer configuration reads can no longer request unredacted credentials.
- Configuration previews, CLI JSON and write results cannot return executable
  patches or plaintext credentials to unprivileged output, including
  invalid-plan responses.
- The desktop preload bridge is sandboxed, post-load navigation is denied, and
  only HTTPS links may be opened externally.
- Filesystem mutations are serialised in the main process, and a normal window
  close is blocked until queued writes finish so an update cannot interrupt a
  transaction.

### Distribution notes

- This release is unsigned. Windows SmartScreen can therefore show an unknown
  publisher warning; compare downloads with the attached `SHA256SUMS.txt`.
- The updater artifacts and packaged update configuration are verified. A real
  0.1.0-to-0.1.1 update can only be tested after the next version is published.

[0.1.0]: https://github.com/tjwlstj/indie-deck/releases/tag/v0.1.0
[0.1.1]: https://github.com/tjwlstj/indie-deck/releases/tag/v0.1.1
[0.1.2]: https://github.com/tjwlstj/indie-deck/releases/tag/v0.1.2
[0.1.3]: https://github.com/tjwlstj/indie-deck/releases/tag/v0.1.3

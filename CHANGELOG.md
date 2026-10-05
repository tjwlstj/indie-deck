# Changelog

All notable changes to IndieDeck are documented here. Versions follow Semantic
Versioning while the project is pre-1.0.

## [Unreleased]

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

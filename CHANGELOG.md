# Changelog

All notable changes to IndieDeck are documented here. Versions follow Semantic
Versioning while the project is pre-1.0.

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

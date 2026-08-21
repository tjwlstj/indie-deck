# Changelog

All notable changes to IndieDeck are documented here. Versions follow Semantic
Versioning while the project is pre-1.0.

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

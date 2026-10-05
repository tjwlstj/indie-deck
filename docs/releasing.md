# Releasing IndieDeck

The release is produced by GitHub Actions from an annotated `vX.Y.Z` tag. The
workflow builds on Windows, verifies the packaged application, creates checksums
and publishes a GitHub Release only after every gate passes. A draft is used
while assets are attached, so the updater cannot observe a partial release.

## 1. Prepare the version

Use Node 22.12 or newer. Update the version in all four manifests:

- `package.json`
- `packages/core/package.json`
- `packages/cli/package.json`
- `packages/desktop/package.json`

Keep every `@indiedeck/core` workspace dependency at that exact version, update
`CHANGELOG.md`, then refresh the lockfile with `npm install`. Confirm the release
metadata before committing:

```powershell
npm run release:check
npm run verify
npm run desktop:flow
npm audit --audit-level=high
npm run dist:win
npm run package:check
git diff --check
```

`npm run dist:win` creates the unpacked application, NSIS installer, portable
executable, blockmap and `latest.yml` under the ignored `release/` directory.
Local output is evidence only; the public assets always come from the clean
GitHub Actions checkout.

For an unpacked development preview, use `npm run pack:win` and inspect its
runtime with `node scripts/check-package.mjs release/win-unpacked/resources/app.asar --runtime-only`.
This opt-in check verifies runtime entries and the version only; it is not a
substitute for the full distribution/updater gate above.

## 2. Tag the verified commit

Push the release commit to `main` and wait for the entire `CI` workflow to pass.
Tag that exact green commit; never tag an unverified working tree:

```powershell
$version = node -p "require('./package.json').version"
$tag = "v$version"
git tag -a $tag <green-commit-sha> -m "IndieDeck $tag"
git push origin $tag
```

The tag must match a stable package version exactly. The release workflow
rejects lightweight tags, commits outside `origin/main`, version/lockfile
mismatches, and any exact-tag failure across Windows/Linux on Node 22/24 before
packaging.

## 3. What the workflow publishes

- `IndieDeck-Setup-X.Y.Z-x64.exe` — per-user NSIS installer and updater target
- `IndieDeck-Setup-X.Y.Z-x64.exe.blockmap` — differential-update metadata
- `IndieDeck-Portable-X.Y.Z-x64.exe` — standalone portable launcher
- `latest.yml` — installed-build update metadata
- `SHA256SUMS.txt` — checksums for all four files above

Before publication `npm run package:check` opens the packaged ASAR to assert
that the desktop entry point, renderer, core runtime, updater, registry and
locale data are present. It also verifies `app-update.yml`, `latest.yml` and the
exact installer/portable filenames. The workflow then smoke-tests the unpacked
application and portable wrapper, silently installs NSIS, boots that installed
copy, runs its uninstaller, and requires rendered screenshots, zero exit codes
and complete removal of the isolated install directory.

If a run fails after its draft was created, inspect the draft and failed job,
delete only that unpublished draft in the GitHub UI, and rerun the tag workflow.
If workflow logic itself must be fixed before the first publication, land and
verify that fix on `main`; an unpublished tag with no Release may then be
recreated at the new green commit. Do not move or reuse a tag after its Release
has become public; fix forward with a new patch version.

## Signing status

The current Windows packages are unsigned. That is acceptable for the initial
public build but may cause Windows SmartScreen to report an unknown publisher.
Checksums prove byte identity, not publisher identity. When a Windows signing
certificate is available, configure it through encrypted GitHub Actions secrets
and keep the certificate and password out of the repository.

## Updater verification boundary

Only supported installed Windows NSIS builds invoke the native updater. About
eight seconds after startup, IndieDeck checks the stable GitHub Releases channel
only if its update snapshot is still idle, so the timer cannot replace a manual
check or download the user already started. It does not download:
`autoDownload`, `autoInstallOnAppQuit`, prereleases and downgrades are disabled.
In **Settings → Launcher updates**, the user may check again, explicitly
download with visible progress, and confirm **Restart and install** only after
the selected version is fully downloaded.

That confirmation reserves a main-process restart gate before native quit. It
is refused while a queued or active game-file mutation exists and while Windows
is logging off or shutting down; the reservation rejects new mutations until
quit. A synchronous or asynchronous installer-launch failure releases the gate,
keeps the verified download available and permits an explicit retry. The updater
uses `quitAndInstall(false, true)` with `autoRunAppAfterInstall = true`: the
assisted NSIS wizard is visible, and the app is configured to relaunch after the
wizard finishes. Do not describe this as silent, unattended, automatic-on-exit
or guaranteed without completing the wizard.

Update state is owned by main and carries a monotonic sequence. The renderer
subscribes before requesting the current snapshot, so checking, progress,
downloaded and retry states recover across a renderer reload in the same app
process. This is not persistence across an app or OS restart. The renderer can
request fixed check/download/install actions but cannot supply a feed URL,
release URL or executable path.

Mode admission is explicit. `PORTABLE_EXECUTABLE_DIR` selects `portable`;
an unpackaged source run (`app.isPackaged === false`) selects `development`;
policy disablement, a non-Windows package or missing packaged `app-update.yml`
selects `disabled`; every remaining supported Windows package is `installed`.
An electron-builder `win-unpacked` directory is still a packaged layout, so it
must be classified by that metadata rather than by the word “unpacked”.
Portable, development and disabled modes never invoke native update actions;
their settings card opens the fixed official latest-release page for manual
replacement. Installed mode alone uses `latest.yml`.

There are three distinct evidence lanes:

1. `launcher-updates.test.ts` and `launcher-update-renderer.test.ts` use a mocked
   native updater to verify the controller, progress, retry, shutdown/busy gates,
   IPC-facing snapshots and renderer reload ordering without network access.
   The Korean and English `desktop:flow` runs additionally boot an installed-
   layout harness with mocked native check/download/install methods and drive the
   actual Electron main/preload/renderer events. They verify explicit download,
   progress, reload recovery, config-write busy rejection, asynchronous native
   failure recovery, retry and the post-reservation mutation gate; they do not
   start native NSIS.
2. `npm run package:check` and the release workflow verify the real packaged
   updater configuration, NSIS installer, blockmap, `latest.yml`, filenames and
   hashes. Release smoke runs with updates disabled, so it does not download or
   install from GitHub.
3. Only the following public-feed exercise proves one specific real `N → N+1`
   pair. Passing lanes 1 and 2 is necessary but is not a substitute for lane 3.

For every release after 0.1.0, keep the previous installed version and exercise
this end-to-end check before calling the updater proven for that pair:

1. Install version `N` and add a harmless test library root.
2. Publish stable version `N+1` with `latest.yml`, installer and blockmap.
3. Launch `N`, wait for the delayed check, and verify it reports `N+1` without
   starting a download.
4. In Settings, explicitly download `N+1`; verify progress, downloaded state and
   renderer-reload recovery.
5. Start a harmless game-file operation and verify restart/install remains
   unavailable until that operation reaches a terminal state.
6. Confirm restart/install, complete the visible assisted NSIS wizard, and verify
   IndieDeck relaunches as `N+1` with the test library data retained.
7. Record the exact pair, artifacts and result in the release notes.

Publishing 0.1.3 cannot by itself prove the new flow: a public
`0.1.2 → 0.1.3` update runs 0.1.2's older updater, while the new 0.1.3 UI has no
newer stable target to download. Until a controlled equivalent or a later public
`0.1.3 → N+1` pair is exercised, record the new public-feed flow as unverified.

Pre-releases are not the default update channel. Do not use one as proof of the
stable updater path without explicitly configuring and documenting a separate
channel.

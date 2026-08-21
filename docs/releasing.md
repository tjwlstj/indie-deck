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
npm audit --audit-level=high
npm run dist:win
npm run package:check
git diff --check
```

`npm run dist:win` creates the unpacked application, NSIS installer, portable
executable, blockmap and `latest.yml` under the ignored `release/` directory.
Local output is evidence only; the public assets always come from the clean
GitHub Actions checkout.

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

Only installed NSIS builds run the updater. Portable builds opt out because
there is no stable installation directory to replace. IndieDeck checks after
startup and downloads in the background, but never requests an updater-driven
quit. The main process serialises writes and blocks a normal window close while
any are queued; after a later clean app exit, the downloaded update may install.

For every release after 0.1.0, keep the previous installed version and exercise
this end-to-end check before calling the updater proven for that pair:

1. Install version `N` and add a harmless test library root.
2. Publish stable version `N+1` with `latest.yml`, installer and blockmap.
3. Launch `N`, wait for the update-ready notification, then close it normally.
4. Relaunch and verify the executable reports `N+1` and retained the library
   data.
5. Record the tested pair in the release notes.

Pre-releases are not the default update channel. Do not use one as proof of the
stable updater path without explicitly configuring and documenting a separate
channel.

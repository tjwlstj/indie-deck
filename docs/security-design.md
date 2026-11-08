# Launcher security and scanner integration

Research checked: **2026-11-04**. Source scope: **current development implementation** in
the C-drive checkout. The initial audit baseline was v0.1.9 at
`80241fa778652cb8615e4e068e7a7b2c8bdbf650`. Source implementation, local native
evidence, offline flows, packaging and public release are separate checkpoints.

This document records current controls, the supported external-engine choice,
and remaining verification work. An engine being installed, a scan request being
accepted, and a completed scan with no detection are distinct states. None of
them establishes that a game is harmless under every future execution.

## Status and scope

| Area | Current checkpoint | Evidence or behavior |
| --- | --- | --- |
| Isolated Electron renderer and local UI CSP | CURRENT in v0.1.9 | Context isolation, Chromium sandbox, no renderer Node integration, self-only scripts/styles, blocked page navigation. |
| Known-game IPC authority | CURRENT in v0.1.9 | Main resolves opaque game IDs; renderer does not choose scan/install/executable paths. |
| Bounded game ZIP import | CURRENT in v0.1.9 | Static inspection, ordinary-path checks, entry/size limits, CRC and source hashes, staging and atomic publication. |
| Asset network policy | CURRENT source | Approved HTTPS sources/redirects, scoped authorization, bounded transfers and ordinary cache files. |
| Microsoft Defender adapter and security UI | CURRENT source / bounded native probe observed | Separate verified local provider, engine/intelligence status, explicit update, manual folder scan, cancellation and reload recovery. Full UI/package results remain separate. |
| Desktop scan gates | CURRENT source | Translator/font archives before use, ZIP source plus unpublished stage, managed-version activation, and MTool/selected-game handoff require checks. Game executable checks default on and can be disabled globally. A checksum alone does not satisfy a required gate. |
| Browser and IPC boundaries | CURRENT source | Exact main-window frame/document sender validation, denied browser permissions/renderer remote requests and declared canonical external URLs. |
| Child-process environment | CURRENT source | Named credentials and Node/Electron injection controls are omitted before game/tool launch. |
| Selected-entry external decoder protection | CURRENT source / targeted checks observed | Protected arguments and selected-entry validation; the related network/extractor/font suite passed separately from the scanner and packaging. |
| Malware Zero | CURRENT official-homepage handoff / RESEARCH constraints | No database extraction, embedded package, rewritten updater or automatic system-cleaning invocation. |
| ClamAV adapter | RESEARCH / future option | Separate engine/updater integration is feasible; it is not bundled or implemented by this research document. |

The work concerns launcher-controlled asset downloads, imports and execution
handoffs, plus explicit folder scans. Mandatory antivirus gates are in desktop
actions; core/CLI callbacks are opt-in. The first provider requires the supported
Windows layout and a usable current Defender state. Unsupported layouts,
unavailable/inactive providers, stale intelligence, permission errors and
incomplete scans block required actions without silent fallback or elevation.

OS-wide firewall management, network interception, runtime execution sandboxing,
whole-system cleanup and a new antivirus engine remain separate projects. The
existing launcher updater keeps its fixed GitHub/SHA-512 path and has no new
antivirus gate. The machine's Defender cloud and real-time policies still apply;
native provider activity can use the network under those settings.

## Malware Zero: supported use and update boundary

Malware Zero describes itself as a Windows, script-based auxiliary removal tool
for computers that are already affected. Its features can change DNS, browser
settings, system configuration and cached files. The official introduction
prohibits direct file redistribution, code modification and commercial use.
Those published conditions do not establish permission to ship its files or
reuse its database inside IndieDeck. The integration decision is to provide an
explicit link to the official website for the user's independent use.
[Official introduction](https://malzero.xyz/about)

The FAQ says automatic updates are not supported and directs users to download
the current complete tool when needed. It reports a database-age warning after
seven days and refusal after ten days. The public introduction, FAQ and download
pages reviewed do not document an external database-update API, SDK or a
third-party automation contract. This is a finding about the reviewed public
documentation; it does not claim that no private partnership could exist.
[Official FAQ](https://malzero.xyz/support/faq)

The official download page begins a file download after a short delay. A launcher
button should therefore clearly open the official site, and leave the download
and any elevated cleanup run to the user. Free use in many environments is not
the same permission as redistribution or modification.
[Official download page](https://malzero.xyz/download)

## Microsoft Defender: first separate scanner provider

Microsoft lists `MpCmdRun.exe` in Windows Defender and versioned Platform
locations. It supports scoped scans and intelligence updates; its instructions
require an elevated command prompt. Permissions or inactive protection must be
reported without silent elevation.
[Microsoft command reference](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus)

The source invokes the verified executable with separate arguments:
`-Scan -ScanType 3 -File <main-owned target> -DisableRemediation`. Microsoft
documents archive scanning, ignored exclusions and no requested remediation in
this mode. It does not disable separate real-time protection. Return `2` includes
both detection/action-needed and errors; general return `0` also permits
successful remediation. Interpretation therefore depends on the actual mode and
engine state, rather than the number alone.
[Microsoft scan options and return codes](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus)

`-SignatureUpdate` uses the provider's intelligence updater. It is a separate,
explicit action. This integration excludes protection-disable, definition-removal,
quarantine-restore, exclusion changes and arbitrary UNC update commands.
[Microsoft update command](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus)

Implemented provider boundaries:

- Binary discovery uses the supported fixed C-drive Windows/Program Files/
  ProgramData locations and verifies Microsoft's Authenticode identity. Other
  layouts are unavailable rather than guessed from the game directory or PATH.
- The engine runs in a separate process with `shell: false`, bounded output and
  an engine-process timeout. The defaults are 20,000 files, 20 GiB and 15 minutes.
  Exceeding a limit leaves the check incomplete. ZIP structural limits remain
  separate; a structurally accepted ZIP can still exceed the scan scope.
- The default maximum intelligence age is seven days. This is IndieDeck's
  freshness policy, not a Microsoft definition-expiry assertion.
- The UI receives a bounded status/result DTO, not native output or arbitrary
  paths. It displays no-detection, ambiguous attention and not-checked states.
- Manual folder scans and intelligence updates require explicit actions. Desktop
  installation/launch actions also run the required scoped checks automatically.
  Cancellation and renderer-reload recovery use the main-owned task state.
- Target fingerprints and engine/intelligence state are checked before and after
  scanning. A no-detection result belongs to those inspected bytes/state; changed
  content requires another check.
- Scan results are session-local. The provider is a separate executable, not a
  game runtime sandbox. The launcher does not request cleanup or weaken Defender;
  independently configured real-time/cloud protection can still act normally.

## Future independent engine: ClamAV

ClamAV documents both a one-shot `clamscan` engine and the `clamd` daemon. The
daemon's TCP socket is not authenticated by the engine, making a public listener
unsuitable here. Some scanner size limits skip content, so a future adapter must
distinguish incomplete coverage from a completed no-detection scan.
[Official scanning guide](https://docs.clamav.net/manual/Usage/Scanning.html)

The official updater is FreshClam. Its FAQ identifies FreshClam and `cvdupdate`
as supported download routes and rejects scripted generic download clients.
IndieDeck should delegate updates to the supported updater rather than reproduce
the database-download protocol.
[Signature management](https://docs.clamav.net/manual/Usage/SignatureManagement.html),
[FreshClam FAQ](https://docs.clamav.net/faq/faq-freshclam.html)

The official repository identifies GPLv2 licensing and additional third-party
components. A distribution plan must review the exact engine package, required
notices and source obligations before bundling. A process boundary is useful
for engine isolation; it does not itself settle redistribution requirements.
[Official repository licensing section](https://github.com/Cisco-Talos/clamav#licensing)

## Implemented source boundaries

`main.ts` retains the isolated renderer and blocked navigation, adds explicit
permission check/request denial and blocks renderer remote network requests.
External links are matched against declared canonical public HTTPS URLs,
including their paths, queries and fragments. Windows Security is a separate
fixed help action. The browser helper validates names and declarations; it does
not pin the external browser's DNS or intercept its traffic. Electron's official
guide explains why an explicit permission policy is needed.
[Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security#5-handle-session-permission-requests-from-remote-content)

The common IPC wrapper now requires the exact main-window WebContents/frame and
fixed local renderer document. Main still resolves known opaque game IDs and
installation targets itself. A matching URL in another WebContents/subframe is
insufficient to use the privileged bridge.
[Electron IPC sender guidance](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)

For the same fixed pathname, file-URL matching normalizes only `%7E`/`%7e` to
the literal unreserved tilde. This accommodates Node/Chromium serialization of
Windows short names. It does not resolve filesystem aliases, follow links,
decode separators/dots, accept another frame, or remove query/fragment checks.

Desktop imports check the selected ZIP source and the unpublished extracted
stage. `game-archives.ts` still performs static game detection, path/size/CRC
checks and source revalidation. The scan callback is before publication, so an
unavailable or incomplete check cannot publish the new game. Existing journal
and recovery ownership checks continue to apply; the scan does not make a
published old installation permanently trusted. Activating an existing managed
version checks that version's directory before changing the active pointer.

Translator/font installation and reinstall scan the downloaded archive before
use or existing-payload cleanup. By default each normal game launch checks its selected
executable, while MTool handoffs check the tool and selected game executable.
The manual folder action supplies a broader scoped check. When launch scanning
is enabled, its result does not replace the next executable check. The explicit
global preference can disable only that game-launch check; installation, MTool
and manual checks retain their own policies. Main validates the preference and
coordinates actions with cancellation, file mutations and update restart; no
arbitrary native command or path is exposed to the renderer.

ZIP preflight also rejects unsafe Win32 path aliases before extraction. The
selected-entry external-decoder path protects its arguments and entry names.
Receipt-backed copied mod/font inputs use the expected inspected hash and copied
bytes, preventing a different source from being substituted between inspection
and the transaction's copy. These controls strengthen file handling; they do not
isolate a game's later filesystem access.

The registered asset-download path enforces approved HTTPS hosts/redirects,
GitHub-API-only authorization, finite transfer/time limits and ordinary cache
files. This policy covers that downloader; it is not a system firewall or a
claim that every main-process network integration shares the same code path.

Games and external tools receive a copied environment with recognizable
credential-name families and Node/Electron injection controls removed. Normal
OS/game variables are kept. This reduces unnecessary credential inheritance;
arbitrarily named secrets, the user's files and the game's future network or
filesystem access remain outside this environment helper's authority.

The existing updater uses a fixed release channel, explicit download/install,
disabled automatic installation on quit and a mutation/restart reservation.
These lifecycle controls are different from malware detection or an authentic
publisher signature. Release verification must continue to report unsigned
Windows artifacts accurately.

## Verification checkpoints

**Native observation — CURRENT, narrow fixture only.** A real Defender probe on
2026-11-04 checked one 77-byte synthetic C-drive text file. The engine reported
ready with engine `1.1.26100.4`, intelligence `1.463.115.0`, age zero days and
real-time protection enabled. The scoped result was `clean`, and the fixture's
bytes were unchanged. The local evidence is `out/native-security-result.json`.
These versions describe that observation, not a promise about future state.
The local validation also confirmed ordinary-user execution without a UAC
request. Permissions remain machine/target-dependent; failures are reported as
not-checked instead of triggering silent elevation.

No real intelligence update was requested. No real game, D-drive content,
Malware Zero database, browser profile or malware sample was scanned. The native
probe establishes that the supported local adapter could run on that fixture;
it does not establish live malware-detection efficacy or game execution safety.

**Final post-fix source UI verification — CURRENT, offline fixtures.** Full
Korean and English v0.1.11 desktop flows passed on Electron 43.8.7, including the
strengthened renderer-error check. Logs are `out/security-complete-ko.log` and
`out/security-complete-en.log`. Engine/process actions are mocked; these checks
do not establish native malware-detection efficacy or real-game execution safety.

**Portable short-path regression — failure reproduced, fix scoped.** A real
portable launch with short-name TEMP/TMP reproduced a loading failure. The CDP
record showed a literal `~` in the renderer file URL and an existing preload
bridge; even `app.info()` was rejected by the trusted-window check. Node's fixed
expected file URL used `%7E` for that same character. Local evidence is
`out/portable-short-repro-58667f1343174babba90b82d9f35a81b/debug-evidence.json`.
The failed v0.1.10 validation tag was not published as a release.

The fix preserves exact WebContents/main-frame identity and the entire fixed
document URL, with only pathname-tilde spelling normalized. Its nine targeted
browser-boundary tests passed, including both tilde directions, foreign frames,
other documents/hosts, encoded separators/dots, double encoding and empty
query/fragment rejection. These tests are separate from the actual portable
post-fix launch check.

**Final post-fix aggregate verification — CURRENT.** `npm run verify` passed
with 532 tests: 530 passed, none failed and two skipped, plus TypeScript build
and registry self-check. The local log is `out/security-final-verify.log`. The
two skips are file-symlink cases unavailable under this host's permissions.
Components cover network/cache failures, scanner limits, ordering/cancellation,
sender/link authority, copied bytes and child environments.

**Runtime version — CURRENT source/package.** Electron is 43.8.7. The official
2026-11-03 note reports a crash fix for a hidden parent window on Wayland. This
runtime refresh is not evidence of a CVE fix or scanner-detection improvement.
[Electron 43.8.7 release](https://releases.electronjs.org/release/v43.8.7)

**Decoder hardening — CURRENT source / targeted evidence.** The combined related
network/extractor/font suite passed 51 targeted cases. A harmless Windows bsdtar
archive probe also covered leading `./` entry names and verified that an on-disk
marker is not adopted as authority. These are separate checks from the native
antivirus fixture, final aggregate suite, packaged decoder and public release.

**Final post-fix local packaged verification — CURRENT.** The Electron 43.8.7
v0.1.11 package checker
verified 64 required entries and 73 SHA-256-critical runtime files. Focused
security checks passed against the actual packaged ASAR, covering mocked
attention/incomplete launch gates, renderer reload, cancellation, foreign IPC
rejection and a mocked intelligence update. Packaged history restart/deletion
regressions passed. Logs are `out/security-packaged-final.log` and
`out/security-history-packaged.log`; the security screenshot was inspected for
legibility. These results remain separate from the real native text-file probe.

**Final portable startup verification — CURRENT, actual artifact.** The real
v0.1.11 self-extracting portable passed both normal and native 8.3 short-name
TEMP/TMP launches. Both runs exited zero and produced PNG screenshots; the
short-path case was executed, not skipped. Evidence is
`out/security-portable-final.log` and
`out/portable-startup-0.1.11-bf84b1f5-636e-405e-a557-0c5c2cc5ce02/summary.json`,
with `normal.png` and `short-path.png` in that directory. This directly checks
the previously reproduced portable startup boundary. The hosted workflow now
uses `node scripts/check-portable-startup.mjs` for the same native short-path case;
the v0.1.11 hosted release also passed that check.

**Hosted verification.** The v0.1.11 release and its separate CI checks passed.
The current development revision needs its own hosted checks; past results do
not establish the outcome for later commits.

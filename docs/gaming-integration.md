# Xbox mode, Steam Big Picture and launcher resources

Research checked against official sources on 2026-11-10. Source implementation,
packaged Windows verification and registration in a user's Xbox/Steam profile
are separate evidence. This work does not inspect or modify personal gaming
profiles, Xbox/Steam private databases, Windows feature flags or registry gates.

## Fullscreen and registration

Windows **Xbox mode** is the current name for the earlier **full screen
experience**. It requires Windows 11 24H2 or later and supported markets/rollout.
Microsoft's support page describes different handheld and other-PC setup paths.
The mode shows one window at a time, so IndieDeck keeps settings and confirmation
in the existing window. See [Microsoft's Xbox mode guide](https://support.microsoft.com/en-us/servicing/os/windows/docs/2025/10/windows-gaming-full-screen-experience)
and the [Windows PC rollout announcement](https://news.xbox.com/en-us/2026/04/30/xbox-mode-pc-windows-11/).

The [April 2026 Xbox update](https://news.xbox.com/en-us/2026/04/30/april-xbox-update-2026/)
documents manual addition of installed games and apps, with editable names,
icons and launch options. Its description explicitly mentions handhelds; verify
that the option exists in the installed Xbox app before assuming availability on
every desktop/app version. When available, add `IndieDeck.exe` and the launch
options shown by IndieDeck's registration panel.

For Steam, use **Games → Add a Non-Steam Game** and select the IndieDeck
executable. The official [Valve support page](https://help.steampowered.com/en/faqs/view/4B8B-9697-2338-40EC)
describes this manual shortcut feature. [Big Picture](https://help.steampowered.com/en/faqs/view/3725-76D3-3F31-FB63)
is Steam's TV/controller interface. These are library shortcuts, not ownership,
store installation or achievement integrations.

IndieDeck accepts `--fullscreen` and `--launch-game <16-lowercase-hex-game-id>`.
Unknown or duplicate arguments cannot authorize game launch. Main resolves the
opaque id against the current library and retains the normal security scan,
busy-operation and executable checks. Game-specific shortcuts point through
IndieDeck; registering a game's raw executable separately bypasses IndieDeck's
launch behavior. Recreate the shortcut if the game path or launcher executable
location changes. Existing files are never overwritten by shortcut export.
The NSIS installer's single `--updated` flag is accepted as metadata only.
Second-instance requests normalize their unused executable argument (portable
extractions have different internal paths); that supplied path is never run.
All other flags still use the same strict parser and known-library-ID gate.

Creation of a `.lnk` file does not prove Xbox or Steam has accepted it. The
executable and launch-options fields are also shown separately so a user can
register them using the application's native UI. The current sources do not
establish a supported third-party API for registering IndieDeck as the Xbox
mode **home app**; it must not be described as an available verified feature.

## Windows settings and Game Bar

The launcher exposes only fixed settings actions from Microsoft's
[official Settings URI list](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings):

| Action | URI |
| --- | --- |
| Xbox mode | `ms-settings:gaming-fullscreen` |
| Game Mode | `ms-settings:gaming-gamemode` |
| Game Bar | `ms-settings:gaming-gamebar` |

Successful OS handoff does not confirm a setting is present, enabled or supported.
Game Bar is the `Win+G` overlay. A real Game Bar widget uses Microsoft's UWP-based
[Game Bar SDK](https://developer.microsoft.com/en-us/games/products/game-bar/);
the Electron application is not automatically a Game Bar widget.

## Resource settings and verification limits

The launcher can minimize after a launch and optionally restore after the
specific process it started exits. Automatic restore defaults off because a
launcher process can exit while its child game keeps running. It is not a
guarantee of the game's complete process-tree lifetime. Minimize defaults on and
is user-configurable. These preferences are launcher-owned and should persist
across restarts; they do not configure system power plans or other applications.

Reducing the launcher's own background work can reduce competition, but it does
not prove higher FPS or a CPU/GPU resource gain. Microsoft's Xbox mode startup
background-process optimization is documented for handheld startup behavior;
do not advertise it as an IndieDeck optimization or universal desktop behavior.
Real performance claims require a bounded, repeatable before/after measurement
on the target game and hardware. No such benchmark is implied by unit tests or
a clean source build.

The implemented quiet policy pauses new automatic thumbnail work while the
window is hidden, stops controller polling outside the visible focused gaming
view, and defers the one startup update check while an owned game is running
behind a hidden launcher. It resumes optional work on return. It does not cancel
an explicit scan, install or update operation. Game/process CPU priority,
affinity, power plans and unrelated background applications are unchanged.
Windows may inherit BELOW_NORMAL/IDLE from a parent process, so lowering the
launcher globally could accidentally lower a newly spawned game too. See
[Scheduling Priorities](https://learn.microsoft.com/en-us/windows/win32/procthread/scheduling-priorities),
[Quality of Service](https://learn.microsoft.com/en-us/windows/win32/procthread/quality-of-service)
and [Electron background visibility](https://www.electronjs.org/docs/latest/api/browser-window).

## Execution safety and autonomy

Direct-child sessions reserve a game ID before asynchronous inspection and
reject duplicate starts. An executable and its ancestor directories are
validated independently of the antivirus toggle, then their identity is checked
again after scanning and before spawn. Symlinks/junctions, escaping relative
paths, hardlinks, device names and alternate data streams are rejected. Node's
path-based spawn cannot close the last check-to-execute race against a local
writer; this is not a sandbox or a malware-free claim.

While a child is tracked, translator/font maintenance, mod changes and game
config writes for that game are rejected. Version activation is deferred while
any owned session is tracked. A root executable that hands off and exits ends
this ownership record; no foreign process enumeration is used to guess gameplay.
Automatic minimize acts only after a successful spawn. Automatic restore is an
explicit preference and never defaults to stealing focus from a game.

## Goal verification checklist

The user asked for ongoing functional, security, convenience and autonomy
improvements, Xbox/Big Picture registration feasibility and resource-efficiency
review. Completion requires all of these evidence categories:

| Requirement | Source evidence | Required runtime evidence |
| --- | --- | --- |
| Fullscreen, keyboard and controller navigation | gaming-mode.js; injected controller tests | Native fullscreen transition, single activation, modal boundary, Korean/English captures |
| Xbox/Steam registration path | Official sources above; strict gaming-entry parser | Native Windows shortcut roundtrip, existing-file preservation, installed/portable entry arguments |
| Shared guarded launch | launch-target-guard + owned-game-sessions | Normal and second-instance launch use one guard, duplicate/write rejection, failure cleanup |
| Resource efficiency and autonomy | Visibility queue tests, session policy, persistent preferences | Hidden work pauses/resumes; minimize after successful synthetic spawn; no automatic focus restore by default |
| Existing functions remain available | Existing full regression suite | Windows/Linux verification, desktop flows, package/runtime/hash/portable/installer checks |

Source tests and synthetic runtime results do not establish physical-controller
compatibility, an actual user's Xbox library registration, game FPS gains or
Xbox home-app support. Record those as separate unverified claims rather than
promoting a successful source test to product certification.

# Translator compatibility, by engine

What actually works where, and why. Everything here is encoded in
[`registry/`](../registry) so the resolver applies it automatically — this
document is the human-readable version, and the place to look when IndieDeck
tells you something is blocked.

Confidence markers used below match the registry: **[verified]** upstream states
it, **[inferred]** follows from something verified, **[community]** widely
reported without a primary source, **[unverified]** commonly repeated and *not*
confirmed.

---

## Unity

Two things decide everything: the **scripting backend** and the **engine
version**.

| how to tell | backend |
| --- | --- |
| `GameAssembly.dll` in the root, or `<Game>_Data/il2cpp_data/` | IL2CPP |
| `<Game>_Data/Managed/` with `Assembly-CSharp.dll`, `MonoBleedingEdge/` | Mono |

`indiedeck info <game>` prints both, plus the engine version read out of
`<Game>_Data/globalgamemanagers` (or `data.unity3d` on 2019+ single-bundle
builds).

### Which XUnity.AutoTranslator package

| backend | package | loader it needs |
| --- | --- | --- |
| Mono | `XUnity.AutoTranslator-BepInEx-{v}.zip` | BepInEx 5 (stable) |
| IL2CPP | `XUnity.AutoTranslator-BepInEx-IL2CPP-{v}.zip` | BepInEx 6 IL2CPP, **bleeding-edge build** |
| Mono, MelonLoader already installed | `XUnity.AutoTranslator-MelonMod-{v}.zip` | MelonLoader |
| IL2CPP, BepInEx 6 will not boot | `XUnity.AutoTranslator-MelonMod-IL2CPP-{v}.zip` | MelonLoader |
| Mono, want zero loader setup | `XUnity.AutoTranslator-ReiPatcher-{v}.zip` | none — bundled |

Putting a Mono package on an IL2CPP game (or the reverse) does not produce an
error message. It produces a game that launches and simply never translates,
which is why this is the single most common failure.

### Version gates that bite

- **BepInEx 5 cannot host IL2CPP at all.** The docs are explicit: *"Games built
  with IL2CPP are not supported at the moment."* [verified]
- **IL2CPP needs BepInEx 6 bleeding-edge**, not the `v6.0.0-pre.2` GitHub
  release — that prerelease is from August 2024 and predates the CI builds
  upstream points IL2CPP users at. IndieDeck picks the newest build for exactly
  this reason. [verified]
- **XUAT 5.4.0+ IL2CPP is built against bleeding-edge build 704.** Older BepInEx
  BE builds are documented as crashing. [verified]
- **XUAT 5.3.0 dropped pre-2017 Unity for IL2CPP packages.** A pre-2017 IL2CPP
  game has no in-process option left; use screen OCR. [verified]
- **Release v5.6 ships no ReiPatcher asset.** If you need that variant, take
  5.6.1 or 5.5.2. [verified]
- **DeepL below 5.5.2 fails.** 5.5.2 moved auth to the `Authorization` header;
  earlier builds send the legacy form the current API rejects. [verified]
- **New Input System games need 5.5.1+.** Before that, ALT+0 and ALT+T do
  nothing, which reads as "the plugin did not load" when it in fact did. [verified]
- **MelonLoader on IL2CPP needs the .NET 6.0 Desktop Runtime.** The Windows
  installer pulls it; a manual zip install may not. [verified]
- **MelonLoader's minimum Unity version is unclear.** 5.6.1 is the commonly cited
  floor but upstream docs do not state a range, so IndieDeck warns and never
  blocks on it. [unverified]
- **Architecture must match.** x86 game, x86 loader. IndieDeck reads the PE
  header of the launch executable rather than trusting folder names. [verified]

### Korean / Japanese / Chinese text renders as blank boxes

The plugin is working. The font is not: TextMeshPro atlases only contain the
glyphs they were built with, and an atlas is built by a specific Unity Editor
version, so a bundle that works in one game shows boxes in the next.

| Unity line | bundle | |
| --- | --- | --- |
| 5.5 – 2017.x | `arialuni_sdf-u55to2017` | [verified] |
| 2018.x | `arialuni_sdf_u2018` | [verified] |
| 2019.x – 2020.x | `arialuni_sdf_u2019` | [inferred] — no u2020 exists upstream; if boxes persist on 2020.x, try u2021 |
| 2021.x | `arialuni_sdf_u2021` | [verified] |
| 2022.x – 2023.x | `arialuni_sdf_u2022` | [inferred] |
| 6000.x (Unity 6) | `arialuni_sdf_u6000` | [verified] |

Copy the bundle into the game root and set `FallbackFontTextMeshPro` (not
`OverrideFontTextMeshPro`, which replaces every font in the game). IndieDeck does
both automatically, and `indiedeck check` flags folders where the bundles present
do not match the game's Unity line — a very common state, because people copy the
whole set in and assume one of them will take.

On TextMeshPro 3.2.0+ you can name an installed system font instead
(`Malgun Gothic`, `Meiryo`) and skip atlas version-matching entirely. [verified]

### Old Mono and TLS

Mono runtimes before roughly Unity 2018 have TLS 1.2 problems that make HTTPS
translation requests hang with no error. If translation stalls silently on an old
game, that is usually why — switch endpoint or try the ReiPatcher variant. [verified]

---

## Ren'Py

No runtime hook needed: Ren'Py has a native translation framework, so the right
approach is generating `tl/` files offline.

- **renpy-translator** (MIT) — extracts and machine-translates into `tl/`.
- **projz_renpy_translation** (GPL-3.0) — same, but keeps a translation index
  that survives game updates, which is what you want for a game still in
  development.

Both need decompiled `.rpy` sources. A build shipping only `.rpa` archives or
`.rpyc` bytecode has to be unpacked first (UnRen, rpatool). IndieDeck detects
this state and says so rather than letting the tool fail confusingly.

Mods are plain `.rpy` files in `game/`, loaded in filename order. IndieDeck
prefixes anything it manages with `zz_indiedeck_` so it loads last and is easy to
identify and remove.

---

## RPG Maker

| variant | how to tell | route |
| --- | --- | --- |
| MZ | `js/rmmz_core.js` | data-file translation, or OCR |
| MV | `js/rpg_core.js` | data-file translation, or OCR |
| XP / VX / VX Ace | `Data/*.rxdata` / `*.rvdata` / `*.rvdata2` | scripts live inside the archive — no clean automated route |

MV and MZ keep text in `data/*.json` (or `www/data/*.json` on older MV builds),
so translation means rewriting those files. IndieDeck snapshots the data folder
before any tool touches it.

The widely used tools here — **MTool** and **Translator++** — are closed source
and not distributed through a fetchable release channel, so IndieDeck detects
them (MTool leaves `MTool_Game.exe` and `TrsData.bin`) and links out instead of
pretending it can install them. **RPGMakerTranslator** (MIT) is the installable
open-source option.

Plugins are `js/plugins/*.js` plus an entry in `js/plugins.js`, a JS array
literal. IndieDeck parses and edits it with a regex rather than evaluating it —
it is a file that came from an untrusted game folder — and always writes a
`.indiedeck.bak` first.

---

## Wolf RPG

`Data/BasicData/Game.dat`, or a `.wolf` archive in the root.

**Wolf Trans** (MPL-2.0) is the open-source option, but it has been unmaintained
since 2019 and newer Wolf 3.x data formats may not parse. In practice, screen OCR
or a text hooker is the reliable route for a modern Wolf game.

---

## Visual novel engines (KiriKiri, NScripter, TyranoScript)

Text hooking beats OCR here. **LunaTranslator** (GPL-3.0, actively maintained) is
the current recommendation; **Textractor** (GPL-3.0) is the classic but has had no
upstream activity since March 2024.

---

## Godot, GameMaker, Unreal, LÖVE, Flash, Java

No maintained in-process text translator exists for these. Screen OCR (**MORT**,
Korean-first, MIT) or a hook/OCR hybrid (**LunaTranslator**) is the practical
route, and IndieDeck says so rather than offering a plan that cannot work.

Modding is a different story and is supported: **GDWeave** for Godot,
**UE4SS** for Unreal, **UndertaleModTool** for GameMaker — the last of which
rewrites `data.win`, so IndieDeck backs that file up before handing it over.

---

## When IndieDeck is wrong

`indiedeck detect "<path>" --json` prints the matched signature rules, the scores
and the runner-up engines. That output plus what actually worked is everything
needed to fix a rule — see [CONTRIBUTING.md](../CONTRIBUTING.md).

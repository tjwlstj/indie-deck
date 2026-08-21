# Roadmap

IndieDeck is not trying to be Playnite, Heroic or Vortex. Those manage *where a
game is*. IndieDeck manages *what a game is made of* — engine, runtime, loader,
translator, config — and whether that combination actually works.

```
Game → Engine → Runtime → Compatibility → Translation → Mods → Config → Health → Launch
```

Everything below is ordered so that each layer can be built on a foundation that
is already safe.

---

## P0 — Safety  ✅ done

The foundation: nothing else matters if installing can lose data.

- [x] **Transactional writes.** Every write is a `create` or a `modify`; the
      latter backs up the displaced original first. `rollback()` undoes a failed
      install completely.
- [x] **`plugins.js` is patched, never owned.** Removing an RPG Maker plugin
      restores the game's own registry file byte for byte. *(This was a real
      data-loss bug in 0.1.0.)*
- [x] **Mod overwrite is reversible.** A mod landing on an existing file backs it
      up; uninstall restores it instead of deleting it.
- [x] **Hand edits are respected.** Uninstall leaves a file alone when its hash
      no longer matches what IndieDeck wrote.
- [x] **Receipt schema v2** with typed entries, and v1 receipts still migrate.
- [x] **Download integrity.** Streamed to disk, hashed while streaming, pinned
      checksums compared, truncated or mismatched transfers discarded.
- [x] **IPC trust boundary.** The renderer addresses games and plans by opaque
      id; the main process resolves them against its own tables.

## P0.5 — Distribution

Right now a user needs git and Node. That is the biggest adoption barrier.

- [ ] Windows portable ZIP and installer via `electron-builder`
- [ ] Release CI: tag → build → test → package → checksum → GitHub Release
- [ ] In-app registry update check (the data ages faster than the code)

## P1 — Config Manager  ✅ done

The feature that removes the last hand-editing step. How it works:
[config-manager.md](config-manager.md).

- [x] Round-trip INI editing that preserves comments, key order, line endings
- [x] **Versioned config schema** — semantic ids (`xunity.targetLanguage`) mapped
      to `(section, key)` per translator version range, so the form is not
      pinned to one version's INI layout
- [x] Translator version detection: receipt → assembly → Migrations tag →
      unknown, each carrying its own confidence
- [x] Compatibility mode when the version is unknown: newest layout, clearly
      flagged as assumed
- [x] Basic GUI: engine, source/target language, fallback, credentials
- [x] Provider manifests with auth fields and, where genuinely known, language
      capability — so ezTrans with an English source warns instead of silently
      translating nothing
- [x] Advanced categories, expert view listing every undescribed key
- [x] Unknown keys preserved verbatim; plan + diff before save; automatic backup
- [x] Credentials redacted on read, in diffs and in logs
- [ ] Credentials in OS secure storage (blocked on the translation broker: the
      plugin itself reads the key from the game's config file)
- [ ] Schemas for BepInEx, MelonLoader and UE4SS configs (the engine is already
      translator-agnostic - these are data files, not code)

## P1 — Localisation  ✅ done

- [x] Message catalogue in `locales/`, English as the fallback rather than a
      requirement
- [x] Korean for the launcher chrome, core findings, audit messages, install
      steps, config labels and the CLI
- [x] Messages carry key + params, so a language switch re-renders without
      re-resolving
- [x] Registry text overridden per locale instead of duplicated
- [x] Language picker in the launcher, `--locale` in the CLI, system detection
- [x] `auditCatalogs()` and a test that Korean has no gaps
- [ ] Japanese and Chinese catalogues (the mechanism is done; these are data)

## P1.5 — Structure  ✅ done

Cleanups that make the layers above cheaper to add to.

- [x] Renderer split into modules; a launcher panel is one `SECTIONS` entry
- [x] CLI command table: help and dispatch render from one array
- [x] `registry check` rejects misspelled rule predicates, unknown probe ids,
      engine↔translator disagreements and unusable mod layouts
- [x] `modLayout` typed on `LoaderDef`; `Registry.configSchemas` typed honestly
- [x] Mod registry-file *format* separated from the disable *strategy*, which
      fixes the UE4SS host
- [x] `isNativeLoader()` replaces four duplicated hardcoded lists
- [x] Dead exports removed
- [ ] Split `packages/cli/src/commands.ts` by group
- [ ] Shared test fixtures module

## P1 — GameSession

- [ ] `beforeLaunch` → compatibility check → launch → `afterLaunch`
- [ ] Playtime, last played, running state
- [ ] Save backup around a session
- [ ] Post-exit health audit

## P2 — Mods

- [ ] Mod manifest (id, version, loader, source, hash, dependencies, conflicts)
- [ ] Dependency and conflict resolution
- [ ] Mod update checks
- [ ] **Profiles** — one game, several named setups (Vanilla / Korean / Modded),
      each bundling translator + config + loader + mod set

## P2 — Library

- [ ] Cover art and metadata
- [ ] Favourites, tags, sorting, recently played

## P2 — Translation Broker

A local endpoint that XUnity's `CustomTranslate` points at, so IndieDeck owns the
provider instead of the game's config file.

- [ ] localhost broker speaking the `CustomTranslate` protocol
- [ ] Provider abstraction (Google, DeepL, Azure, OpenAI, Ollama, local models)
- [ ] Credentials never leave IndieDeck — the game config holds a localhost URL
- [ ] Shared translation cache keyed by text + languages + provider + glossary
- [ ] Per-game glossary

## P3

- [ ] Local LLM translation with dialogue context
- [ ] Fullscreen / gamepad UI
- [ ] Themes

---

## Deliberately out of scope

Store integration, being a game store, replacing Playnite or Heroic, emulator
frontends, hosting mods. Each would double the surface area and none of them is
the problem IndieDeck exists to solve.

## Principles these follow

1. Protect the game's original files.
2. Every change is reversible.
3. Do not trust the renderer.
4. Verify what you download.
5. Never guess a version and then act on the guess.
6. Preserve config values you do not understand.
7. Remove the need to hand-edit INI files.
8. Simple by default, complete when asked.
9. Show the evidence and the confidence behind every compatibility claim.

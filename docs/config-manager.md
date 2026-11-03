# The config manager

Installing a translator is half the job. The other half is a 112-key INI file
where the section a setting lives in depends on which build of the translator
you happen to have, half the keys are credentials, and a single careless rewrite
wipes the comments upstream generates and any setting IndieDeck has never heard
of.

This is how IndieDeck edits that file without owning it.

## Semantic ids, not INI keys

The UI never says "write `Language` into `[General]`". It says
`xunity.targetLanguage`, and the schema answers where that lives *for the version
actually installed*:

```jsonc
{
  "id": "xunity.targetLanguage",
  "ui": { "category": "basic", "label": "Translate into", "type": "language" },
  "versions": [
    { "min": "5.0.0", "section": "General",        "key": "Language" },
    { "max": "4.999", "section": "AutoTranslator", "key": "Language",
      "confidence": "inferred" }
  ],
  "default": "en"
}
```

A form built against one version's layout would need rewriting every time
upstream moves a key. This one does not — and the same machinery will describe
BepInEx, MelonLoader or UE4SS configs when those are added, because nothing in
the engine is XUnity-specific.

Settings that simply do not exist in a version declare `availability`, and are
hidden rather than written into a file that will ignore them:

```jsonc
{ "id": "xunity.enableUIElements", "availability": { "min": "5.6.0" } }
```

## Working out which version is installed

In this order, each step recording where the answer came from:

| order | source | confidence | why |
| --- | --- | --- | --- |
| 1 | IndieDeck's own install receipt | verified | we installed it and wrote it down |
| 2 | the plugin assembly's file version | verified | the DLL on disk is what is actually running |
| 3 | `[Migrations] Tag` in the config | community | records the last migration that ran, which *usually* equals the installed version |

The Migrations tag is deliberately last. It looks like a version field and often
is one, but it is a migration marker — treating it as authoritative would be
guessing with extra steps.

When nothing answers, the newest known layout is used and every consumer is told
so: `detected.source === 'unknown'`, a warning on the panel, and the affected
rows carry the mapping's `assumed` flag. Compatibility mode, not confident mode.

## Providers are data too

Each translation engine declares its own credential fields, tier and — where it
is actually known — its language coverage:

```jsonc
{
  "id": "ezTransXP",
  "label": "ezTrans XP (local)",
  "tier": ["local"],
  "section": "ezTrans",
  "fields": [{ "key": "InstallationPath", "type": "directory",
               "label": "ezTrans XP install folder", "required": true }],
  "languages": { "source": ["ja"], "target": ["ko"], "confidence": "community" }
}
```

That last block is why picking ezTrans with an English source produces a warning
instead of a game that quietly translates nothing. Providers whose coverage is
not reliably known simply omit it, and no language check runs — an absent list
means "unknown", never "unsupported".

Selecting an engine reveals exactly its fields, and a required field left empty
is a warning, not a block: people set the endpoint first and paste the key after.

## Editing without damaging the file

Reading reports three things: the settings the schema describes, the credential
fields of the selected engine, and **every key it does not describe**, with a
coverage count (`describes 49 of 112 keys`). Nothing is hidden and nothing is
silently dropped.

Writing goes through `applyIni`, which rewrites individual lines. A round trip
over a real generated config preserves:

- the inline `;` documentation upstream writes next to every key
- standalone comments, including notes a user left
- key and section order
- CRLF line endings
- unknown keys, unknown sections, and the `[Migrations]` tag

and the write itself runs in a file transaction, so the previous config is
backed up and a failure restores it.

Every change is planned before it is applied. The plan carries a diff and the
issues found:

```
[Service] Endpoint: PapagoTranslate -> DeepLTranslateLegitimate
! 5.5.2 moved auth to the Authorization header; earlier builds are rejected
  by the current API.
! DeepL API needs API key, which is not set. Translation will fail until it is.
```

An invalid plan is refused outright rather than written half-way.

## Credentials

Secrets are redacted on read (`••••••••1234`), redacted again in the diff, and
only returned in the clear when a caller explicitly asks — the CLI needs
`--reveal`. They are never written to a log.

What IndieDeck cannot fix: XUnity reads its API key out of the game's config
file, so the key does end up on disk in plain text. The UI says so next to the
field rather than implying a safety it cannot provide. The eventual answer is
the translation broker on the roadmap, where the game holds a localhost URL and
IndieDeck holds the credential.

## Using it

```bash
indiedeck config "MyGame"                       # what is set, and what is not described
indiedeck config "MyGame" --providers           # engines, their tier and what they require
indiedeck config "MyGame" --expert              # list the keys IndieDeck leaves alone
indiedeck config "MyGame" --reveal              # show credentials in the clear

indiedeck config "MyGame" \
  --set xunity.targetLanguage=ko \
  --set xunity.endpoint=PapagoTranslate \
  --dry-run                                     # plan and diff, write nothing
```

In the launcher the same thing is a form under **Translation settings**, with
Preview and Save, and the panel header always shows which version the layout was
resolved against and how confident that is.

## Comparing options before a reinstall (v0.1.8 source)

The Unity maintenance card and its **Clean up and reinstall** confirmation show
the current options beside the **registered schema default (reference)** for the
compatible replacement build. The replacement is the version selected by the
registry and resolver, not a live claim about the newest release on the Internet.
Translation settings now appear earlier in the game detail view, while file
locations and mapping details are collapsed technical information.

The two columns answer different questions:

| Information | Meaning |
| --- | --- |
| Current value | The setting read using the installed version's mapping, or an explicitly labelled schema reference when the key is missing. |
| Registered schema default | The single default stored for that semantic setting in IndieDeck's partial schema. Defaults are not currently versioned upstream release data. |
| Mapping review | Which registered mappings stay in place, differ, become unavailable or cannot be confirmed. This is a review report, not a generated migration patch. |

For example, a current target language of `ko` and a schema reference of `en`
mean that the game has a different value from our reference. Payload-only
reinstall **keeps `ko`**. It does not reset the file to `en`, apply launcher
installation defaults, move keys or copy the settings into a different variant's
configuration path. A settings-path difference is shown for manual review.

The report distinguishes these cases:

- A key missing from the current file is different from an option explicitly
  introduced by the schema's `availability` range. The latter is labelled as a
  version-specific addition only with confirmed current-version evidence.
- A DLL or receipt version with verified evidence can support a comparison. A
  `Migrations.Tag`, an unknown version, multiple observed translator versions or
  a disagreement between a receipt and DLL version stays visibly unconfirmed.
  Assumed mapping confidence is retained even when a schema declares a version
  range.
- A target setting excluded by registered availability is shown as unavailable
  in that schema; this is not a complete list of upstream removals or features.
- Unrecognized keys remain untouched. The report includes their names and an
  accurate count, with at most 200 names displayed; it never includes their
  values.

Primary and fallback providers are both represented. Declared provider version
requirements, such as DeepL's registered minimum version, are checked against
confirmed current and registered target versions. A requirement check is not an
API authentication or translation test. Credential, URL, identifier and directory
fields expose configured/present status only in this report. Strict boolean and
bounded numeric options can show their current value. Secret values and example
secret defaults are omitted.

In v0.1.8, the completed reinstall and maintenance cards reopen the pre-reinstall
report through a main-process buffer. That version retains one redacted report
per game for at most 20 games during the current app session, including after
operation acknowledgement or a renderer reload. Another committed reinstall
replaces that game's report, older entries can be evicted, and removing a game
clears its session entry. Quitting v0.1.8 clears this buffer. The following
section describes the separate durable record added in v0.1.9 source.

## Saved comparison records (v0.1.9 source)

After a committed reinstall, a separate game-detail card can reopen that game's
last saved comparison after the launcher restarts. It remains independent of
the current translator-maintenance preview, so removing the translator payload
does not hide the saved review. The card shows when the report was recorded;
the values still describe the pre-reinstall snapshot, not a fresh detection.
This is a review record, not a settings backup, restore command or migration
simulation. The registered schema reference keeps the limits described above.

`translation-option-history.json` in the launcher data directory uses a versioned
envelope and retains the latest report for at most 20 opaque game IDs. Saving a
new report for a game replaces its previous record; adding another game at the
limit evicts the oldest retained record. No game name or absolute game path is
needed. Config-file paths are restricted to the registered schema's relative
locations. Arbitrary text and directory values, credentials, service URLs,
identifiers and unknown-key names are omitted from the durable projection.
Schema-allowed choices, languages, booleans and bounded numbers can remain
visible. An omitted value is labelled as hidden from the saved record rather
than being confused with a value that could not be read.

**Delete saved record** asks for confirmation and removes only that game's
launcher record. It does not edit the game's configuration, restore defaults,
remove its translator or delete other games' records. Temporarily unavailable
drives and incomplete library scans do not prune saved records automatically.

Reads and writes are bounded and reject linked or unsafe history paths. A
damaged, oversized or invalid envelope is preserved, displays an unavailable
state and blocks history writes and deletion. The launcher does not silently
replace it with an empty store. Cosmetic schema-label changes can be hydrated
from the current schema and locale; unsupported future IDs, types or mappings
instead preserve the stored file and block writes for review. A failed history
save is independent of the already committed reinstall. Its report remains
available for the current session with a warning, while game maintenance and option editing keep their
own normal authority checks.

The offline `scripts/check-comparison-history.mjs ko` and `en` checks use
disposable game/config files and separate Electron processes to exercise saved
review, explicit deletion, a later empty startup and damaged-file preservation.
The synthetic payload is removed before review to exercise the standalone
history card. These checks compare game-file hashes and produce local
`out/desktop-history-ko.png` and `out/desktop-history-en.png` captures. Their
results are reported separately from module tests, packaging and publication;
they do not establish real-game translation or API authentication.

The full source suite reported 435 tests: 433 passed, none failed and two were
skipped. This history change adds 11 store cases and two renderer-helper cases.
Both Korean and English history flows passed, using four fresh Electron
processes each (eight app processes in total). Their checks include persistence,
explicit deletion, damaged-data preservation, rejected clear IPC for unknown
games and unchanged fixture game/config bytes. These results do not imply that
packaging or public release has completed.

## Editing an installed game's options (v0.1.8 source)

The form shows saved non-secret provider values, including boolean controls,
rather than presenting those fields as empty replacements. Primary and fallback
provider settings have separate role labels, and the same provider is rendered
once when it serves both roles. A saved secret stays a redacted placeholder;
leaving its replacement input empty does not copy the placeholder into the file.

Preview remains read-only. Save keeps visible change and backup feedback through
the form's subsequent refresh, explains that the game needs restarting, and
refreshes the selected game's detail information such as its language-dependent
font recommendation. Game-specific saves do not silently change the launcher
defaults for new installations.

Validation uses synthetic game/config fixtures. Core checks cover presence
versus explicit empty/default values and secret preservation. Comparison checks
cover version evidence, missing and introduced options, partial mapping coverage,
provider requirements, safe display values, unchanged game bytes and linked-path
refusal. Renderer helpers and the Korean/English offline Electron flows exercise
the form and reinstall review. The latter produce local
`out/desktop-config-comparison-ko.png` and `out/desktop-config-comparison-en.png`
captures; these are not proof that a real game migrated its config or translated
successfully. Browser/API authentication, full upstream migration simulation,
durable comparison history and a general draft/focus redesign were outside the
v0.1.8 change; v0.1.9 history scope is documented separately above.

The full source test run reported 422 tests: 420 passed, none failed and two were
skipped. The option work adds 26 cases across core configuration (7), comparison
(13) and renderer helpers (6). These counts are separate from the offline desktop
flows and packaging/release checks.

## Adding a translator

Drop a `registry/configs/<translator>.json` next to the existing one. No code
changes: the loader picks up every file in that directory, and the CLI and the
launcher render whatever it declares.

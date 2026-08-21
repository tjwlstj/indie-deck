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

## Adding a translator

Drop a `registry/configs/<translator>.json` next to the existing one. No code
changes: the loader picks up every file in that directory, and the CLI and the
launcher render whatever it declares.

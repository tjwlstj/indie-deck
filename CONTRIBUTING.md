# Contributing

Most of what makes IndieDeck useful is data, not code. If you have fought a game
into speaking your language, the rule you learned is worth more than a feature.

## Adding a compatibility rule

Rules live in [`registry/compat.json`](registry/compat.json). A rule needs:

```json
{
  "id": "kebab-case-and-specific",
  "severity": "block | warn | info | prefer",
  "confidence": "verified | inferred | community | unverified",
  "sources": ["https://..."],
  "when": { "backend": "il2cpp", "variantIn": ["bepinex"] },
  "message": "What the user should understand, in one or two sentences."
}
```

The two fields that get reviewed hardest are `confidence` and `sources`:

| confidence | meaning |
| --- | --- |
| `verified` | an upstream doc, README, changelog or release note states it — link it |
| `inferred` | follows logically from something verified, but is not stated outright |
| `community` | widely reported by users, no primary source |
| `unverified` | commonly repeated and *not* confirmed — the resolver will never let this block a plan |

Do not label something `verified` because it is true in your experience. The
whole point of the field is that a user can tell "upstream says so" apart from
"someone on a forum said so", and the resolver treats them differently.

Supported `when` predicates are listed in `matchesWhen()` in
[`packages/core/src/resolve/index.ts`](packages/core/src/resolve/index.ts). An
unknown predicate makes the rule never fire, rather than fire wrongly.

## Adding an engine

Add an entry to [`registry/engines.json`](registry/engines.json) with scored
signature rules. Aim for one high-score rule that is unique to the engine plus a
few low-score corroborating ones, and set `minScore` so corroboration alone
cannot trigger a match.

Then add a test in `packages/core/test/detect.test.ts` that builds a synthetic
folder with those files. Detection tests never touch real games, which keeps them
runnable in CI.

Watch for false positives against other engines' layouts. `mods/`, `data/`,
`resources/` and `package.json` are shared by many engines; a rule scoring high
on any of those alone will misfire.

## Adding a translator or loader

Entries go in [`registry/translators.json`](registry/translators.json) or
[`registry/loaders.json`](registry/loaders.json). Requirements:

- `installedMarkers` must be specific enough that an unrelated folder cannot
  match. Prefer a full path to a named file over a directory name.
- Asset names must match the real release assets. `indiedeck registry check
  --online` compares them against GitHub.
- If a tool is closed source or not distributed through a fetchable release, mark
  it `detectOnly: true` and give it a `homepage`. IndieDeck detects it and links
  out; it does not scrape or bundle it.

## Code

```bash
npm install
npm run build
npm test
```

TypeScript with erasable-only syntax (no enums, no parameter properties) so the
sources run directly under `node --experimental-strip-types`. Core has no runtime
dependencies, and additions should keep it that way — the ZIP reader exists
precisely so that installing IndieDeck does not pull a dependency tree onto a
machine that is about to write files into game folders.

Anything that writes to a game folder goes through a receipt, and anything that
executes a third-party binary requires explicit opt-in.

## Reporting a detection bug

Run `indiedeck detect "<path>" --json` and include the output. It carries the
matched signature rules and the runner-up engines, which is usually enough to see
what went wrong without anyone needing the game.

# RAWG artwork adapter experiment

Status: **isolated prototype; not connected to the launcher UI, IPC, installed
application, automatic scans or releases.** This experiment has not been tested
with a real API key, a live RAWG account, or production RAWG responses. A RAWG
listing is user-contributed metadata and is not evidence that artwork is an
official storefront image.

`experiments/rawg/artwork.ts` accepts a key directly from its caller in memory.
The module does not save, log or return that key. RAWG's documented API requires
the key in the request query, so the transport, network intermediaries and RAWG
can observe it; callers must avoid logging request URLs or raw transport errors.
No key is bundled, read from a browser, or loaded automatically from environment
variables. There is **no persistent key storage in this prototype**. A future
product integration must refuse persistence when OS-backed Electron safeStorage
encryption is unavailable; it must not silently fall back to plaintext.

The adapter searches only when the caller requests it. It holds only a bounded
set of current results per instance; a newer search invalidates earlier results.
Only a currently returned ID can select an image. API calls use the fixed HTTPS
`api.rawg.io` host, and image URLs are restricted to a narrow `media.rawg.io`
game-image path. Redirects are rejected; response sizes and time are bounded;
image bytes use the launcher's existing signature/dimension check. This check
is not a full image decoder or a guarantee that arbitrary image content is safe.
The conservative media path allowlist may reject legitimate RAWG image variants;
actual response compatibility requires a separately authorized live test.

Each search result and selected image carries a RAWG attribution/link value.
This value is **not itself a visible attribution**. Before product integration,
the library list, game detail and every other display of RAWG data or images must
show a usable active RAWG hyperlink and attribution, including after app restart.
The integration must also keep key material out of IPC logs, analytics, crash
reports, stored thumbnail preferences and third-party image requests. The
renderer must not choose arbitrary URLs; main must retain per-game search-result
authority and invalidate it when the search or selected game changes.

RAWG's official [API page](https://rawg.io/apidocs) and
[API terms](https://rawg.io/tos_api) describe attribution, usage limits and
restrictions on redistribution. Their descriptions of free commercial use are
not identical, so confirm the applicable plan and terms before enabling or
distributing a product integration. RAWG also states that it does not claim
ownership of API images. Do not redistribute a key or bundle third-party data.

Run the isolated, offline, synthetic test from the repository root:

```
node --test --experimental-strip-types packages/core/test/rawg-artwork-experiment.test.ts
```

The test uses only injected responses and a synthetic key. It exercises bounded
requests, candidate authorization, stale search invalidation, source attribution,
image checks and generic error handling. It performs no actual network request.

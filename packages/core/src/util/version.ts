/**
 * Version comparison that copes with the three shapes IndieDeck deals with:
 *   - plain dotted numerics  5.4.23.5
 *   - semver-ish with tags   6.0.0-be.785 / 6.0.0-pre.2
 *   - Unity build strings    2021.3.16f1 / 6000.0.58f2 / 5.6.7p4
 *
 * Unity's stream suffix (a/b/f/p/x) is ordered a < b < f = p < x so a release
 * build never sorts below the alpha of the same number.
 */

const STREAM_ORDER: Record<string, number> = { a: 0, b: 1, f: 2, p: 2, c: 2, x: 3 };

export interface ParsedVersion {
  parts: number[];
  stream?: string;
  streamRank: number;
  build?: number;
  raw: string;
}

export function parseVersion(raw: string): ParsedVersion {
  const text = String(raw ?? '').trim();
  // `2021.3.23f1` and the Unity China form `2021.3.23f1c1`.
  const unity = /^(\d+)\.(\d+)\.(\d+)([abfpcx])(\d+)(?:c(\d+))?$/i.exec(text);
  if (unity) {
    return {
      parts: [Number(unity[1]), Number(unity[2]), Number(unity[3])],
      stream: unity[4]!.toLowerCase(),
      streamRank: STREAM_ORDER[unity[4]!.toLowerCase()] ?? 2,
      build: Number(unity[5]),
      raw: text,
    };
  }
  const tagged = /^([\d.]+)[-+](?:be|pre|rc|alpha|beta)\.?(\d+)?/i.exec(text);
  if (tagged) {
    return {
      parts: tagged[1]!.split('.').map((n) => Number(n) || 0),
      streamRank: 1,
      build: tagged[2] ? Number(tagged[2]) : undefined,
      raw: text,
    };
  }
  const numeric = text.match(/\d+/g);
  return {
    parts: numeric ? numeric.map(Number) : [0],
    streamRank: 2,
    raw: text,
  };
}

/** -1 | 0 | 1 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.streamRank !== pb.streamRank) return pa.streamRank < pb.streamRank ? -1 : 1;
  const ba = pa.build ?? 0;
  const bb = pb.build ?? 0;
  if (ba !== bb) return ba < bb ? -1 : 1;
  return 0;
}

export function gte(a: string, b: string): boolean {
  return compareVersions(a, b) >= 0;
}

export function lt(a: string, b: string): boolean {
  return compareVersions(a, b) < 0;
}

export function satisfiesRange(version: string | undefined, range: { min?: string; max?: string } | undefined): boolean {
  if (!range) return true;
  if (!version) return true; // unknown version never hard-fails a range
  if (range.min && lt(version, range.min)) return false;
  if (range.max && compareVersions(version, range.max) > 0) return false;
  return true;
}


/** Major line of a Unity version, e.g. "2021.3.16f1" -> 2021, "6000.0.58f2" -> 6000. */
export function unityMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const m = /^(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}

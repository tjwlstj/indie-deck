import type { Arch, Backend, UnityInfo } from '../types.ts';
import { FsProbe } from '../util/fsx.ts';
import { peArch, peVersionString } from '../util/pe.ts';

export interface ProbeContext {
  probe: FsProbe;
  captures: Record<string, string>;
  exeNames: string[];
  primaryExe?: string;
  /** Deep probes read large files (IL2CPP metadata); skipped during bulk scans. */
  deep?: boolean;
}

export interface ProbeResult {
  arch?: Arch;
  unity?: UnityInfo;
  engineVersion?: string;
  title?: string;
  notes?: string[];
  extra?: Record<string, unknown>;
}

// The trailing `c\d+` covers Unity China builds (e.g. 2021.3.23f1c1), which are
// common in Asian indie releases and otherwise read as "version unknown".
const UNITY_VERSION_RE = /\b(\d{1,4})\.(\d+)\.(\d+)([abfpcx]\d+(?:c\d+)?)\b/;

/* -------------------------------------------------------------------- unity */

export function unityDataDir(ctx: ProbeContext): string | undefined {
  const captured = ctx.captures['dataDir'];
  if (captured) return captured;
  return ctx.probe.namesIn('').find((n) => /_Data$/i.test(n) && ctx.probe.hasDir(n));
}

export function probeUnityBackend(ctx: ProbeContext): Backend {
  const { probe } = ctx;
  if (probe.hasFile('GameAssembly.dll')) return 'il2cpp';
  const data = unityDataDir(ctx);
  if (data) {
    if (probe.hasDir(`${data}/il2cpp_data`)) return 'il2cpp';
    if (probe.hasDir(`${data}/Managed`)) return 'mono';
  }
  if (probe.hasDir('MonoBleedingEdge')) return 'mono';
  return 'unknown';
}

export function probeUnityVersion(ctx: ProbeContext): { version?: string; source?: string } {
  const { probe } = ctx;
  const data = unityDataDir(ctx);

  if (data) {
    const ggm = probe.head(`${data}/globalgamemanagers`, 256).toString('latin1');
    const m1 = UNITY_VERSION_RE.exec(ggm);
    if (m1) return { version: m1[0], source: 'globalgamemanagers' };

    const bundle = probe.head(`${data}/data.unity3d`, 256).toString('latin1');
    const m2 = UNITY_VERSION_RE.exec(bundle);
    if (m2) return { version: m2[0], source: 'data.unity3d' };
  }

  // Last resort: the player's own resource version (numeric, no stream suffix).
  const dllVersion = peVersionString(probe, 'UnityPlayer.dll', 2 * 1024 * 1024);
  if (dllVersion) {
    const parts = dllVersion.split('.');
    if (parts.length >= 3) return { version: `${parts[0]}.${parts[1]}.${parts[2]}f1`, source: 'UnityPlayer.dll (approximate)' };
  }
  return {};
}

/** TextMeshPro presence decides whether a CJK fallback font is needed at all. */
export function probeTextMeshPro(ctx: ProbeContext, backend: Backend): boolean | undefined {
  const { probe } = ctx;
  const data = unityDataDir(ctx);
  if (!data) return undefined;

  if (backend === 'mono') {
    const managed = probe.namesIn(`${data}/Managed`);
    return managed.some((n) => /textmeshpro/i.test(n) || /^Unity\.TextMeshPro\.dll$/i.test(n));
  }
  if (backend === 'il2cpp') {
    if (!ctx.deep) return undefined;
    const meta = probe.head(`${data}/il2cpp_data/Metadata/global-metadata.dat`, 24 * 1024 * 1024);
    if (meta.length === 0) return undefined;
    return meta.includes(Buffer.from('TMPro'));
  }
  return undefined;
}

export function probeNewInputSystem(ctx: ProbeContext, backend: Backend): boolean | undefined {
  const { probe } = ctx;
  const data = unityDataDir(ctx);
  if (!data) return undefined;
  if (backend === 'mono') {
    return probe.namesIn(`${data}/Managed`).some((n) => /^Unity\.InputSystem/i.test(n));
  }
  if (backend === 'il2cpp' && ctx.deep) {
    const meta = probe.head(`${data}/il2cpp_data/Metadata/global-metadata.dat`, 24 * 1024 * 1024);
    if (meta.length === 0) return undefined;
    return meta.includes(Buffer.from('UnityEngine.InputSystem'));
  }
  return undefined;
}

export function probeUnity(ctx: ProbeContext): ProbeResult {
  const backend = probeUnityBackend(ctx);
  const { version, source } = probeUnityVersion(ctx);
  const unity: UnityInfo = {
    backend,
    dataDir: unityDataDir(ctx),
  };
  if (version) unity.version = version;
  if (source) unity.versionSource = source;
  const tmp = probeTextMeshPro(ctx, backend);
  if (tmp !== undefined) unity.usesTextMeshPro = tmp;
  const input = probeNewInputSystem(ctx, backend);
  if (input !== undefined) unity.usesNewInputSystem = input;

  const notes: string[] = [];
  if (backend === 'unknown') notes.push('Could not tell Mono from IL2CPP - neither GameAssembly.dll nor a Managed folder was found.');
  if (!version) notes.push('Unity version unknown; version-gated compatibility rules will be reported as advisory only.');

  return { unity, engineVersion: version, notes };
}

/* -------------------------------------------------------------------- renpy */

export function probeRenpy(ctx: ProbeContext): ProbeResult {
  const { probe } = ctx;
  const vc = probe.readText('renpy/vc_version.py', 4096);
  const m = /^version\s*=\s*['"]([^'"]+)['"]/m.exec(vc);
  const notes: string[] = [];

  const gameFiles = probe.namesIn('game');
  const hasSource = gameFiles.some((n) => n.toLowerCase().endsWith('.rpy'));
  const hasArchives = gameFiles.some((n) => n.toLowerCase().endsWith('.rpa'));
  const onlyCompiled = !hasSource && (hasArchives || gameFiles.some((n) => n.toLowerCase().endsWith('.rpyc')));
  if (onlyCompiled) notes.push('Only compiled/archived scripts present - offline translators need the sources unpacked first.');

  const result: ProbeResult = { notes, extra: { renpyOnlyCompiled: onlyCompiled, hasRpaArchives: hasArchives } };
  if (m) result.engineVersion = m[1];
  return result;
}

/* ---------------------------------------------------------------- rpg maker */

export function probeRpgMaker(ctx: ProbeContext): ProbeResult {
  const { probe } = ctx;
  const base = probe.hasDir('www') ? 'www' : '';
  const systemPath = base ? `${base}/data/System.json` : 'data/System.json';
  const raw = probe.readText(systemPath, 256 * 1024);
  const result: ProbeResult = { extra: { contentRoot: base || '.' } };
  if (raw) {
    try {
      const system = JSON.parse(raw) as { gameTitle?: string; locale?: string };
      if (system.gameTitle) result.title = system.gameTitle;
      if (system.locale) (result.extra ??= {})['locale'] = system.locale;
    } catch {
      /* malformed System.json is common in edited games - ignore */
    }
  }
  return result;
}

export function probeRgss(ctx: ProbeContext): ProbeResult {
  const { probe, captures } = ctx;
  const ini = probe.readText('Game.ini', 8192);
  const lib = /Library\s*=\s*(.+)/i.exec(ini)?.[1]?.trim();
  const title = /Title\s*=\s*(.+)/i.exec(ini)?.[1]?.trim();

  let variant = 'unknown';
  if (captures['rgssAce'] || /RGSS3/i.test(lib ?? '')) variant = 'VX Ace';
  else if (captures['rgssVx'] || /RGSS2/i.test(lib ?? '')) variant = 'VX';
  else if (captures['rgssXp'] || /RGSS1|RGSS10/i.test(lib ?? '')) variant = 'XP';

  const result: ProbeResult = { extra: { rgssVariant: variant, rgssLibrary: lib } };
  if (title) result.title = title;
  return result;
}

/* -------------------------------------------------------------------- godot */

export function probeGodot(ctx: ProbeContext): ProbeResult {
  const { probe } = ctx;
  const pck = probe.namesIn('').find((n) => n.toLowerCase().endsWith('.pck'));
  if (!pck) return { notes: ['Godot pack appears to be embedded in the executable; engine version not readable from a .pck header.'] };
  const head = probe.head(pck, 32);
  if (head.length < 20 || head.toString('latin1', 0, 4) !== 'GDPC') return {};
  const packFormat = head.readUInt32LE(4);
  const major = head.readUInt32LE(8);
  const minor = head.readUInt32LE(12);
  const patch = head.readUInt32LE(16);
  return { engineVersion: `${major}.${minor}.${patch}`, extra: { pckFormat: packFormat, pck } };
}

/* ------------------------------------------------------------------- unreal */

export function probeUnreal(ctx: ProbeContext): ProbeResult {
  const { probe } = ctx;
  const raw = probe.readText('Engine/Build/Build.version', 4096);
  const result: ProbeResult = {};
  if (raw) {
    try {
      const v = JSON.parse(raw) as { MajorVersion?: number; MinorVersion?: number; PatchVersion?: number };
      if (v.MajorVersion !== undefined) result.engineVersion = `${v.MajorVersion}.${v.MinorVersion ?? 0}.${v.PatchVersion ?? 0}`;
    } catch {
      /* ignore */
    }
  }
  // Shipping binary directory is where UE4SS gets installed.
  for (const name of probe.namesIn('')) {
    const binDir = `${name}/Binaries/Win64`;
    if (probe.hasDir(binDir)) {
      (result.extra ??= {})['shippingBinDir'] = binDir;
      break;
    }
  }
  return result;
}

/* --------------------------------------------------------------------- nwjs */

export function probeNwjs(ctx: ProbeContext): ProbeResult {
  const { probe } = ctx;
  const base = probe.hasFile('www/package.json') ? 'www' : '';
  const raw = probe.readText(base ? `${base}/package.json` : 'package.json', 64 * 1024);
  const result: ProbeResult = {};
  if (!raw) return result;
  try {
    const pkg = JSON.parse(raw) as { name?: string; window?: { title?: string }; chromium_args?: string };
    const title = pkg.window?.title ?? pkg.name;
    if (title) result.title = title;
  } catch {
    /* ignore */
  }
  return result;
}

/* --------------------------------------------------------------------- arch */

export function probeArch(ctx: ProbeContext): Arch {
  const candidates = [ctx.primaryExe, ...ctx.exeNames].filter((x): x is string => Boolean(x));
  for (const exe of candidates) {
    const arch = peArch(ctx.probe, exe);
    if (arch !== 'unknown') return arch;
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ dispatch */

const PROBES: Record<string, (ctx: ProbeContext) => ProbeResult> = {
  unityBackend: probeUnity,
  unityVersion: () => ({}), // folded into probeUnity, kept so registry ids stay meaningful
  renpyVersion: probeRenpy,
  rpgmakerInfo: probeRpgMaker,
  rgssVariant: probeRgss,
  godotVersion: probeGodot,
  unrealVersion: probeUnreal,
  nwjsVersion: probeNwjs,
  peArch: () => ({}),
};

/** Probe ids an engine definition may reference. Exported so validateRegistry can reject a typo. */
export const PROBE_IDS = Object.keys(PROBES);

export function runProbes(ctx: ProbeContext, probeIds: string[]): ProbeResult {
  const merged: ProbeResult = { notes: [], extra: {} };
  for (const id of probeIds) {
    const fn = PROBES[id];
    if (!fn) continue;
    const out = fn(ctx);
    if (out.arch) merged.arch = out.arch;
    if (out.unity) merged.unity = out.unity;
    if (out.engineVersion && !merged.engineVersion) merged.engineVersion = out.engineVersion;
    if (out.title && !merged.title) merged.title = out.title;
    if (out.notes) merged.notes!.push(...out.notes);
    if (out.extra) Object.assign(merged.extra!, out.extra);
  }
  if (probeIds.includes('peArch')) merged.arch = probeArch(ctx);
  return merged;
}

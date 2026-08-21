/** Shared type surface for IndieDeck core. */

export type Arch = 'x86' | 'x64' | 'arm64' | 'unknown';
export type Backend = 'mono' | 'il2cpp' | 'unknown';
export type Confidence = 'verified' | 'inferred' | 'community' | 'unverified';
export type Severity = 'block' | 'warn' | 'info' | 'prefer';
export type Channel = 'stable' | 'prerelease' | 'bleeding-edge';

/* ------------------------------------------------------------------ registry */

export interface DetectionRule {
  kind:
    | 'file'
    | 'fileAny'
    | 'fileGlob'
    | 'fileUnder'
    | 'dir'
    | 'dirAny'
    | 'dirGlob'
    | 'dirSuffix'
    | 'extRoot'
    | 'extUnder'
    | 'exeSiblingExt'
    | 'exeSiblingSuffix';
  value: string | string[];
  dir?: string;
  score: number;
  capture?: string;
  recursive?: boolean;
  note?: string;
}

export interface EngineDef {
  id: string;
  name: string;
  displayName?: string;
  family: string;
  priority: number;
  minScore: number;
  rules: DetectionRule[];
  probes: string[];
  loaders: string[];
  translators: string[];
}

export interface VersionConstraint {
  min?: string;
  max?: string;
  confidence?: Confidence;
  sources?: string[];
  note?: string;
}

export interface LoaderConstraints {
  backend?: Backend[];
  arch?: Arch[];
  unityVersion?: VersionConstraint;
  runtime?: { dotnet?: string; confidence?: Confidence; sources?: string[]; note?: string };
  conflictsWith?: string[];
  note?: string;
}

export interface AssetSource {
  type: 'github-release' | 'url';
  repo?: string;
  tag?: string;
  asset?: string;
  assetPattern?: string;
  url?: string;
  size?: number;
  /** Pinned checksum. When absent the download reports integrity "unverified". */
  sha256?: string;
}

export interface LoaderVersion {
  version: string;
  build?: number;
  commit?: string;
  channel: Channel;
  released?: string;
  assets: Partial<Record<Arch, AssetSource>>;
}

export interface InstallSpec {
  kind:
    | 'extract-root'
    | 'extract-into'
    | 'run-setup'
    | 'tool-install'
    | 'native'
    | 'manual'
    | 'bundled'
    | 'external-tool';
  dest?: string;
  setupExe?: string;
  launchShortcut?: string;
  url?: string;
  note?: string;
}

export interface LoaderDef {
  id: string;
  name: string;
  provides: string[];
  homepage?: string;
  license?: string;
  engines: string[];
  stability?: string;
  constraints: LoaderConstraints;
  installedMarkers: {
    paths: string[];
    globs?: string[];
    /** Presence of any of these rules the loader OUT - used to separate look-alike layouts. */
    excludeIfPresent?: string[];
    versionFrom?: { kind: string; path: string };
    note?: string;
  };
  install: InstallSpec;
  uninstall?: { removePaths: string[] };
  versions: LoaderVersion[];
}

export interface TranslatorVariant {
  payloadNote?: string;
  id: string;
  name: string;
  assetTemplate?: string;
  asset?: string;
  assetPattern?: string;
  requiresLoader?: { capability: string; prefer?: string[]; bundled?: boolean };
  constraints?: {
    engine?: string[];
    backend?: Backend[];
    arch?: Arch[];
    unityVersion?: VersionConstraint;
    conflictsWithInstalled?: string[];
  };
  install: InstallSpec;
  payloadPaths?: string[];
  configCandidates?: string[];
  configConfidence?: Confidence;
  configNote?: string;
  recommendedFor?: string;
  warnings?: string[];
  rank?: number;
}

export interface TranslatorVersion {
  version: string;
  tag: string;
  channel: Channel;
  released?: string;
  asset?: string;
  variants: string[];
  notes?: string[];
}

export interface TranslatorDef {
  id: string;
  name: string;
  kind: string;
  homepage?: string;
  repo?: string;
  license?: string;
  engines: string[];
  summary?: string;
  runsOutOfProcess?: boolean;
  detectOnly?: boolean;
  maintenance?: { lastPush?: string; status?: string; note?: string };
  requiresRuntime?: Record<string, string>;
  installedMarkers?: { paths: string[]; globs?: string[] };
  endpoints?: { id: string; needsKey: boolean; note?: string }[];
  variants: TranslatorVariant[];
  versions: TranslatorVersion[];
  companions?: unknown[];
  notes?: string[];
}

export interface CompatRule {
  id: string;
  severity: Severity;
  confidence: Confidence;
  sources?: string[];
  when: Record<string, unknown>;
  message?: string;
  scoreDelta?: number;
  suggestVariants?: string[];
  suggestLoaders?: string[];
  suggestTranslators?: string[];
  pinTranslatorVersions?: string[];
  requireTranslatorVersionMin?: string;
  requireLoaderBuildMin?: number;
  suggestFontBundle?: boolean;
  configHints?: Record<string, Record<string, string>>;
}

export interface FontBundle {
  id: string;
  file: string;
  unityRange: { min: string; max: string };
  confidence: Confidence;
  note?: string;
  glyphs: string[];
}

export interface Registry {
  engines: EngineDef[];
  loaders: LoaderDef[];
  translators: TranslatorDef[];
  compat: { channelPreference: Channel[]; rules: CompatRule[] };
  fonts: {
    source: AssetSource & { note?: string };
    bundles: FontBundle[];
    apply: Record<string, unknown>;
    systemFontOption?: Record<string, unknown>;
  };
  meta: { updated: Record<string, string> };
}

/* ------------------------------------------------------------------- profile */

export interface EngineMatch {
  engineId: string;
  name: string;
  score: number;
  matched: { rule: string; value: string; score: number }[];
  captures: Record<string, string>;
}

export interface InstalledLoader {
  loaderId: string;
  version?: string;
  build?: number;
  markers: string[];
}

export interface InstalledTranslator {
  translatorId: string;
  variantId?: string;
  version?: string;
  configPath?: string;
  markers: string[];
}

export interface UnityInfo {
  backend: Backend;
  version?: string;
  versionSource?: string;
  dataDir?: string;
  usesTextMeshPro?: boolean;
  usesNewInputSystem?: boolean;
}

export interface GameProfile {
  path: string;
  name: string;
  engineId: string;
  engineName: string;
  confidence: number;
  alternatives: { engineId: string; score: number }[];
  executable?: string;
  arch: Arch;
  sizeBytes?: number;
  unity?: UnityInfo;
  engineVersion?: string;
  title?: string;
  captures: Record<string, string>;
  installedLoaders: InstalledLoader[];
  installedTranslators: InstalledTranslator[];
  /** TMP font asset bundles already sitting in the game root. */
  installedFontBundles: string[];
  notes: string[];
  scannedAt: string;
}

/* --------------------------------------------------------------------- plans */

export interface PlanFinding {
  ruleId: string;
  severity: Severity;
  confidence: Confidence;
  message: string;
  sources?: string[];
}

export interface PlanStep {
  action: 'download' | 'extract' | 'copy' | 'run' | 'config' | 'manual' | 'backup';
  description: string;
  source?: AssetSource;
  dest?: string;
  details?: Record<string, unknown>;
}

export interface TranslatorPlan {
  gamePath: string;
  translatorId: string;
  translatorName: string;
  variantId: string;
  variantName: string;
  version: string;
  tag: string;
  loader?: { loaderId: string; name: string; version: string; channel: Channel; alreadyInstalled: boolean };
  fontBundle?: { id: string; file: string; confidence: Confidence; note?: string };
  score: number;
  viable: boolean;
  findings: PlanFinding[];
  steps: PlanStep[];
  config: Record<string, Record<string, string>>;
}

export interface ResolveOptions {
  targetLanguage?: string;
  sourceLanguage?: string;
  endpoint?: string;
  translatorId?: string;
  variantId?: string;
  version?: string;
  allowPrerelease?: boolean;
  includeNonViable?: boolean;
}

/* ------------------------------------------------------------------ receipts */

/**
 * One file touched by an install.
 *
 * "create" means the file did not exist, so removing it restores the folder.
 * "modify" means it did exist, so `backup` holds the displaced original and
 * uninstall must put it back rather than delete it. "snapshot" records a copy
 * taken before an external patcher ran, with no write of our own.
 */
export interface ReceiptEntry {
  path: string;
  operation: 'create' | 'modify' | 'snapshot';
  /** Relative path of the displaced original, for modify/snapshot. */
  backup?: string;
  /** Hash of what we wrote, so uninstall can spot later hand edits. */
  sha256?: string;
}

export interface InstallReceipt {
  id: string;
  /** 1 = the original files[]/backups[] shape, 2 = typed entries[]. */
  schemaVersion?: number;
  gamePath: string;
  kind: 'loader' | 'translator' | 'mod' | 'font';
  componentId: string;
  variantId?: string;
  version: string;
  installedAt: string;
  entries: ReceiptEntry[];
  /** @deprecated schemaVersion 1 shape, still read so old installs stay removable. */
  files?: string[];
  /** @deprecated schemaVersion 1 shape. */
  backups?: { original: string; backup: string }[];
  source?: AssetSource;
  planFindings?: PlanFinding[];
}

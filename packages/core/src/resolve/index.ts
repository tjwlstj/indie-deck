import type {
  AssetSource,
  Channel,
  CompatRule,
  FontBundle,
  GameProfile,
  LoaderDef,
  LoaderVersion,
  PlanFinding,
  PlanStep,
  Registry,
  ResolveOptions,
  TranslatorDef,
  TranslatorPlan,
  TranslatorVariant,
  TranslatorVersion,
} from '../types.ts';
import { loadersProviding } from '../registry/index.ts';
import { compareVersions, gte, lt, satisfiesRange } from '../util/version.ts';

/** Endpoints that talk to an HTTPS service and therefore hit the old-Mono TLS issue. */
const HTTPS_ENDPOINTS = new Set([
  'GoogleTranslate',
  'GoogleTranslateV2',
  'GoogleTranslateCompat',
  'GoogleTranslateLegitimate',
  'BingTranslate',
  'BingTranslateLegitimate',
  'DeepLTranslate',
  'DeepLTranslateLegitimate',
  'PapagoTranslate',
  'BaiduTranslate',
  'YandexTranslate',
  'WatsonTranslate',
  'LingoCloudTranslate',
]);

interface Candidate {
  translator: TranslatorDef;
  variant: TranslatorVariant;
  version: TranslatorVersion;
  loaderDef?: LoaderDef;
  loaderVersion?: LoaderVersion;
  loaderInstalled: boolean;
  isLatest: boolean;
}

interface RuleContext {
  profile: GameProfile;
  candidate: Candidate;
  options: ResolveOptions;
}

/* ------------------------------------------------------------- rule matching */

function matchesWhen(rule: CompatRule, ctx: RuleContext): boolean {
  const { profile, candidate, options } = ctx;
  const when = rule.when;
  const backend = profile.unity?.backend;
  const unityVersion = profile.unity?.version;
  const endpoint = options.endpoint;

  for (const [key, expected] of Object.entries(when)) {
    switch (key) {
      case 'backend':
        if (backend !== expected) return false;
        break;
      case 'engine':
        if (profile.engineId !== expected) return false;
        break;
      case 'engineIn':
        if (!(expected as string[]).includes(profile.engineId)) return false;
        break;
      case 'translator':
        if (candidate.translator.id !== expected) return false;
        break;
      case 'variant':
        if (candidate.variant.id !== expected) return false;
        break;
      case 'variantIn':
        if (!(expected as string[]).includes(candidate.variant.id)) return false;
        break;
      case 'translatorVersion':
        if (candidate.version.version !== expected) return false;
        break;
      case 'translatorVersionBelow':
        if (!lt(candidate.version.version, expected as string)) return false;
        break;
      case 'loaderId':
        if (candidate.loaderDef?.id !== expected) return false;
        break;
      case 'loaderBuildBelow': {
        const build = candidate.loaderVersion?.build;
        if (build === undefined || build >= (expected as number)) return false;
        break;
      }
      case 'unityVersionBelow':
        // An unknown Unity version must not silently trigger a version gate.
        if (!unityVersion || !lt(unityVersion, expected as string)) return false;
        break;
      case 'endpointIn':
        if (!endpoint || !(expected as string[]).includes(endpoint)) return false;
        break;
      case 'endpointRequiresHttps':
        if (!endpoint || HTTPS_ENDPOINTS.has(endpoint) !== expected) return false;
        break;
      case 'targetLanguageIn':
        if (!options.targetLanguage || !(expected as string[]).includes(options.targetLanguage)) return false;
        break;
      case 'gameUsesTextMeshPro':
        if (profile.unity?.usesTextMeshPro !== expected) return false;
        break;
      case 'gameHasNewInputSystem':
        if (profile.unity?.usesNewInputSystem !== expected) return false;
        break;
      case 'installedLoaderAny':
        if (!profile.installedLoaders.some((l) => (expected as string[]).includes(l.loaderId))) return false;
        break;
      case 'loaderAlreadyInstalled':
        if (candidate.loaderInstalled !== expected) return false;
        break;
      case 'translatorIsLatest':
        if (candidate.isLatest !== expected) return false;
        break;
      case 'channel':
        if (candidate.loaderVersion?.channel !== expected) return false;
        break;
      case 'archMismatch': {
        const loaderArchs = Object.keys(candidate.loaderVersion?.assets ?? {});
        const mismatch =
          profile.arch !== 'unknown' && loaderArchs.length > 0 && !loaderArchs.includes(profile.arch);
        if (mismatch !== expected) return false;
        break;
      }
      case 'renpyOnlyCompiled':
        if ((profile.captures['renpyOnlyCompiled'] === 'true') !== expected) return false;
        break;
      default:
        return false; // unknown predicate: never fire, rather than fire wrongly
    }
  }
  return true;
}

/* ------------------------------------------------------------ loader picking */

function loaderSatisfies(loader: LoaderDef, profile: GameProfile): boolean {
  const c = loader.constraints ?? {};
  const backend = profile.unity?.backend;
  if (c.backend && backend && backend !== 'unknown' && !c.backend.includes(backend)) return false;
  if (!loader.engines.includes(profile.engineId)) return false;
  return true;
}

function pickLoaderVersion(
  loader: LoaderDef,
  profile: GameProfile,
  channelPreference: Channel[],
  allowPrerelease: boolean,
): LoaderVersion | undefined {
  const arch = profile.arch === 'unknown' ? 'x64' : profile.arch;
  const usable = loader.versions.filter((v) => v.assets[arch] !== undefined);
  if (usable.length === 0) return undefined;

  // Stable always wins when a stable line exists at all (BepInEx 5). When it
  // does not - BepInEx 6 only ships prereleases and CI builds - pick the newest
  // build rather than the channel label: v6.0.0-pre.2 is two years older than
  // the bleeding-edge builds upstream tells IL2CPP users to install.
  const stable = usable.filter((v) => v.channel === 'stable');
  if (stable.length > 0) return [...stable].sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!allowPrerelease) return undefined;

  const rank = (v: LoaderVersion): number => {
    const idx = channelPreference.indexOf(v.channel);
    return idx < 0 ? channelPreference.length : idx;
  };
  const sameBase = new Set(usable.map((v) => v.version.split('-')[0])).size === 1;
  return [...usable].sort((a, b) =>
    sameBase ? compareVersions(b.version, a.version) : rank(a) - rank(b) || compareVersions(b.version, a.version),
  )[0];
}

function resolveLoaderFor(
  reg: Registry,
  variant: TranslatorVariant,
  profile: GameProfile,
  options: ResolveOptions,
): { def?: LoaderDef; version?: LoaderVersion; installed: boolean } {
  const requirement = variant.requiresLoader;
  if (!requirement || requirement.bundled) return { installed: false };

  const providers = loadersProviding(reg, requirement.capability).filter((l) => loaderSatisfies(l, profile));
  if (providers.length === 0) return { installed: false };

  // An already-installed provider wins: stacking a second loader is how game
  // folders end up in the state IndieDeck exists to clean up.
  const installed = providers.find((p) => profile.installedLoaders.some((l) => l.loaderId === p.id));
  if (installed) {
    const record = profile.installedLoaders.find((l) => l.loaderId === installed.id)!;
    const known = installed.versions.find(
      (v) =>
        (record.version !== undefined && v.version === record.version) ||
        (record.build !== undefined && v.build !== undefined && v.build === record.build),
    );
    const result: { def?: LoaderDef; version?: LoaderVersion; installed: boolean } = { def: installed, installed: true };
    const version =
      known ??
      (record.version
        ? ({ version: record.version, channel: 'stable' as Channel, assets: {}, ...(record.build !== undefined ? { build: record.build } : {}) } satisfies LoaderVersion)
        : undefined);
    if (version) result.version = version;
    return result;
  }

  const preferred = (requirement.prefer ?? []).map((id) => providers.find((p) => p.id === id)).filter((p): p is LoaderDef => Boolean(p));
  const ordered = preferred.length > 0 ? [...preferred, ...providers.filter((p) => !preferred.includes(p))] : providers;

  for (const def of ordered) {
    const version = pickLoaderVersion(def, profile, reg.compat.channelPreference, options.allowPrerelease ?? true);
    if (version) return { def, version, installed: false };
    if (def.versions.length === 0) return { def, installed: false }; // manual/native loader
  }
  return { installed: false };
}

/* ----------------------------------------------------------------- font pick */

export function pickFontBundle(reg: Registry, unityVersion: string | undefined): FontBundle | undefined {
  if (!unityVersion) return undefined;
  return reg.fonts.bundles.find((b) => satisfiesRange(unityVersion, b.unityRange));
}

/* --------------------------------------------------------------- asset build */

function buildAssetSource(translator: TranslatorDef, variant: TranslatorVariant, version: TranslatorVersion): AssetSource | undefined {
  if (!translator.repo) return undefined;
  const asset =
    version.asset ??
    (variant.assetTemplate ? variant.assetTemplate.replace('{version}', version.version) : undefined) ??
    variant.asset;
  const source: AssetSource = { type: 'github-release', repo: translator.repo, tag: version.tag };
  if (asset) source.asset = asset;
  else if (variant.assetPattern) source.assetPattern = variant.assetPattern;
  return source;
}

/* ---------------------------------------------------------------- plan build */

function buildSteps(
  candidate: Candidate,
  profile: GameProfile,
  assetSource: AssetSource | undefined,
  font: FontBundle | undefined,
  reg: Registry,
): PlanStep[] {
  const steps: PlanStep[] = [];
  const { variant, translator, loaderDef, loaderVersion, loaderInstalled } = candidate;

  if (loaderDef && !loaderInstalled && loaderVersion) {
    const arch = profile.arch === 'unknown' ? 'x64' : profile.arch;
    const source = loaderVersion.assets[arch];
    if (source) {
      steps.push({
        action: 'download',
        description: `Download ${loaderDef.name} ${loaderVersion.version} (${arch})`,
        source,
      });
      steps.push({
        action: 'extract',
        description: `Extract ${loaderDef.name} into the game folder`,
        dest: '.',
        details: { loaderId: loaderDef.id, version: loaderVersion.version },
      });
    } else {
      steps.push({
        action: 'manual',
        description: `${loaderDef.name} has no downloadable asset for ${arch} - install it manually first (${loaderDef.install.url ?? loaderDef.homepage ?? 'see upstream'})`,
      });
    }
  } else if (loaderDef && loaderInstalled) {
    steps.push({
      action: 'manual',
      description: `Reuse the ${loaderDef.name} install already present${loaderVersion?.version ? ` (${loaderVersion.version})` : ''}`,
    });
  }

  if (variant.install.kind === 'run-setup') {
    steps.push({ action: 'backup', description: 'Snapshot the game assemblies before ReiPatcher rewrites them', dest: profile.unity?.dataDir ? `${profile.unity.dataDir}/Managed` : 'Managed' });
  }

  if (assetSource) {
    steps.push({ action: 'download', description: `Download ${translator.name} ${candidate.version.version} (${variant.name})`, source: assetSource });
  }

  switch (variant.install.kind) {
    case 'extract-root':
      steps.push({ action: 'extract', description: `Extract ${translator.name} into the game folder`, dest: '.' });
      break;
    case 'extract-into':
      steps.push({ action: 'extract', description: `Extract ${translator.name} into ${variant.install.dest}`, dest: variant.install.dest ?? '.' });
      break;
    case 'run-setup':
      steps.push({ action: 'extract', description: `Extract ${translator.name} into the game folder`, dest: '.' });
      steps.push({
        action: 'run',
        description: `Run ${variant.install.setupExe} and then launch through the generated "(Patch and Run)" shortcut once`,
        details: { exe: variant.install.setupExe, requiresUserAction: true },
      });
      break;
    case 'tool-install':
      steps.push({ action: 'extract', description: `Install ${translator.name} into the IndieDeck tools folder`, dest: variant.install.dest ?? '$toolsDir' });
      break;
    case 'manual':
    case 'external-tool':
      steps.push({ action: 'manual', description: `${translator.name} must be installed by hand (${translator.homepage ?? 'see upstream'})` });
      break;
    default:
      break;
  }

  if (font) {
    steps.push({
      action: 'download',
      description: `Download the TMP font bundle archive (${reg.fonts.source.asset})`,
      source: reg.fonts.source,
    });
    steps.push({ action: 'copy', description: `Copy ${font.file} into the game folder`, dest: font.file });
  }

  if (variant.configCandidates?.length) {
    steps.push({
      action: 'config',
      description: `Write ${variant.configCandidates[0]} (created on first launch if missing)`,
      dest: variant.configCandidates[0]!,
    });
  }

  return steps;
}

function buildConfig(
  candidate: Candidate,
  options: ResolveOptions,
  font: FontBundle | undefined,
  hints: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  if (candidate.translator.id !== 'xunity-autotranslator') return hints;
  const config: Record<string, Record<string, string>> = {
    Service: { Endpoint: options.endpoint ?? 'GoogleTranslate' },
    General: { Language: options.targetLanguage ?? 'en', FromLanguage: options.sourceLanguage ?? 'ja' },
  };
  if (font) config['Behaviour'] = { FallbackFontTextMeshPro: font.file };
  for (const [section, kv] of Object.entries(hints)) {
    config[section] = { ...(config[section] ?? {}), ...kv };
  }
  return config;
}

/* -------------------------------------------------------------------- public */

export function resolvePlans(reg: Registry, profile: GameProfile, options: ResolveOptions = {}): TranslatorPlan[] {
  const plans: TranslatorPlan[] = [];
  const translators = reg.translators.filter(
    (t) =>
      (t.engines.includes(profile.engineId) || t.engines.includes('*')) &&
      !t.detectOnly &&
      (!options.translatorId || t.id === options.translatorId),
  );

  for (const translator of translators) {
    const latestVersion = [...translator.versions].sort((a, b) => compareVersions(b.version, a.version))[0];

    for (const variant of translator.variants) {
      if (options.variantId && variant.id !== options.variantId) continue;

      const c = variant.constraints ?? {};
      if (c.engine && !c.engine.includes(profile.engineId)) continue;
      if (c.arch && profile.arch !== 'unknown' && !c.arch.includes(profile.arch)) continue;

      const versions = translator.versions.filter(
        (v) => v.variants.includes(variant.id) && (!options.version || v.version === options.version),
      );

      for (const version of versions) {
        const loader = resolveLoaderFor(reg, variant, profile, options);
        const candidate: Candidate = {
          translator,
          variant,
          version,
          loaderInstalled: loader.installed,
          isLatest: version.version === latestVersion?.version,
        };
        if (loader.def) candidate.loaderDef = loader.def;
        if (loader.version) candidate.loaderVersion = loader.version;

        const findings: PlanFinding[] = [];
        const hints: Record<string, Record<string, string>> = {};
        let score = variant.rank ?? 50;
        let viable = true;
        let wantsFont = false;

        // Static constraints declared on the variant itself.
        const backend = profile.unity?.backend;
        if (c.backend && backend && backend !== 'unknown' && !c.backend.includes(backend)) {
          viable = false;
          findings.push({
            ruleId: 'variant-backend-mismatch',
            severity: 'block',
            confidence: 'verified',
            message: `${variant.name} targets ${c.backend.join('/')}, but this game is ${backend}.`,
          });
        }
        if (c.unityVersion && profile.unity?.version && !satisfiesRange(profile.unity.version, c.unityVersion)) {
          viable = false;
          findings.push({
            ruleId: 'variant-unity-range',
            severity: 'block',
            confidence: c.unityVersion.confidence ?? 'inferred',
            message:
              c.unityVersion.note ??
              `${variant.name} requires Unity ${c.unityVersion.min ?? '*'} - ${c.unityVersion.max ?? '*'}; this game is ${profile.unity.version}.`,
            ...(c.unityVersion.sources ? { sources: c.unityVersion.sources } : {}),
          });
        }
        if (variant.requiresLoader && !variant.requiresLoader.bundled && !loader.def) {
          viable = false;
          findings.push({
            ruleId: 'loader-unavailable',
            severity: 'block',
            confidence: 'verified',
            message: `No registered loader provides "${variant.requiresLoader.capability}" for this game.`,
          });
        }
        for (const warning of variant.warnings ?? []) {
          findings.push({ ruleId: 'variant-warning', severity: 'warn', confidence: 'verified', message: warning });
        }
        if (translator.maintenance?.status === 'dormant') {
          findings.push({
            ruleId: 'translator-dormant',
            severity: 'info',
            confidence: 'verified',
            message: translator.maintenance.note ?? `${translator.name} is no longer actively maintained.`,
          });
          score -= 5;
        }

        // Registry compatibility rules.
        for (const rule of reg.compat.rules) {
          if (!matchesWhen(rule, { profile, candidate, options })) continue;

          if (rule.severity === 'prefer') {
            score += rule.scoreDelta ?? 0;
            continue;
          }
          if (rule.severity === 'block') viable = false;
          if (rule.severity === 'warn') score -= rule.confidence === 'unverified' ? 3 : 12;
          if (rule.suggestFontBundle) wantsFont = true;
          if (rule.configHints) {
            for (const [section, kv] of Object.entries(rule.configHints)) {
              hints[section] = { ...(hints[section] ?? {}), ...kv };
            }
          }
          findings.push({
            ruleId: rule.id,
            severity: rule.severity,
            confidence: rule.confidence,
            message: rule.message ?? rule.id,
            ...(rule.sources ? { sources: rule.sources } : {}),
          });
        }

        if (candidate.isLatest) score += 5;

        const font = wantsFont ? pickFontBundle(reg, profile.unity?.version) : undefined;
        if (wantsFont && !font) {
          findings.push({
            ruleId: 'font-bundle-unresolved',
            severity: 'warn',
            confidence: 'inferred',
            message:
              'A CJK fallback font is needed but no TMP bundle matches this Unity version - use the TextMeshPro 3.2+ system-font option instead.',
          });
        }
        if (font && profile.installedFontBundles.includes(font.id)) score += 3;

        if (!viable && !options.includeNonViable) continue;

        const assetSource = buildAssetSource(translator, variant, version);
        const plan: TranslatorPlan = {
          gamePath: profile.path,
          translatorId: translator.id,
          translatorName: translator.name,
          variantId: variant.id,
          variantName: variant.name,
          version: version.version,
          tag: version.tag,
          score,
          viable,
          findings,
          steps: buildSteps(candidate, profile, assetSource, font, reg),
          config: buildConfig(candidate, options, font, hints),
        };
        if (loader.def) {
          plan.loader = {
            loaderId: loader.def.id,
            name: loader.def.name,
            version: loader.version?.version ?? 'unknown',
            channel: loader.version?.channel ?? 'stable',
            alreadyInstalled: loader.installed,
          };
        }
        if (font) {
          plan.fontBundle = { id: font.id, file: font.file, confidence: font.confidence, ...(font.note ? { note: font.note } : {}) };
        }
        plans.push(plan);
      }
    }
  }

  return plans.sort((a, b) => Number(b.viable) - Number(a.viable) || b.score - a.score || compareVersions(b.version, a.version));
}

/** The single recommendation: highest-scoring viable plan, best version of it. */
export function recommendPlan(reg: Registry, profile: GameProfile, options: ResolveOptions = {}): TranslatorPlan | undefined {
  return resolvePlans(reg, profile, options).find((p) => p.viable);
}

/** Best plan per (translator, variant) pair - what the UI shows as the option list. */
export function summarisePlans(plans: TranslatorPlan[]): TranslatorPlan[] {
  const best = new Map<string, TranslatorPlan>();
  for (const plan of plans) {
    const key = `${plan.translatorId}/${plan.variantId}`;
    const current = best.get(key);
    if (!current || plan.score > current.score || (plan.score === current.score && gte(plan.version, current.version))) {
      best.set(key, plan);
    }
  }
  return [...best.values()].sort((a, b) => Number(b.viable) - Number(a.viable) || b.score - a.score);
}

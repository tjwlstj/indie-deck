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
import { message, t, tRegistry, type Message } from '../i18n/index.ts';
import { loadersProviding } from '../registry/index.ts';
import { compareVersions, gte, lt, satisfiesRange } from '../util/version.ts';

/**
 * Whether an endpoint talks to a remote HTTPS service - which is what makes the
 * old-Mono TLS problem relevant. Derived from the provider's `tier` in the
 * config schema rather than from a second hardcoded list that would drift.
 */
function endpointUsesHttps(reg: Registry, endpoint: string): boolean {
  for (const schema of reg.configSchemas.values()) {
    const provider = schema.providers.find((p) => p.id === endpoint);
    if (provider) return !provider.tier.includes('local');
  }
  // Unknown endpoint: assume remote, which only ever adds an advisory note.
  return true;
}

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
  reg: Registry;
  profile: GameProfile;
  candidate: Candidate;
  options: ResolveOptions;
}

/** Builds a finding from a translated message, keeping key and params on it. */
function finding(
  ruleId: string,
  severity: PlanFinding['severity'],
  confidence: PlanFinding['confidence'],
  msg: Message,
  sources?: string[],
): PlanFinding {
  const out: PlanFinding = { ruleId, severity, confidence, message: msg.text, messageKey: msg.key };
  if (msg.params) out.messageParams = msg.params;
  if (sources) out.sources = sources;
  return out;
}

/**
 * Every predicate a compat rule's `when` may use.
 *
 * Exported so validateRegistry can reject a misspelled predicate. Without this
 * the switch below simply returns false for an unknown key, which silently
 * disables the whole rule - a typo used to turn a "block" into nothing.
 */
export const RULE_PREDICATES = [
  'backend',
  'engine',
  'engineIn',
  'translator',
  'variant',
  'variantIn',
  'translatorVersion',
  'translatorVersionBelow',
  'loaderId',
  'loaderBuildBelow',
  'unityVersionBelow',
  'endpointIn',
  'endpointRequiresHttps',
  'targetLanguageIn',
  'gameUsesTextMeshPro',
  'gameHasNewInputSystem',
  'installedLoaderAny',
  'loaderAlreadyInstalled',
  'translatorIsLatest',
  'channel',
  'archMismatch',
  'renpyOnlyCompiled',
] as const;

export type RulePredicate = (typeof RULE_PREDICATES)[number];

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
        if (!endpoint || endpointUsesHttps(ctx.reg, endpoint) !== expected) return false;
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

/** Builds a plan step whose description keeps its catalogue key. */
function step(
  action: PlanStep['action'],
  msg: Message,
  extra: Omit<PlanStep, 'action' | 'description' | 'descriptionKey' | 'descriptionParams'> = {},
): PlanStep {
  const out: PlanStep = { action, description: msg.text, descriptionKey: msg.key, ...extra };
  if (msg.params) out.descriptionParams = msg.params;
  return out;
}

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
      steps.push(
        step(
          'download',
          message(
            'core.step.download-loader',
            { loader: loaderDef.name, version: loaderVersion.version, arch },
            'Download {loader} {version} ({arch})',
          ),
          { source },
        ),
      );
      steps.push(
        step(
          'extract',
          message('core.step.extract-loader', { loader: loaderDef.name }, 'Extract {loader} into the game folder'),
          { dest: '.', details: { loaderId: loaderDef.id, version: loaderVersion.version } },
        ),
      );
    } else {
      steps.push(
        step(
          'manual',
          message(
            'core.step.loader-manual',
            { loader: loaderDef.name, arch, url: loaderDef.install.url ?? loaderDef.homepage ?? 'see upstream' },
            '{loader} has no downloadable asset for {arch} - install it manually first ({url})',
          ),
        ),
      );
    }
  } else if (loaderDef && loaderInstalled) {
    steps.push(
      step(
        'manual',
        message(
          'core.step.loader-reuse',
          { loader: loaderDef.name, version: loaderVersion?.version ?? '' },
          'Reuse the {loader} install already present {version}',
        ),
      ),
    );
  }

  if (variant.install.kind === 'run-setup') {
    steps.push(
      step(
        'backup',
        message('core.step.backup-managed', {}, 'Snapshot the game assemblies before ReiPatcher rewrites them'),
        { dest: profile.unity?.dataDir ? `${profile.unity.dataDir}/Managed` : 'Managed' },
      ),
    );
  }

  if (assetSource) {
    steps.push(
      step(
        'download',
        message(
          'core.step.download-translator',
          { translator: translator.name, version: candidate.version.version, variant: variant.name },
          'Download {translator} {version} ({variant})',
        ),
        { source: assetSource },
      ),
    );
  }

  switch (variant.install.kind) {
    case 'extract-root':
      steps.push(
        step(
          'extract',
          message('core.step.extract-translator', { translator: translator.name }, 'Extract {translator} into the game folder'),
          { dest: '.' },
        ),
      );
      break;
    case 'extract-into':
      steps.push(
        step(
          'extract',
          message(
            'core.step.extract-translator-into',
            { translator: translator.name, dest: variant.install.dest ?? '.' },
            'Extract {translator} into {dest}',
          ),
          { dest: variant.install.dest ?? '.' },
        ),
      );
      break;
    case 'run-setup':
      steps.push(
        step(
          'extract',
          message('core.step.extract-translator', { translator: translator.name }, 'Extract {translator} into the game folder'),
          { dest: '.' },
        ),
      );
      steps.push(
        step(
          'run',
          message(
            'core.step.run-setup',
            { exe: variant.install.setupExe },
            'Run {exe} and then launch through the generated "(Patch and Run)" shortcut once',
          ),
          { details: { exe: variant.install.setupExe, requiresUserAction: true } },
        ),
      );
      break;
    case 'tool-install':
      steps.push(
        step(
          'extract',
          message('core.step.install-tool', { translator: translator.name }, 'Install {translator} into the IndieDeck tools folder'),
          { dest: variant.install.dest ?? '$toolsDir' },
        ),
      );
      break;
    case 'manual':
    case 'external-tool':
      steps.push(
        step(
          'manual',
          message(
            'core.step.translator-manual',
            { translator: translator.name, url: translator.homepage ?? 'see upstream' },
            '{translator} must be installed by hand ({url})',
          ),
        ),
      );
      break;
    default:
      break;
  }

  if (font) {
    steps.push(
      step(
        'download',
        message(
          'core.step.download-fonts',
          { asset: reg.fonts.source.asset },
          'Download the TMP font bundle archive ({asset})',
        ),
        { source: reg.fonts.source },
      ),
    );
    steps.push(
      step('copy', message('core.step.copy-font', { file: font.file }, 'Copy {file} into the game folder'), {
        dest: font.file,
      }),
    );
  }

  if (variant.configCandidates?.length) {
    steps.push(
      step(
        'config',
        message(
          'core.step.write-config',
          { path: variant.configCandidates[0] },
          'Write {path} (created on first launch if missing)',
        ),
        { dest: variant.configCandidates[0]! },
      ),
    );
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
          findings.push(
            finding(
              'variant-backend-mismatch',
              'block',
              'verified',
              message(
                'core.plan.variant-backend-mismatch',
                { variant: variant.name, targets: c.backend.join('/'), backend },
                '{variant} targets {targets}, but this game is {backend}.',
              ),
            ),
          );
        }
        if (c.unityVersion && profile.unity?.version && !satisfiesRange(profile.unity.version, c.unityVersion)) {
          viable = false;
          findings.push(
            finding(
              'variant-unity-range',
              'block',
              c.unityVersion.confidence ?? 'inferred',
              c.unityVersion.note
                ? {
                    key: `registry.translators.${translator.id}.variants.${variant.id}.unityVersion.note`,
                    text: tRegistry(
                      `registry.translators.${translator.id}.variants.${variant.id}.unityVersion.note`,
                      c.unityVersion.note,
                    ),
                  }
                : message(
                    'core.plan.variant-unity-range',
                    {
                      variant: variant.name,
                      min: c.unityVersion.min ?? '*',
                      max: c.unityVersion.max ?? '*',
                      version: profile.unity.version,
                    },
                    '{variant} requires Unity {min} - {max}; this game is {version}.',
                  ),
              c.unityVersion.sources,
            ),
          );
        }
        if (variant.requiresLoader && !variant.requiresLoader.bundled && !loader.def) {
          viable = false;
          findings.push(
            finding(
              'loader-unavailable',
              'block',
              'verified',
              message(
                'core.plan.loader-unavailable',
                { capability: variant.requiresLoader.capability },
                'No registered loader provides "{capability}" for this game.',
              ),
            ),
          );
        }
        (variant.warnings ?? []).forEach((warning, index) => {
          const key = `registry.translators.${translator.id}.variants.${variant.id}.warnings.${index}`;
          findings.push(finding('variant-warning', 'warn', 'verified', { key, text: tRegistry(key, warning) }));
        });
        if (translator.maintenance?.status === 'dormant') {
          const key = `registry.translators.${translator.id}.maintenance.note`;
          findings.push(
            finding(
              'translator-dormant',
              'info',
              'verified',
              translator.maintenance.note
                ? { key, text: tRegistry(key, translator.maintenance.note) }
                : message(
                    'core.plan.translator-dormant',
                    { translator: translator.name },
                    '{translator} is no longer actively maintained.',
                  ),
            ),
          );
          score -= 5;
        }

        // Registry compatibility rules.
        for (const rule of reg.compat.rules) {
          if (!matchesWhen(rule, { reg, profile, candidate, options })) continue;

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
          // Registry rules keep their English text in compat.json; a locale file
          // supplies compat.<ruleId>.message when a translation exists.
          const ruleKey = `compat.${rule.id}.message`;
          findings.push(
            finding(
              rule.id,
              rule.severity,
              rule.confidence,
              { key: ruleKey, text: tRegistry(ruleKey, rule.message ?? rule.id) },
              rule.sources,
            ),
          );
        }

        if (candidate.isLatest) score += 5;

        const font = wantsFont ? pickFontBundle(reg, profile.unity?.version) : undefined;
        if (wantsFont && !font) {
          findings.push(
            finding(
              'font-bundle-unresolved',
              'warn',
              'inferred',
              message(
                'core.plan.font-bundle-unresolved',
                {},
                'A CJK fallback font is needed but no TMP bundle matches this Unity version - use the TextMeshPro 3.2+ system-font option instead.',
              ),
            ),
          );
        }
        if (font && profile.installedFontBundles.includes(font.id)) score += 3;

        if (!viable && !options.includeNonViable) continue;

        const assetSource = buildAssetSource(translator, variant, version);
        const plan: TranslatorPlan = {
          gamePath: profile.path,
          translatorId: translator.id,
          translatorName: tRegistry(`registry.translators.${translator.id}.name`, translator.name),
          variantId: variant.id,
          variantName: tRegistry(
            `registry.translators.${translator.id}.variants.${variant.id}.name`,
            variant.name,
          ),
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
            name: tRegistry(`registry.loaders.${loader.def.id}.name`, loader.def.name),
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

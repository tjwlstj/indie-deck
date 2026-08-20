import type { GameProfile, Registry, Severity } from '../types.ts';
import { pickFontBundle } from '../resolve/index.ts';
import { compareVersions, lt, satisfiesRange } from '../util/version.ts';

export interface AuditIssue {
  code:
    | 'font-bundle-mismatch'
    | 'font-bundle-clutter'
    | 'font-bundle-missing'
    | 'loaders-stacked'
    | 'translator-payload-orphaned'
    | 'translator-outdated'
    | 'translator-endpoint-too-old'
    | 'engine-version-unknown'
    | 'unmanaged-install';
  severity: Severity;
  message: string;
  fix?: string;
  detail?: Record<string, unknown>;
}

export interface GameAudit {
  path: string;
  name: string;
  engineId: string;
  issues: AuditIssue[];
}

export interface AuditOptions {
  targetLanguage?: string;
  endpoint?: string;
}

/** Loaders that are just "the engine's own folder", not something installed. */
const NATIVE_LOADERS = new Set(['renpy-native', 'rpgmaker-plugins', 'rgss-script-injection']);

/**
 * Checks one already-detected game for the states that quietly break
 * translation: a TMP font atlas built for the wrong Unity line, two mod loaders
 * fighting each other, plugin files with no loader to load them, and translator
 * versions that predate a fix the chosen endpoint needs.
 */
export function auditGame(reg: Registry, profile: GameProfile, options: AuditOptions = {}): GameAudit {
  const issues: AuditIssue[] = [];
  const unityVersion = profile.unity?.version;

  /* ---- TMP font bundles ---- */
  if (profile.installedFontBundles.length > 0) {
    const correct = pickFontBundle(reg, unityVersion);
    const wrong = profile.installedFontBundles.filter((id) => {
      const bundle = reg.fonts.bundles.find((b) => b.id === id);
      return bundle !== undefined && unityVersion !== undefined && !satisfiesRange(unityVersion, bundle.unityRange);
    });

    if (correct && !profile.installedFontBundles.includes(correct.id)) {
      issues.push({
        code: 'font-bundle-mismatch',
        severity: 'warn',
        message: `TMP font bundle(s) present (${profile.installedFontBundles.join(', ')}) but none matches Unity ${unityVersion} - translated text will render as blank boxes.`,
        fix: `Install ${correct.file} and point FallbackFontTextMeshPro at it.`,
        detail: { installed: profile.installedFontBundles, expected: correct.id, unityVersion },
      });
    } else if (wrong.length > 0) {
      issues.push({
        code: 'font-bundle-clutter',
        severity: 'info',
        message: `${wrong.length} TMP font bundle(s) for other Unity versions are sitting in the game folder (${wrong.join(', ')}).`,
        fix: correct ? `Only ${correct.file} is used here; the rest are dead weight.` : undefined,
        detail: { unused: wrong, unityVersion },
      });
    }
  }

  /* ---- stacked loaders ---- */
  const realLoaders = profile.installedLoaders.filter((l) => !NATIVE_LOADERS.has(l.loaderId));
  if (realLoaders.length > 1) {
    issues.push({
      code: 'loaders-stacked',
      severity: 'warn',
      message: `${realLoaders.length} mod loaders are installed at once: ${realLoaders.map((l) => l.loaderId).join(', ')}.`,
      fix: 'Keep the one the translator actually uses; ReiPatcher in particular is documented as incompatible with other plugin managers.',
      detail: { loaders: realLoaders.map((l) => l.loaderId) },
    });
  }

  /* ---- translator payload without its loader ---- */
  for (const installed of profile.installedTranslators) {
    const def = reg.translators.find((t) => t.id === installed.translatorId);
    const variant = def?.variants.find((v) => v.id === installed.variantId);
    const capability = variant?.requiresLoader?.capability;
    if (!capability || variant?.requiresLoader?.bundled) continue;

    const provided = profile.installedLoaders.some((l) =>
      reg.loaders.find((def2) => def2.id === l.loaderId)?.provides.includes(capability),
    );
    if (!provided) {
      issues.push({
        code: 'translator-payload-orphaned',
        severity: 'warn',
        message: `${def?.name ?? installed.translatorId} files for the "${variant?.name ?? installed.variantId}" variant are installed, but no loader providing "${capability}" is present - nothing will load them.`,
        fix: `Install the matching loader, or remove the stray files and install the variant that fits the loader you have.`,
        detail: { translator: installed.translatorId, variant: installed.variantId, capability },
      });
    }
  }

  /* ---- translator version ---- */
  for (const installed of profile.installedTranslators) {
    const def = reg.translators.find((t) => t.id === installed.translatorId);
    if (!def || !installed.version || def.versions.length === 0) continue;
    const latest = [...def.versions].sort((a, b) => compareVersions(b.version, a.version))[0]!;

    if (lt(installed.version, latest.version)) {
      issues.push({
        code: 'translator-outdated',
        severity: 'info',
        message: `${def.name} ${installed.version} installed; ${latest.version} is the newest known release.`,
        fix: `indiedeck install ${JSON.stringify(profile.name)} --translator ${def.id} --version ${latest.version}`,
        detail: { installed: installed.version, latest: latest.version },
      });
    }

    if (
      def.id === 'xunity-autotranslator' &&
      options.endpoint === 'DeepLTranslateLegitimate' &&
      lt(installed.version, '5.5.2')
    ) {
      issues.push({
        code: 'translator-endpoint-too-old',
        severity: 'warn',
        message: `${def.name} ${installed.version} predates the 5.5.2 DeepL auth fix; the DeepL API will reject its requests.`,
        fix: 'Upgrade to 5.5.2 or newer, or switch endpoint.',
        detail: { installed: installed.version, requires: '5.5.2', endpoint: options.endpoint },
      });
    }

    if (def.id === 'xunity-autotranslator' && profile.unity?.usesNewInputSystem === true && lt(installed.version, '5.5.1')) {
      issues.push({
        code: 'translator-endpoint-too-old',
        severity: 'info',
        message: `${def.name} ${installed.version} predates the UnityInput change in 5.5.1; in-game hotkeys will not respond in this new-Input-System game.`,
        fix: 'Upgrade to 5.5.1 or newer.',
        detail: { installed: installed.version, requires: '5.5.1' },
      });
    }
  }

  /* ---- unknown engine version ---- */
  if (profile.engineId === 'unity' && !unityVersion) {
    issues.push({
      code: 'engine-version-unknown',
      severity: 'info',
      message: 'Unity version could not be read, so version-gated compatibility checks are advisory only for this game.',
    });
  }

  return { path: profile.path, name: profile.name, engineId: profile.engineId, issues };
}

export function auditLibrary(reg: Registry, games: GameProfile[], options: AuditOptions = {}): GameAudit[] {
  return games
    .map((g) => auditGame(reg, g, options))
    .filter((a) => a.issues.length > 0)
    .sort((a, b) => {
      const rank = (audit: GameAudit) =>
        audit.issues.some((i) => i.severity === 'block') ? 0 : audit.issues.some((i) => i.severity === 'warn') ? 1 : 2;
      return rank(a) - rank(b) || b.issues.length - a.issues.length;
    });
}

export interface AuditSummary {
  gamesWithIssues: number;
  byCode: { code: string; count: number; severity: Severity }[];
}

export function summariseAudit(audits: GameAudit[]): AuditSummary {
  const byCode = new Map<string, { count: number; severity: Severity }>();
  for (const audit of audits) {
    for (const issue of audit.issues) {
      const entry = byCode.get(issue.code) ?? { count: 0, severity: issue.severity };
      entry.count += 1;
      byCode.set(issue.code, entry);
    }
  }
  return {
    gamesWithIssues: audits.length,
    byCode: [...byCode.entries()].map(([code, v]) => ({ code, count: v.count, severity: v.severity })).sort((a, b) => b.count - a.count),
  };
}

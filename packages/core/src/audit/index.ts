import type { GameProfile, Registry, Severity } from '../types.ts';
import { message, type Message } from '../i18n/index.ts';
import { isNativeLoader } from '../registry/index.ts';
import { pickFontBundle } from '../resolve/index.ts';
import { compareVersions, lt, satisfiesRange } from '../util/version.ts';
import { collectTranslatorEvidence } from '../health/index.ts';

export type AuditCode =
  | 'font-bundle-mismatch'
  | 'font-bundle-clutter'
  | 'font-bundle-missing'
  | 'loaders-stacked'
  | 'translator-payload-orphaned'
  | 'translator-outdated'
  | 'translator-endpoint-too-old'
  | 'translator-input-system-too-old'
  | 'engine-version-unknown'
  | 'unmanaged-install'
  | 'translator-duplicate-install'
  | 'translator-multi-version'
  | 'translator-managed-drift'
  | 'translator-unmanaged'
  | 'translator-newer-than-registry'
  | 'translator-version-unknown'
  | 'translator-receipt-corrupt';

export interface AuditIssue {
  code: AuditCode;
  severity: Severity;
  /** Rendered in the active locale; `key`/`params` allow re-rendering later. */
  message: string;
  messageKey: string;
  messageParams?: Record<string, string | number | undefined>;
  fix?: string;
  fixKey?: string;
  fixParams?: Record<string, string | number | undefined>;
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

interface IssueSpec {
  code: AuditCode;
  severity: Severity;
  message: Message;
  fix?: Message;
  detail?: Record<string, unknown>;
}

function issue(spec: IssueSpec): AuditIssue {
  const out: AuditIssue = {
    code: spec.code,
    severity: spec.severity,
    message: spec.message.text,
    messageKey: spec.message.key,
  };
  if (spec.message.params) out.messageParams = spec.message.params;
  if (spec.fix) {
    out.fix = spec.fix.text;
    out.fixKey = spec.fix.key;
    if (spec.fix.params) out.fixParams = spec.fix.params;
  }
  if (spec.detail) out.detail = spec.detail;
  return out;
}

/**
 * Checks one already-detected game for the states that quietly break
 * translation: a TMP font atlas built for the wrong Unity line, two mod loaders
 * fighting each other, plugin files with no loader to load them, and translator
 * versions that predate a fix the chosen endpoint needs.
 */
export function auditGame(reg: Registry, profile: GameProfile, options: AuditOptions = {}): GameAudit {
  const issues: AuditIssue[] = [];
  const unityVersion = profile.unity?.version;

  /* ---- disk-evidenced install health (§8 of the UX contract) ---- */
  const evidenced = collectTranslatorEvidence(reg, profile, {
    endpoint: options.endpoint,
    targetLanguage: options.targetLanguage,
  });
  const evidencedIds = new Set(evidenced.map((e) => e.translatorId));
  for (const ev of evidenced) {
    const def = reg.translators.find((t) => t.id === ev.translatorId);
    const name = def?.name ?? ev.translatorId;

    for (const status of ev.healthIssues) {
      if (status === 'healthy') continue;
      if (status === 'corrupt-receipt') {
        issues.push(
          issue({
            code: 'translator-receipt-corrupt',
            severity: 'warn',
            message: message(
              'core.audit.translator-receipt-corrupt.message',
              { count: ev.receiptIssues.length, names: ev.receiptIssues.map((i) => i.name).join(', ') },
              '{count} IndieDeck receipt file(s) could not be trusted ({names}); automatic changes are blocked until this is resolved.',
            ),
            detail: { receiptIssues: ev.receiptIssues, evidence: ev },
          }),
        );
      } else if (status === 'duplicate-variants') {
        issues.push(
          issue({
            code: 'translator-duplicate-install',
            severity: 'warn',
            message: message(
              'core.audit.translator-duplicate-install.message',
              { translator: name, variants: ev.variantHits.filter((h) => h.paths.length > 0).map((h) => h.variantId).join(', ') },
              '{translator} payloads from several loader families are present ({variants}); only one can load.',
            ),
            fix: message(
              'core.audit.translator-duplicate-install.fix',
              {},
              'Clean up the duplicates, then reinstall the variant that matches this game.',
            ),
            detail: { variantHits: ev.variantHits, evidence: ev },
          }),
        );
      } else if (status === 'multiple-versions') {
        issues.push(
          issue({
            code: 'translator-multi-version',
            severity: 'warn',
            message: message(
              'core.audit.translator-multi-version.message',
              { translator: name, versions: [...new Set(ev.assemblyVersions.map((a) => a.version))].join(', ') },
              '{translator} files report several versions ({versions}); which one loads is not decidable from disk alone.',
            ),
            fix: message('core.audit.translator-multi-version.fix', {}, 'Clean up and reinstall a single version.'),
            detail: { assemblyVersions: ev.assemblyVersions, evidence: ev },
          }),
        );
      } else if (status === 'managed-drift') {
        issues.push(
          issue({
            code: 'translator-managed-drift',
            severity: 'warn',
            message: message(
              'core.audit.translator-managed-drift.message',
              {
                translator: name,
                receipt: ev.receipts[0]?.version ?? '?',
                found: ev.assemblyVersions[0]?.version ?? '?',
              },
              '{translator} does not match its IndieDeck record (receipt {receipt}, files report {found}).',
            ),
            fix: message('core.audit.translator-managed-drift.fix', {}, 'Review the changed files, then run a repair install.'),
            detail: {
              receipts: ev.receipts,
              modifiedOwnedPaths: ev.modifiedOwnedPaths,
              assemblyVersions: ev.assemblyVersions,
              evidence: ev,
            },
          }),
        );
      } else if (status === 'orphaned') {
        // Already covered by the legacy translator-payload-orphaned check below
        // when it fires on the same condition; emit only when that loop will
        // skip this translator.
        const hasLegacyOrphan = profile.installedTranslators.some(
          (installed) => installed.translatorId === ev.translatorId && !evidencedIds.has(ev.translatorId),
        );
        if (!hasLegacyOrphan && !issues.some((i) => i.code === 'translator-payload-orphaned')) {
          issues.push(
            issue({
              code: 'translator-payload-orphaned',
              severity: 'warn',
              message: message(
                'core.audit.translator-payload-orphaned.evidence-message',
                { translator: name },
                '{translator} payload files are present, but no loader able to run them is installed.',
              ),
              fix: message(
                'core.audit.translator-payload-orphaned.fix',
                {},
                'Install the matching loader, or remove the stray files and install the variant that fits the loader you have.',
              ),
              detail: { evidence: ev },
            }),
          );
        }
      } else if (status === 'version-conflict') {
        issues.push(
          issue({
            code: 'translator-outdated',
            severity: 'warn',
            message: message(
              'core.audit.translator-version-conflict.message',
              { translator: name, installed: ev.assemblyVersions[0]?.version ?? '?' },
              '{translator} {installed} does not fit this game\'s engine and backend combination as installed.',
            ),
            fix: message('core.audit.translator-version-conflict.fix', {}, 'Run a repair install so the resolver picks a compatible build.'),
            detail: { evidence: ev },
          }),
        );
      } else if (status === 'update-available') {
        issues.push(
          issue({
            code: 'translator-outdated',
            severity: 'info',
            message: message(
              'core.audit.translator-update-available.message',
              { translator: name, installed: ev.assemblyVersions[0]?.version ?? '?' },
              '{translator} {installed} is installed; a better-matching release for this game is available.',
            ),
            fix: message('core.audit.translator-update-available.fix', { game: JSON.stringify(profile.name), translator: ev.translatorId }, 'indiedeck install {game} --translator {translator}'),
            detail: { evidence: ev },
          }),
        );
      } else if (status === 'newer-than-registry') {
        issues.push(
          issue({
            code: 'translator-newer-than-registry',
            severity: 'info',
            message: message(
              'core.audit.translator-newer-than-registry.message',
              { translator: name, installed: ev.assemblyVersions[0]?.version ?? '?' },
              '{translator} {installed} is newer than the newest release IndieDeck knows; it will be kept as is.',
            ),
            detail: { evidence: ev },
          }),
        );
      } else if (status === 'version-unknown') {
        issues.push(
          issue({
            code: 'translator-version-unknown',
            severity: 'info',
            message: message(
              'core.audit.translator-version-unknown.message',
              { translator: name },
              '{translator} files are present but their version cannot be read from disk or receipts.',
            ),
            fix: message('core.audit.translator-version-unknown.fix', {}, 'Verify manually before any automatic replacement.'),
            detail: { evidence: ev },
          }),
        );
      } else if (status === 'unmanaged') {
        issues.push(
          issue({
            code: 'translator-unmanaged',
            severity: 'info',
            message: message(
              'core.audit.translator-unmanaged.message',
              { translator: name },
              '{translator} files are installed without an IndieDeck receipt.',
            ),
            fix: message(
              'core.audit.translator-unmanaged.fix',
              {},
              'Keep them, or back up and replace them through an IndieDeck install to make them managed.',
            ),
            detail: { evidence: ev },
          }),
        );
      }
    }
  }

  /* ---- TMP font bundles ---- */
  if (profile.installedFontBundles.length > 0) {
    const correct = pickFontBundle(reg, unityVersion);
    const wrong = profile.installedFontBundles.filter((id) => {
      const bundle = reg.fonts.bundles.find((b) => b.id === id);
      return bundle !== undefined && unityVersion !== undefined && !satisfiesRange(unityVersion, bundle.unityRange);
    });

    if (correct && !profile.installedFontBundles.includes(correct.id)) {
      issues.push(
        issue({
          code: 'font-bundle-mismatch',
          severity: 'warn',
          message: message(
            'core.audit.font-bundle-mismatch.message',
            { installed: profile.installedFontBundles.join(', '), unityVersion },
            'TMP font bundle(s) present ({installed}) but none matches Unity {unityVersion} - translated text will render as blank boxes.',
          ),
          fix: message(
            'core.audit.font-bundle-mismatch.fix',
            { bundle: correct.file },
            'Install {bundle} and point FallbackFontTextMeshPro at it.',
          ),
          detail: { installed: profile.installedFontBundles, expected: correct.id, unityVersion },
        }),
      );
    } else if (wrong.length > 0) {
      issues.push(
        issue({
          code: 'font-bundle-clutter',
          severity: 'info',
          message: message(
            'core.audit.font-bundle-clutter.message',
            { count: wrong.length, unused: wrong.join(', ') },
            '{count} TMP font bundle(s) for other Unity versions are sitting in the game folder ({unused}).',
          ),
          ...(correct
            ? {
                fix: message(
                  'core.audit.font-bundle-clutter.fix',
                  { bundle: correct.file },
                  'Only {bundle} is used here; the rest are dead weight.',
                ),
              }
            : {}),
          detail: { unused: wrong, unityVersion },
        }),
      );
    }
  }

  /* ---- stacked loaders ---- */
  const realLoaders = profile.installedLoaders.filter((l) => !isNativeLoader(reg, l.loaderId));
  if (realLoaders.length > 1) {
    issues.push(
      issue({
        code: 'loaders-stacked',
        severity: 'warn',
        message: message(
          'core.audit.loaders-stacked.message',
          { count: realLoaders.length, loaders: realLoaders.map((l) => l.loaderId).join(', ') },
          '{count} mod loaders are installed at once: {loaders}.',
        ),
        fix: message(
          'core.audit.loaders-stacked.fix',
          {},
          'Keep the one the translator actually uses; ReiPatcher in particular is documented as incompatible with other plugin managers.',
        ),
        detail: { loaders: realLoaders.map((l) => l.loaderId) },
      }),
    );
  }

  /* ---- translator payload without its loader ---- */
  for (const installed of profile.installedTranslators) {
    if (evidencedIds.has(installed.translatorId)) continue; // disk evidence owns this translator now
    const def = reg.translators.find((t) => t.id === installed.translatorId);
    const variant = def?.variants.find((v) => v.id === installed.variantId);
    const capability = variant?.requiresLoader?.capability;
    if (!capability || variant?.requiresLoader?.bundled) continue;

    const provided = profile.installedLoaders.some((l) =>
      reg.loaders.find((def2) => def2.id === l.loaderId)?.provides.includes(capability),
    );
    if (!provided) {
      issues.push(
        issue({
          code: 'translator-payload-orphaned',
          severity: 'warn',
          message: message(
            'core.audit.translator-payload-orphaned.message',
            {
              translator: def?.name ?? installed.translatorId,
              variant: variant?.name ?? installed.variantId,
              capability,
            },
            '{translator} files for the "{variant}" variant are installed, but no loader providing "{capability}" is present - nothing will load them.',
          ),
          fix: message(
            'core.audit.translator-payload-orphaned.fix',
            {},
            'Install the matching loader, or remove the stray files and install the variant that fits the loader you have.',
          ),
          detail: { translator: installed.translatorId, variant: installed.variantId, capability },
        }),
      );
    }
  }

  /* ---- translator version ---- */
  for (const installed of profile.installedTranslators) {
    if (evidencedIds.has(installed.translatorId)) continue; // disk evidence owns this translator now
    const def = reg.translators.find((t) => t.id === installed.translatorId);
    if (!def || !installed.version || def.versions.length === 0) continue;
    const latest = [...def.versions].sort((a, b) => compareVersions(b.version, a.version))[0]!;

    if (lt(installed.version, latest.version)) {
      issues.push(
        issue({
          code: 'translator-outdated',
          severity: 'info',
          message: message(
            'core.audit.translator-outdated.message',
            { translator: def.name, installed: installed.version, latest: latest.version },
            '{translator} {installed} installed; {latest} is the newest known release.',
          ),
          fix: message(
            'core.audit.translator-outdated.fix',
            { game: JSON.stringify(profile.name), translator: def.id, latest: latest.version },
            'indiedeck install {game} --translator {translator} --version {latest}',
          ),
          detail: { installed: installed.version, latest: latest.version },
        }),
      );
    }

    if (
      def.id === 'xunity-autotranslator' &&
      options.endpoint === 'DeepLTranslateLegitimate' &&
      lt(installed.version, '5.5.2')
    ) {
      issues.push(
        issue({
          code: 'translator-endpoint-too-old',
          severity: 'warn',
          message: message(
            'core.audit.translator-endpoint-too-old.message',
            { translator: def.name, installed: installed.version },
            '{translator} {installed} predates the 5.5.2 DeepL auth fix; the DeepL API will reject its requests.',
          ),
          fix: message(
            'core.audit.translator-endpoint-too-old.fix',
            {},
            'Upgrade to 5.5.2 or newer, or switch endpoint.',
          ),
          detail: { installed: installed.version, requires: '5.5.2', endpoint: options.endpoint },
        }),
      );
    }

    if (def.id === 'xunity-autotranslator' && profile.unity?.usesNewInputSystem === true && lt(installed.version, '5.5.1')) {
      issues.push(
        issue({
          code: 'translator-input-system-too-old',
          severity: 'info',
          message: message(
            'core.audit.translator-input-system-too-old.message',
            { translator: def.name, installed: installed.version },
            '{translator} {installed} predates the UnityInput change in 5.5.1; in-game hotkeys will not respond in this new-Input-System game.',
          ),
          fix: message('core.audit.translator-input-system-too-old.fix', {}, 'Upgrade to 5.5.1 or newer.'),
          detail: { installed: installed.version, requires: '5.5.1' },
        }),
      );
    }
  }

  /* ---- unknown engine version ---- */
  if (profile.engineId === 'unity' && !unityVersion) {
    issues.push(
      issue({
        code: 'engine-version-unknown',
        severity: 'info',
        message: message(
          'core.audit.engine-version-unknown.message',
          {},
          'Unity version could not be read, so version-gated compatibility checks are advisory only for this game.',
        ),
      }),
    );
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
  byCode: { code: AuditCode; count: number; severity: Severity }[];
}

export function summariseAudit(audits: GameAudit[]): AuditSummary {
  const byCode = new Map<AuditCode, { count: number; severity: Severity }>();
  for (const audit of audits) {
    for (const item of audit.issues) {
      const entry = byCode.get(item.code) ?? { count: 0, severity: item.severity };
      entry.count += 1;
      byCode.set(item.code, entry);
    }
  }
  return {
    gamesWithIssues: audits.length,
    byCode: [...byCode.entries()]
      .map(([code, v]) => ({ code, count: v.count, severity: v.severity }))
      .sort((a, b) => b.count - a.count),
  };
}

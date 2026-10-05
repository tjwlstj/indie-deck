import fsp from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from '@indiedeck/core';
import type { GameConfig, GameProfile, ReceiptEvidence, TranslatorInstallEvidence, TranslatorPlan } from '@indiedeck/core';
import { readSafeRemovalReceipts } from './receipt-guard.ts';

export type FontBlockKey = 'receipt' | 'payload' | 'config' | 'linkedPath' | 'existingFont' | 'managedFont';

/** Do not follow a junction, even when its lexical path is inside the game. */
async function safeFile(root: string, relative: string): Promise<'missing' | 'file' | 'unsafe'> {
  const parts = relative.replace(/\\/g, '/').split('/');
  if (!relative || path.isAbsolute(relative) || parts.some((part) => !part || part === '.' || part === '..' || /[:\0]/.test(part))) return 'unsafe';
  let current = root;
  try {
    const rootStat = await fsp.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 'unsafe';
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]!);
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) return 'unsafe';
      if (index === parts.length - 1) return stat.isFile() ? 'file' : 'unsafe';
      if (!stat.isDirectory()) return 'unsafe';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'unsafe';
  }
  return 'unsafe';
}

/** Font writes use stricter gates than a recommendation. Existing atlas files
 * are never overwritten. Standalone maintenance preserves every other setting
 * and may only patch the known installed variant's existing config file. */
export async function fontWriteBlockKey(
  profile: GameProfile,
  plan: TranslatorPlan,
  receipts: ReceiptEvidence,
  installations: TranslatorInstallEvidence[],
  config?: GameConfig,
): Promise<FontBlockKey | undefined> {
  if (!plan.fontBundle) return undefined;
  try {
    // Validate the exact objects and every backup/target ancestor, not just the
    // evidence summary. This also rejects a linked metadata directory.
    await readSafeRemovalReceipts(profile.path, profile.executable ? [profile.executable] : []);
    const backupDirectory = await fsp.lstat(path.join(profile.path, '.indiedeck', 'backups')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (backupDirectory && (!backupDirectory.isDirectory() || backupDirectory.isSymbolicLink())) return 'linkedPath';
  } catch { return 'receipt'; }
  if (receipts.issues.length) return 'receipt';
  const fontState = await safeFile(profile.path, plan.fontBundle.file);
  if (fontState === 'unsafe') return 'linkedPath';
  if (plan.steps.some((step) => step.action === 'copy') && fontState === 'file') return 'existingFont';
  for (const step of plan.steps.filter((entry) => entry.action === 'config')) {
    if (!step.dest || await safeFile(profile.path, step.dest) === 'unsafe') return 'linkedPath';
  }
  if (plan.purpose !== 'font') return undefined;
  if (receipts.records.some((record) => record.kind === 'font')) return 'managedFont';
  const configStep = plan.steps.find((step) => step.action === 'config');
  const fallback = config?.values.find((value) => value.id === 'xunity.fallbackFontTextMeshPro');
  if (!config?.location.exists || config.translatorId !== plan.translatorId ||
      config.location.variant !== plan.variantId || configStep?.dest !== config.location.path ||
      !fallback || fallback.assumed || fallback.section !== 'Behaviour' || fallback.key !== 'FallbackFontTextMeshPro') return 'config';
  if (await safeFile(profile.path, config.location.path) !== 'file') return 'linkedPath';
  const evidence = installations.find((entry) => entry.translatorId === plan.translatorId);
  if (!evidence?.payloadPaths.length || evidence.healthIssues.some((issue) =>
    ['duplicate-variants', 'multiple-versions', 'corrupt-receipt', 'newer-than-registry', 'orphaned'].includes(issue)) ||
    evidence.variantHits.some((hit) => hit.paths.length && hit.variantId !== plan.variantId) ||
    evidence.modifiedOwnedPaths.some((value) => value !== config.location.path) ||
    (evidence.healthIssues.includes('managed-drift') && evidence.modifiedOwnedPaths.length === 0) ||
    (evidence.assemblyVersions.length && evidence.receipts.some((record) => !record.version || compareVersions(record.version, evidence.assemblyVersions[0]!.version) !== 0))) return 'payload';
  return undefined;
}

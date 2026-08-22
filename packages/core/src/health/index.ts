/**
 * Install evidence and health classification.
 *
 * Everything here is read-only disk inspection: what files exist, which
 * versions the payload DLLs claim, and what the receipts record. The roles of
 * those sources differ - an on-disk DLL under a loadable payload path is
 * authoritative for the payload version, a receipt is evidence of ownership
 * and intent - so mismatches are reported as drift instead of one side quietly
 * winning.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  GameProfile,
  InstallHealthStatus,
  ReceiptIssueCode,
  ReceiptRecord,
  Registry,
  TranslatorInstallEvidence,
  TranslatorVariant,
} from '../types.ts';
import { FsProbe } from '../util/fsx.ts';
import { peVersionString } from '../util/pe.ts';
import { compareVersions } from '../util/version.ts';
import { resolvePlans } from '../resolve/index.ts';

export const RECEIPT_DIR = '.indiedeck/receipts';

/** §8.1 priority: corrupt > duplicates/drift > orphaned/conflict > update > rest. */
const STATUS_PRIORITY: InstallHealthStatus[] = [
  'corrupt-receipt',
  'duplicate-variants',
  'multiple-versions',
  'managed-drift',
  'orphaned',
  'version-conflict',
  'update-available',
  'newer-than-registry',
  'version-unknown',
  'unmanaged',
  'healthy',
];

export interface ReceiptEvidence {
  records: ReceiptRecord[];
  issues: { name: string; code: ReceiptIssueCode }[];
}

function isInsideRoot(relative: string): boolean {
  const cleaned = relative.replace(/\\/g, '/');
  if (cleaned === '' || cleaned.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(cleaned)) return false;
  return !cleaned.split('/').includes('..');
}

const RECEIPT_KINDS = new Set(['loader', 'translator', 'mod', 'font']);

/**
 * Reads every receipt file strictly. A receipt that cannot be trusted is kept
 * as damage evidence (`issues`) instead of being silently dropped, and its
 * storage id must be a plain file name so it can never address outside the
 * receipts folder.
 */
export function readReceiptEvidence(gameRoot: string): ReceiptEvidence {
  const out: ReceiptEvidence = { records: [], issues: [] };
  let names: string[];
  const dir = path.join(gameRoot, RECEIPT_DIR);
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }

  for (const name of names.filter((n) => n.toLowerCase().endsWith('.json'))) {
    if (name !== path.basename(name) || name.startsWith('.') || /[\\/]/.test(name)) {
      out.issues.push({ name, code: 'unsafe-storage-id' });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      out.issues.push({ name, code: 'parse-error' });
      continue;
    }
    if (typeof raw !== 'object' || raw === null) {
      out.issues.push({ name, code: 'schema-error' });
      continue;
    }
    const r = raw as Record<string, unknown>;
    const valid =
      typeof r['id'] === 'string' &&
      typeof r['kind'] === 'string' && RECEIPT_KINDS.has(r['kind'] as string) &&
      typeof r['componentId'] === 'string' && r['componentId'].length > 0 &&
      typeof r['version'] === 'string' && r['version'].length > 0 &&
      Array.isArray(r['entries']);
    if (!valid) {
      out.issues.push({ name, code: 'schema-error' });
      continue;
    }
    const entries = r['entries'] as Record<string, unknown>[];
    let entriesOk = true;
    for (const e of entries) {
      const p = e?.['path'];
      if (typeof p !== 'string' || !isInsideRoot(p)) { entriesOk = false; break; }
      const op = e?.['operation'];
      if (op !== undefined && op !== 'create' && op !== 'modify' && op !== 'snapshot') { entriesOk = false; break; }
      const backup = e?.['backup'];
      if (backup !== undefined && (typeof backup !== 'string' || !isInsideRoot(backup))) { entriesOk = false; break; }
      if ((op === 'modify' || op === 'snapshot') && typeof backup !== 'string') {
        out.issues.push({ name, code: 'missing-backup' });
        entriesOk = false;
        break;
      }
    }
    if (!entriesOk) {
      out.issues.push({ name, code: 'unsafe-entry' });
      continue;
    }
    const record: ReceiptRecord = {
      storageId: name,
      id: r['id'] as string,
      kind: r['kind'] as ReceiptRecord['kind'],
      componentId: r['componentId'] as string,
      version: r['version'] as string,
      status: 'active',
    };
    if (typeof r['variantId'] === 'string') record.variantId = r['variantId'];
    out.records.push(record);
  }
  return out;
}

interface VariantHit {
  variantId: string;
  paths: string[];
  configPath?: string;
}

function physicalRoot(relPath: string): string {
  return relPath.split(/[\\/]/)[0]!.toLowerCase();
}

/**
 * Logical variants that share the same marker and config paths (BepInEx Mono
 * vs IL2CPP ship identical layouts) are disambiguated by the game's own
 * backend, engine and architecture - §8.4 of the UX contract. Without this a
 * mono game would also "see" the il2cpp variant's loader requirement and
 * misreport the install as orphaned or duplicated.
 */
function variantFitsGame(variant: TranslatorVariant, profile: GameProfile): boolean {
  const c = variant.constraints;
  if (!c) return true;
  const backend = profile.unity?.backend;
  if (c.backend && backend && backend !== 'unknown' && !c.backend.includes(backend)) return false;
  if (c.engine && !c.engine.includes(profile.engineId)) return false;
  if (c.arch && profile.arch !== 'unknown' && !c.arch.includes(profile.arch)) return false;
  return true;
}

/** Reads versions from every DLL under an existing payload path or directory. */
function collectAssemblyVersions(probe: FsProbe, hits: VariantHit[]): { path: string; version?: string }[] {
  const seen = new Set<string>();
  const out: { path: string; version?: string }[] = [];
  for (const hit of hits) {
    for (const rel of hit.paths) {
      if (!probe.has(rel)) continue;
      const candidates = probe.hasFile(rel) && /\.dll$/i.test(rel)
        ? [rel]
        : probe.hasDir(rel)
          ? probe.namesIn(rel).filter((n) => n.toLowerCase().endsWith('.dll')).map((n) => path.join(rel, n))
          : [];
      for (const dll of candidates) {
        const key = dll.replace(/\\/g, '/').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: dll, version: peVersionString(probe, dll, 3 * 1024 * 1024) });
      }
    }
  }
  return out;
}

export interface EvidenceOptions {
  endpoint?: string;
  targetLanguage?: string;
}

/**
 * Gathers per-translator installation evidence for one game folder.
 * Returns entries only for translators with traces on disk or in receipts -
 * "absent" stays implicit because the install plans already express it.
 * Synthetic profiles whose paths do not exist yield no evidence, which keeps
 * legacy audits authoritative where nothing can actually be inspected.
 */
export function collectTranslatorEvidence(
  reg: Registry,
  profile: GameProfile,
  options: EvidenceOptions = {},
): TranslatorInstallEvidence[] {
  let probe: FsProbe;
  try {
    if (!fs.statSync(profile.path).isDirectory()) return [];
  } catch {
    return [];
  }
  probe = new FsProbe(profile.path);

  // One strict receipt pass shared by every translator; attribution happens
  // per component below via the canonical `kind-componentId.json` name.
  const receiptEvidence = readReceiptEvidence(profile.path);

  const out: TranslatorInstallEvidence[] = [];
  for (const def of reg.translators) {
    const variantHits: VariantHit[] = [];
    for (const variant of def.variants) {
      if (!variantFitsGame(variant, profile)) continue;
      const paths = (variant.payloadPaths ?? []).filter((p) => probe.has(p));
      let configPath: string | undefined;
      for (const c of variant.configCandidates ?? []) {
        if (probe.hasFile(c)) { configPath = c; break; }
      }
      if (paths.length > 0 || configPath) variantHits.push({ variantId: variant.id, paths, configPath });
    }

    const mine = receiptEvidence.records.filter((r) => r.kind === 'translator' && r.componentId === def.id);
    const myIssues = receiptEvidence.issues.filter((i) => i.name.endsWith(`-${def.id}.json`));

    if (variantHits.length === 0 && mine.length === 0 && myIssues.length === 0) continue;

    /* ---- assembly version evidence ---- */
    const assemblies = collectAssemblyVersions(probe, variantHits);
    const distinctVersions = [...new Set(assemblies.map((a) => a.version).filter((v): v is string => !!v))];
    const authoritative = distinctVersions.length === 1 ? distinctVersions[0] : undefined;

    /* ---- ownership hashes from active receipts ---- */
    const ownedPaths: string[] = [];
    const modifiedOwnedPaths: string[] = [];
    const unknownPaths: string[] = [];
    for (const record of mine) {
      let entries: { path?: unknown; sha256?: unknown }[] = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(profile.path, RECEIPT_DIR, record.storageId), 'utf8')) as Record<string, unknown>;
        entries = parsed['entries'] as typeof entries;
      } catch {
        continue;
      }
      for (const entry of entries ?? []) {
        const rel = typeof entry.path === 'string' ? entry.path : undefined;
        if (!rel) continue;
        ownedPaths.push(rel);
        if (typeof entry.sha256 !== 'string') {
          unknownPaths.push(rel); // no recorded hash - never guess "unchanged"
          continue;
        }
        try {
          const current = crypto.createHash('sha256').update(fs.readFileSync(path.join(profile.path, rel))).digest('hex');
          if (current !== entry.sha256) modifiedOwnedPaths.push(rel);
        } catch {
          modifiedOwnedPaths.push(rel); // gone or unreadable counts as changed
        }
      }
    }

    /* ---- status classification ---- */
    const issues = new Set<InstallHealthStatus>();

    if (myIssues.length > 0) issues.add('corrupt-receipt');

    const hitsWithPayload = variantHits.filter((h) => h.paths.length > 0);
    if (
      hitsWithPayload.length > 1 &&
      new Set(hitsWithPayload.map((h) => physicalRoot(h.paths[0]!))).size > 1
    ) {
      issues.add('duplicate-variants');
    }

    if (distinctVersions.length > 1) issues.add('multiple-versions');

    const receiptVersion = mine.find((r) => r.status === 'active')?.version;
    if (mine.length > 0 && authoritative && receiptVersion && compareVersions(authoritative, receiptVersion) !== 0) {
      issues.add('managed-drift');
    }
    if (modifiedOwnedPaths.length > 0) issues.add('managed-drift');

    for (const hit of variantHits) {
      const variant = def.variants.find((v) => v.id === hit.variantId);
      const capability = variant?.requiresLoader?.capability;
      if (!capability || variant?.requiresLoader?.bundled) continue;
      const provided = profile.installedLoaders.some(
        (l) => reg.loaders.find((d) => d.id === l.loaderId)?.provides.includes(capability),
      );
      if (!provided) {
        issues.add('orphaned');
        break;
      }
    }

    if (mine.length === 0 && myIssues.length === 0) issues.add('unmanaged');

    /* resolver-based comparison against THIS game's viable targets */
    let bestViable: string | undefined;
    let installedIsViable: boolean | undefined;
    if (authoritative) {
      const registryNewest = [...def.versions].sort((a, b) => compareVersions(b.version, a.version))[0]?.version;
      if (registryNewest && compareVersions(authoritative, registryNewest) > 0) {
        issues.add('newer-than-registry');
      } else {
        try {
          const plans = resolvePlans(reg, profile, { ...options, translatorId: def.id });
          bestViable = plans
            .filter((p) => p.viable)
            .map((p) => p.version)
            .sort(compareVersions)
            .at(-1);
          installedIsViable = plans.some((p) => p.viable && p.version === authoritative);
          if (bestViable && compareVersions(bestViable, authoritative) > 0) issues.add('update-available');
          else if (bestViable && !installedIsViable) issues.add('version-conflict');
        } catch {
          /* resolution failures degrade to the structural statuses above */
        }
      }
    } else if (receiptVersion) {
      // No readable DLL but a managed receipt: trust level comes from hashes.
      bestViable = undefined;
    } else {
      issues.add('version-unknown');
    }

    const healthIssues = STATUS_PRIORITY.filter((s) => issues.has(s));
    const primaryStatus = healthIssues[0] ?? 'healthy';
    const ownership: TranslatorInstallEvidence['ownership'] =
      mine.length > 0 ? 'managed' : myIssues.length > 0 ? 'unmanaged' : 'observed';

    out.push({
      translatorId: def.id,
      primaryStatus,
      healthIssues,
      ownership,
      uninstallable: mine.length > 0 && modifiedOwnedPaths.length === 0,
      variantHits: variantHits.map(({ variantId, paths, configPath }) => ({ variantId, paths, configPath })),
      payloadPaths: [...new Set(variantHits.flatMap((h) => h.paths))],
      assemblyVersions: assemblies.filter((a): a is { path: string; version: string } => !!a.version),
      receipts: mine,
      receiptIssues: myIssues,
      ownedPaths,
      modifiedOwnedPaths,
      unknownPaths,
    });
  }
  return out;
}

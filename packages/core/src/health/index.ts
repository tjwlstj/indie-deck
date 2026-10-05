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
import { isSafeReceiptComponentId } from '../install/apply.ts';

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
const SHA256 = /^[a-fA-F0-9]{64}$/;
const BACKUP_PREFIX = '.indiedeck/backups/';

function strictRelative(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const normalised = value.replace(/\\/g, '/');
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) return undefined;
  const parts = normalised.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' ||
    /[\u0000-\u001f<>:"|?*]/u.test(part) || /[ .]$/u.test(part))) return undefined;
  return normalised;
}

function pathKey(value: string): string {
  const normalised = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalised.toLowerCase() : normalised;
}

/** All existing path components must be ordinary directories/files, not links. */
function hasNoLinkedAncestor(gameRoot: string, relative: string): boolean {
  try {
    let current = path.resolve(gameRoot);
    const root = fs.lstatSync(current);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]!);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Evidence reads must not follow a forged receipt/config/backup link. Checking
 * the opened handle as well as its ancestors also rejects replacement during
 * a read. This is a read-only snapshot, not a mutation-time locking guarantee.
 */
function readRegularEvidence(gameRoot: string, relative: string): Buffer | undefined {
  const rel = strictRelative(relative);
  if (!rel || !hasNoLinkedAncestor(gameRoot, rel)) return undefined;
  const target = path.join(gameRoot, rel);
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
    const content = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const namedAfter = fs.lstatSync(target);
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs || namedAfter.dev !== after.dev || namedAfter.ino !== after.ino ||
      namedAfter.isSymbolicLink() || !hasNoLinkedAncestor(gameRoot, rel)) return undefined;
    return content;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isCanonicalReceiptMetadata(
  raw: Record<string, unknown>,
  record: ReceiptRecord,
  gameRoot: string,
  kind: 'translator' | 'font',
): boolean {
  return raw['schemaVersion'] === 2 && raw['kind'] === kind && record.kind === kind &&
    typeof raw['id'] === 'string' && raw['id'].length > 0 && raw['id'] === record.id &&
    isSafeReceiptComponentId(raw['componentId']) && raw['componentId'] === record.componentId &&
    record.storageId === `${kind}-${raw['componentId']}.json` &&
    typeof raw['version'] === 'string' && raw['version'].length > 0 && raw['version'] === record.version &&
    typeof raw['gamePath'] === 'string' && pathKey(path.resolve(raw['gamePath'])) === pathKey(path.resolve(gameRoot)) &&
    typeof raw['installedAt'] === 'string' && Number.isFinite(Date.parse(raw['installedAt'])) &&
    (raw['variantId'] === undefined || typeof raw['variantId'] === 'string') && Array.isArray(raw['entries']);
}

interface FontOwnershipOverlay {
  path: string;
  sha256: string;
  predecessorSha256: string;
  installedAt: number;
}

/**
 * A standalone font changes only the existing translator config. Its separate
 * receipt must not rewrite the translator's original ownership hash/backup.
 * Recognise exactly one intact overlay whose backup is the prior bytes; any
 * ambiguity, unsafe metadata, or changed font file keeps normal drift visible.
 */
function readFontOwnershipOverlay(gameRoot: string, evidence: ReceiptEvidence): FontOwnershipOverlay | undefined {
  const fonts = evidence.records.filter((record) => record.kind === 'font');
  if (fonts.length !== 1 || evidence.issues.length > 0) return undefined;
  const record = fonts[0]!;
  const content = readRegularEvidence(gameRoot, `${RECEIPT_DIR}/${record.storageId}`);
  if (!content) return undefined;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!isCanonicalReceiptMetadata(raw, record, gameRoot, 'font')) return undefined;

  const seen = new Set<string>();
  let overlay: FontOwnershipOverlay | undefined;
  for (const value of raw['entries'] as unknown[]) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const entry = value as Record<string, unknown>;
    const rel = strictRelative(entry['path']);
    const sha256 = entry['sha256'];
    if (!rel || pathKey(rel) === '.indiedeck' || pathKey(rel).startsWith('.indiedeck/') ||
      typeof sha256 !== 'string' || !SHA256.test(sha256) || seen.has(pathKey(rel))) return undefined;
    seen.add(pathKey(rel));
    const current = readRegularEvidence(gameRoot, rel);
    if (!current || crypto.createHash('sha256').update(current).digest('hex') !== sha256.toLowerCase()) return undefined;
    if (entry['operation'] === 'create') {
      if (entry['backup'] !== undefined) return undefined;
      continue;
    }
    if (entry['operation'] !== 'modify' || overlay) return undefined;
    const backup = strictRelative(entry['backup']);
    if (!backup || !pathKey(backup).startsWith(BACKUP_PREFIX)) return undefined;
    const predecessor = readRegularEvidence(gameRoot, backup);
    if (!predecessor) return undefined;
    overlay = {
      path: pathKey(rel),
      sha256: sha256.toLowerCase(),
      predecessorSha256: crypto.createHash('sha256').update(predecessor).digest('hex'),
      installedAt: Date.parse(raw['installedAt'] as string),
    };
  }
  return overlay;
}

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
  const fontOverlay = readFontOwnershipOverlay(profile.path, receiptEvidence);

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
    const configPaths = new Set(def.variants.flatMap((variant) => variant.configCandidates ?? []).map(pathKey));
    for (const record of mine) {
      let entries: { path?: unknown; sha256?: unknown; operation?: unknown }[] = [];
      let parsed: Record<string, unknown>;
      try {
        const content = readRegularEvidence(profile.path, `${RECEIPT_DIR}/${record.storageId}`);
        if (!content) throw new Error('Unsafe or changed receipt.');
        parsed = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
        entries = parsed['entries'] as typeof entries;
      } catch {
        myIssues.push({ name: record.storageId, code: 'unsafe-storage-id' });
        continue;
      }
      const overlayFitsReceipt = fontOverlay && mine.length === 1 &&
        isCanonicalReceiptMetadata(parsed, record, profile.path, 'translator') &&
        Date.parse(parsed['installedAt'] as string) <= fontOverlay.installedAt;
      for (const entry of entries ?? []) {
        const rel = typeof entry.path === 'string' ? entry.path : undefined;
        if (!rel) continue;
        ownedPaths.push(rel);
        if (typeof entry.sha256 !== 'string') {
          unknownPaths.push(rel); // no recorded hash - never guess "unchanged"
          continue;
        }
        try {
          const content = readRegularEvidence(profile.path, rel);
          if (!content) throw new Error('Missing, linked, or changed owned file.');
          const current = crypto.createHash('sha256').update(content).digest('hex');
          const ownedHash = entry.sha256.toLowerCase();
          const overlayIsExact = overlayFitsReceipt && configPaths.has(pathKey(rel)) &&
            pathKey(rel) === fontOverlay.path && SHA256.test(entry.sha256) &&
            (entry.operation === 'create' || entry.operation === 'modify') &&
            fontOverlay.predecessorSha256 === ownedHash && fontOverlay.sha256 === current;
          if (current !== ownedHash && !overlayIsExact) modifiedOwnedPaths.push(rel);
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
      uninstallable: mine.length > 0 && myIssues.length === 0 && modifiedOwnedPaths.length === 0,
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

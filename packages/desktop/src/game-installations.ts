import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Registry } from '@indiedeck/core';
import {
  cleanupGameArchiveStage, importGameArchive, inspectGameArchive, listGameArchives,
  type GameArchiveProgress, type GameArchiveRecord,
} from './game-archives.ts';

export interface GameProduct {
  id: string; title: string; provider: 'local'; createdAt: string; activeInstallationId?: string;
}
export interface GameRelease {
  id: string; productId: string; label?: string; versionHint?: string;
  versionEvidence: 'user-label' | 'filename-hint' | 'unknown'; createdAt: string;
}
export interface GameArtifact { id: string; sha256: string; archiveName: string; format: 'zip' }
export interface GameInstallation {
  id: string; archiveId: string; productId: string; releaseId: string; artifactId: string;
  owner: 'indiedeck'; createdAt: string;
}
export type InstallJobPhase = 'prepared' | 'staging' | 'payload-verified' | 'published' | 'registered' |
  'activated' | 'failed' | 'recovery-required';
export interface GameInstallJob {
  id: string; productId: string; releaseId: string; artifactId: string; installationId: string;
  phase: InstallJobPhase; error?: string; createdAt: string; updatedAt: string; storageDevice: string;
}
export interface GameInstallationsCatalog {
  schemaVersion: 1; revision: number; products: GameProduct[]; releases: GameRelease[];
  artifacts: GameArtifact[]; installations: GameInstallation[]; jobs: GameInstallJob[];
}
export interface RecoverGameInstallationsOptions {
  dataDir: string; registry: Registry;
  /** Main owns library registration. Must be idempotent after a crash. */
  register: (record: GameArchiveRecord) => Promise<void>;
}
export interface InstallGameArchiveVersionOptions extends RecoverGameInstallationsOptions {
  label?: string; productId?: string; expectedSha256?: string;
  onProgress?: (progress: GameArchiveProgress) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const PHASES = new Set<InstallJobPhase>(['prepared', 'staging', 'payload-verified', 'published', 'registered', 'activated', 'failed', 'recovery-required']);
const CATALOG = 'game-installations.json';
function fail(reason: string): never { throw new Error(`ui.archives.reason.${reason}`); }
function empty(): GameInstallationsCatalog {
  return { schemaVersion: 1, revision: 0, products: [], releases: [], artifacts: [], installations: [], jobs: [] };
}
function text(value: unknown, limit = 240): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function id(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function array(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length <= 10000 && value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}
function unique(entries: { id: string }[]): boolean { return new Set(entries.map((entry) => entry.id)).size === entries.length; }
function validate(input: unknown): GameInstallationsCatalog {
  if (!input || typeof input !== 'object') fail('catalogCorrupt');
  const c = input as GameInstallationsCatalog;
  if (c.schemaVersion !== 1 || !Number.isSafeInteger(c.revision) || c.revision < 0 ||
    ![c.products, c.releases, c.artifacts, c.installations, c.jobs].every(array)) fail('catalogCorrupt');
  if (![c.products, c.releases, c.artifacts, c.installations, c.jobs].every((entries) => unique(entries))) fail('catalogCorrupt');
  if (c.products.some((p) => !id(p.id) || !text(p.title) || p.provider !== 'local' || !date(p.createdAt) || p.activeInstallationId !== undefined && !id(p.activeInstallationId)) ||
    c.releases.some((r) => !id(r.id) || !id(r.productId) || !date(r.createdAt) ||
      !['user-label', 'filename-hint', 'unknown'].includes(r.versionEvidence) ||
      r.label !== undefined && !text(r.label, 80) || r.versionHint !== undefined && !text(r.versionHint, 80)) ||
    c.artifacts.some((a) => !id(a.id) || typeof a.sha256 !== 'string' || !SHA.test(a.sha256) || !text(a.archiveName) || a.format !== 'zip') ||
    c.installations.some((i) => !id(i.id) || i.archiveId !== i.id || !id(i.productId) || !id(i.releaseId) || !id(i.artifactId) || i.owner !== 'indiedeck' || !date(i.createdAt)) ||
    c.jobs.some((j) => !id(j.id) || !id(j.productId) || !id(j.releaseId) || !id(j.artifactId) || !id(j.installationId) ||
      !PHASES.has(j.phase) || !date(j.createdAt) || !date(j.updatedAt) || !text(j.storageDevice, 80) ||
      j.error !== undefined && (typeof j.error !== 'string' || !/^ui\.archives\.reason\.[a-zA-Z]+$/.test(j.error)))) fail('catalogCorrupt');
  const products = new Map(c.products.map((p) => [p.id, p]));
  const releases = new Map(c.releases.map((r) => [r.id, r]));
  const artifacts = new Map(c.artifacts.map((a) => [a.id, a]));
  const installations = new Map(c.installations.map((i) => [i.id, i]));
  const jobs = new Map(c.jobs.map((j) => [j.installationId, j]));
  if (jobs.size !== c.jobs.length) fail('catalogCorrupt');
  if (c.releases.some((r) => !products.has(r.productId)) ||
    c.installations.some((i) => !products.has(i.productId) || releases.get(i.releaseId)?.productId !== i.productId || !artifacts.has(i.artifactId) || !jobs.has(i.id)) ||
    c.jobs.some((j) => !products.has(j.productId) || releases.get(j.releaseId)?.productId !== j.productId || !artifacts.has(j.artifactId) ||
      installations.has(j.installationId) && (installations.get(j.installationId)!.productId !== j.productId || installations.get(j.installationId)!.releaseId !== j.releaseId || installations.get(j.installationId)!.artifactId !== j.artifactId)) ||
    c.products.some((p) => p.activeInstallationId && installations.get(p.activeInstallationId)?.productId !== p.id)) fail('catalogCorrupt');
  return c;
}

/** Validate each ancestor. A persisted catalog never supplies a filesystem target. */
async function ordinaryDirectory(directory: string, create = false): Promise<void> {
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  let current = root;
  const parts = [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean).map((part) => { current = path.join(current, part); return current; })];
  for (const part of parts) {
    let stat;
    try { stat = await fsp.lstat(part); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fsp.mkdir(part); stat = await fsp.lstat(part);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('storageChanged');
  }
}
async function device(dataDir: string): Promise<string> {
  const root = path.join(path.resolve(dataDir), 'game-versions');
  await ordinaryDirectory(root, true);
  return String((await fsp.stat(root)).dev);
}
export async function listGameInstallations(dataDir: string): Promise<GameInstallationsCatalog> {
  await ordinaryDirectory(dataDir, true);
  const file = path.join(path.resolve(dataDir), CATALOG);
  try {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 ** 2) fail('catalogCorrupt');
    return validate(JSON.parse(await fsp.readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    fail('catalogCorrupt');
  }
}
/** Caller serialises mutations with the desktop mutation queue. */
async function save(dataDir: string, catalog: GameInstallationsCatalog): Promise<GameInstallationsCatalog> {
  validate(catalog);
  await ordinaryDirectory(dataDir, true);
  const previous = await listGameInstallations(dataDir);
  const next = { ...catalog, revision: Math.max(previous.revision, catalog.revision) + 1 };
  const file = path.join(path.resolve(dataDir), CATALOG), temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(next, null, 2), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await fsp.rename(temporary, file);
    return next;
  } finally { await fsp.rm(temporary, { force: true }); }
}
function makePlan(catalog: GameInstallationsCatalog, input: { archiveName: string; sha256: string; label?: string; versionHint?: string; productId?: string; installationId?: string; storageDevice: string }) {
  const now = new Date().toISOString(), installationId = input.installationId ?? crypto.randomUUID();
  let product = input.productId ? catalog.products.find((p) => p.id === input.productId) : undefined;
  if (input.productId && !product) fail('invalidProduct');
  if (!product) {
    product = { id: crypto.randomUUID(), title: input.archiveName, provider: 'local' as const, createdAt: now };
    catalog.products.push(product);
  }
  const artifact: GameArtifact = { id: crypto.randomUUID(), sha256: input.sha256, archiveName: input.archiveName, format: 'zip' };
  const release: GameRelease = { id: crypto.randomUUID(), productId: product.id, createdAt: now,
    ...(input.label ? { label: input.label } : {}), ...(input.versionHint ? { versionHint: input.versionHint } : {}),
    versionEvidence: input.label ? 'user-label' : input.versionHint ? 'filename-hint' : 'unknown' };
  const job: GameInstallJob = { id: crypto.randomUUID(), productId: product.id, releaseId: release.id, artifactId: artifact.id,
    installationId, phase: 'prepared', createdAt: now, updatedAt: now, storageDevice: input.storageDevice };
  catalog.artifacts.push(artifact); catalog.releases.push(release); catalog.jobs.push(job);
  return { product, artifact, release, job };
}
function transition(job: GameInstallJob, phase: InstallJobPhase, error?: string): void {
  job.phase = phase; job.updatedAt = new Date().toISOString();
  if (error) job.error = `ui.archives.reason.${error}`; else delete job.error;
}
function attach(catalog: GameInstallationsCatalog, job: GameInstallJob, record: GameArchiveRecord): void {
  const artifact = catalog.artifacts.find((a) => a.id === job.artifactId)!;
  if (record.id !== job.installationId || record.sourceSha256 !== artifact.sha256) fail('installationUnavailable');
  if (!catalog.installations.some((i) => i.id === record.id)) {
    catalog.installations.push({ id: record.id, archiveId: record.id, productId: job.productId, releaseId: job.releaseId,
      artifactId: job.artifactId, owner: 'indiedeck', createdAt: record.importedAt });
  }
  const product = catalog.products.find((p) => p.id === job.productId)!;
  if (product.title === artifact.archiveName) product.title = record.title || artifact.archiveName;
}
async function completeRegistration(catalog: GameInstallationsCatalog, job: GameInstallJob, record: GameArchiveRecord,
  options: RecoverGameInstallationsOptions): Promise<GameInstallationsCatalog> {
  if (await device(options.dataDir) !== job.storageDevice) fail('storageChanged');
  attach(catalog, job, record);
  transition(job, 'published');
  catalog = await save(options.dataDir, catalog);
  // Objects survive the shallow snapshot save; phase changes are always awaited.
  try { await options.register(record); }
  catch (error) {
    transition(job, 'recovery-required', 'registrationFailed');
    try { await save(options.dataDir, catalog); } catch { /* Last durable published checkpoint remains recoverable. */ }
    throw error;
  }
  transition(job, 'registered');
  catalog = await save(options.dataDir, catalog);
  const product = catalog.products.find((p) => p.id === job.productId)!;
  if (!product.activeInstallationId) {
    product.activeInstallationId = record.id;
    transition(job, 'activated');
    catalog = await save(options.dataDir, catalog);
  }
  return catalog;
}

/** First import activates. Explicit updates preserve the previous active version. */
export async function installGameArchiveVersion(archivePath: string, options: InstallGameArchiveVersionOptions): Promise<{
  record: GameArchiveRecord; duplicate: boolean; productId: string; installationId: string; catalog: GameInstallationsCatalog;
}> {
  if (options.label !== undefined && (typeof options.label !== 'string' || options.label.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(options.label))) fail('invalidLabel');
  let catalog = await listGameInstallations(options.dataDir);
  if (options.productId !== undefined && (!id(options.productId) || !catalog.products.some((p) => p.id === options.productId))) fail('invalidProduct');
  const inspected = await inspectGameArchive(archivePath);
  if (!inspected.canImport || !inspected.sha256) throw new Error(inspected.reasonKey ?? 'ui.archives.reason.unsupported');
  if (options.expectedSha256 !== undefined && inspected.sha256 !== options.expectedSha256) fail('changedArchive');
  const records = await listGameArchives(options.dataDir);
  const duplicate = records.find((r) => r.sourceSha256 === inspected.sha256);
  if (duplicate) {
    let installation = catalog.installations.find((i) => i.archiveId === duplicate.id);
    if (installation && options.productId && installation.productId !== options.productId) fail('productConflict');
    if (!installation) {
      let job = catalog.jobs.find((j) => j.installationId === duplicate.id);
      if (job && options.productId && job.productId !== options.productId) fail('productConflict');
      if (!job) {
        ({ job } = makePlan(catalog, { archiveName: duplicate.archiveName, sha256: duplicate.sourceSha256,
          label: duplicate.label, versionHint: duplicate.versionHint, installationId: duplicate.id,
          productId: options.productId, storageDevice: await device(options.dataDir) }));
      }
      catalog = await completeRegistration(catalog, job, duplicate, options);
      installation = catalog.installations.find((i) => i.id === duplicate.id)!;
    } else {
      // A prior published failure is not reported as a successful duplicate.
      const job = catalog.jobs.find((j) => j.installationId === installation!.id)!;
      catalog = await completeRegistration(catalog, job, duplicate, options);
    }
    return { record: duplicate, duplicate: true, productId: installation.productId, installationId: installation.id, catalog };
  }
  const { job, product } = makePlan(catalog, { archiveName: inspected.archiveName, sha256: inspected.sha256,
    label: options.label?.trim(), versionHint: inspected.versionHint, productId: options.productId, storageDevice: await device(options.dataDir) });
  catalog = await save(options.dataDir, catalog);
  try {
    const imported = await importGameArchive(archivePath, { dataDir: options.dataDir, registry: options.registry,
      expectedSha256: inspected.sha256, label: options.label?.trim(), installationId: job.installationId,
      onProgress: options.onProgress,
      onCheckpoint: async (phase) => {
        if (await device(options.dataDir) !== job.storageDevice) fail('storageChanged');
        transition(job, phase); catalog = await save(options.dataDir, catalog);
      } });
    catalog = await completeRegistration(catalog, job, imported.record, options);
    return { ...imported, productId: product.id, installationId: imported.record.id, catalog };
  } catch (error) {
    // Never remove published payloads or roll back a previously active reference.
    const published = (await listGameArchives(options.dataDir)).some((record) => record.id === job.installationId);
    transition(job, published ? 'recovery-required' : 'failed', published ? 'registrationFailed' : 'interruptedInstall');
    // The durable pre-error checkpoint is sufficient if the disk is unavailable.
    // Do not mask the original failure with an attempted failure-journal write.
    try {
      // A failed activation save must not leak its in-memory active reference.
      const persisted = await listGameInstallations(options.dataDir);
      const savedJob = persisted.jobs.find((j) => j.id === job.id);
      if (savedJob) { transition(savedJob, job.phase, published ? 'registrationFailed' : 'interruptedInstall'); await save(options.dataDir, persisted); }
    } catch { /* Recovery will inspect the last durable checkpoint. */ }
    throw error;
  }
}

export async function setActiveGameInstallation(dataDir: string, installationId: string): Promise<GameInstallationsCatalog> {
  if (!id(installationId)) fail('invalidInstallation');
  const catalog = await listGameInstallations(dataDir), installation = catalog.installations.find((i) => i.id === installationId);
  if (!installation) fail('invalidInstallation');
  const job = catalog.jobs.find((j) => j.installationId === installation.id);
  if (!job || !['registered', 'activated'].includes(job.phase)) fail('installationUnavailable');
  const artifact = catalog.artifacts.find((a) => a.id === installation.artifactId)!;
  const record = (await listGameArchives(dataDir)).find((r) => r.id === installation.archiveId && r.sourceSha256 === artifact.sha256);
  if (!record) fail('installationUnavailable');
  if (await device(dataDir) !== job.storageDevice) fail('storageChanged');
  const product = catalog.products.find((p) => p.id === installation.productId)!;
  if (product.activeInstallationId === installation.id) return catalog;
  product.activeInstallationId = installation.id;
  return save(dataDir, catalog);
}

/** Reconciles UUID-owned payloads only; never reopens or reexecutes source files. */
export async function recoverGameInstallations(options: RecoverGameInstallationsOptions): Promise<GameInstallationsCatalog> {
  let catalog = await listGameInstallations(options.dataDir);
  const currentDevice = await device(options.dataDir);
  const records = await listGameArchives(options.dataDir), byId = new Map(records.map((r) => [r.id, r]));
  for (const jobId of catalog.jobs.map((job) => job.id)) {
    const job = catalog.jobs.find((entry) => entry.id === jobId)!;
    const product = catalog.products.find((entry) => entry.id === job.productId)!;
    if (job.phase === 'activated' || job.phase === 'registered' && product.activeInstallationId || job.phase === 'failed') continue;
    if (currentDevice !== job.storageDevice) {
      transition(job, 'recovery-required', 'storageChanged'); catalog = await save(options.dataDir, catalog); continue;
    }
    const record = byId.get(job.installationId), artifact = catalog.artifacts.find((a) => a.id === job.artifactId)!;
    if (record && record.sourceSha256 === artifact.sha256) {
      if (job.phase === 'registered') {
        product.activeInstallationId = job.installationId; transition(job, 'activated');
        catalog = await save(options.dataDir, catalog); continue;
      }
      try { catalog = await completeRegistration(catalog, job, record, options); }
      catch {
        catalog = await listGameInstallations(options.dataDir);
        const persisted = catalog.jobs.find((j) => j.id === job.id)!;
        transition(persisted, 'recovery-required', 'registrationFailed'); catalog = await save(options.dataDir, catalog);
      }
    } else if (record) {
      transition(job, 'recovery-required', 'installationUnavailable'); catalog = await save(options.dataDir, catalog);
    } else {
      // An unreadable/changed final payload is not an abandoned extraction.
      // listGameArchives intentionally hides invalid metadata/executables.
      let finalExists = true;
      try { await fsp.lstat(path.join(path.resolve(options.dataDir), 'game-versions', job.installationId)); }
      catch (error) { finalExists = (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
      if (finalExists) {
        transition(job, 'recovery-required', 'installationUnavailable'); catalog = await save(options.dataDir, catalog); continue;
      }
      const cleaned = await cleanupGameArchiveStage(options.dataDir, job.installationId, job.storageDevice);
      transition(job, cleaned ? 'failed' : 'recovery-required', 'interruptedInstall');
      catalog = await save(options.dataDir, catalog);
    }
  }
  // Legacy versions are separate products. Title similarity never merges editions.
  for (const record of records) {
    if (catalog.installations.some((i) => i.archiveId === record.id) || catalog.jobs.some((j) => j.installationId === record.id)) continue;
    const { job } = makePlan(catalog, { archiveName: record.archiveName, sha256: record.sourceSha256,
      label: record.label, versionHint: record.versionHint, installationId: record.id, storageDevice: currentDevice });
    transition(job, 'published'); catalog = await save(options.dataDir, catalog);
    try { catalog = await completeRegistration(catalog, job, record, options); }
    catch {
      catalog = await listGameInstallations(options.dataDir);
      const persisted = catalog.jobs.find((j) => j.id === job.id)!;
      transition(persisted, 'recovery-required', 'registrationFailed'); catalog = await save(options.dataDir, catalog);
    }
  }
  return catalog;
}

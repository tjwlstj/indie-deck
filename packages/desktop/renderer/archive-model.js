/** Pure archive-import presentation/state guards, not filesystem authority. */
const phaseRank = { inspect: 0, extract: 1, publish: 2, complete: 3, failed: 3 };

export function isArchiveActive(progress) {
  return progress?.status === 'running';
}

export function archiveCandidatePresentation(candidate, blocked = false) {
  return {
    canImport: Boolean(candidate?.id && candidate.format === 'zip' &&
      candidate.status === 'ready' && candidate.canImport === true && !blocked),
    manualOnly: Boolean(candidate && ['7z', 'rar'].includes(candidate.format)),
    versionIsAuthoritative: false,
  };
}

export function archiveRecordForGame(records, gameId) {
  return (Array.isArray(records) ? records : []).find((record) => record.gameId === gameId) ?? null;
}

/** Catalog relations never infer product identity from a path, title or version. */
export function managedInstallationForGame(catalog, records, gameId) {
  const record = archiveRecordForGame(records, gameId);
  if (!record) return null;
  const installation = (catalog?.installations ?? []).find((item) => item.archiveId === record.id);
  if (!installation) return null;
  const product = (catalog?.products ?? []).find((item) => item.id === installation.productId);
  return product ? { installation, product, record, active: product.activeInstallationId === installation.id } : null;
}

export function managedProductVersions(catalog, records, productId) {
  const product = (catalog?.products ?? []).find((item) => item.id === productId);
  if (!product) return [];
  const byArchive = new Map((Array.isArray(records) ? records : []).map((record) => [record.id, record]));
  return (catalog?.installations ?? []).filter((item) => item.productId === productId).map((installation) => ({
    installation,
    record: byArchive.get(installation.archiveId) ?? null,
    release: (catalog?.releases ?? []).find((item) => item.id === installation.releaseId) ?? null,
    active: product.activeInstallationId === installation.id,
  })).sort((a, b) => String(b.installation.createdAt ?? '').localeCompare(String(a.installation.createdAt ?? '')));
}

export function recoverableInstallJobs(catalog) {
  return (catalog?.jobs ?? []).filter((job) => job.phase === 'recovery-required');
}

/** A stale queued read cannot undo a completed import, activation or recovery. */
export function acceptsInstallationCatalog(current, incoming) {
  if (!incoming || !Array.isArray(incoming.products) || !Array.isArray(incoming.installations) || !Array.isArray(incoming.jobs) ||
      !Number.isSafeInteger(incoming.revision) || incoming.revision < 0) return false;
  return !Number.isSafeInteger(current?.revision) || incoming.revision >= current.revision;
}

export function installationVersionPresentation(version, blocked = false) {
  const canOpen = typeof version?.record?.gameId === 'string' && version.record.gameId.length > 0;
  return {
    canOpen,
    canActivate: canOpen && Boolean(version?.installation?.id) && version.active !== true && !blocked,
  };
}

/** Retained progress is historical evidence, so it cannot dismiss a newer read error. */
export function nextArchiveRecoveryError(current, result, authoritative = false) {
  if (result?.recoveryError) return result.recoveryError;
  return authoritative && result?.catalog ? null : current;
}

export function reduceArchiveProgress(previous, next) {
  if (!next?.id || !['running', 'complete', 'failed'].includes(next.status)) return previous;
  if (Number.isSafeInteger(previous?.sequence) && Number.isSafeInteger(next.sequence)) {
    return next.sequence > previous.sequence ? { ...next } : previous;
  }
  if (previous?.id === next.id) {
    if (previous.status !== 'running' && next.status === 'running') return previous;
    if ((phaseRank[next.phase] ?? -1) < (phaseRank[previous.phase] ?? -1)) return previous;
    if (next.phase === previous.phase && next.status === 'running' &&
        Number(next.completedFiles ?? 0) < Number(previous.completedFiles ?? 0)) return previous;
  }
  return { ...next };
}

/** An old settings list response must not erase imports completed while it was in flight. */
export function mergeArchiveRecords(current, incoming) {
  const records = new Map();
  for (const record of Array.isArray(incoming) ? incoming : []) if (record?.id) records.set(record.id, record);
  for (const record of Array.isArray(current) ? current : []) if (record?.id && !records.has(record.id)) records.set(record.id, record);
  return [...records.values()].sort((a, b) => String(b.importedAt ?? '').localeCompare(String(a.importedAt ?? '')));
}

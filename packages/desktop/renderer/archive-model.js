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

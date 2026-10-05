/** Pure scan correlation and presentation. Filesystem decisions remain in main. */
const statuses = new Set(['running', 'cancelling', 'complete', 'cancelled', 'failed']);

export function isScanActive(task) {
  return task?.status === 'running' || task?.status === 'cancelling';
}

/** Main sequences are global across tasks, including retained reload snapshots. */
export function reduceScanStatus(previous, incoming) {
  if (!incoming || typeof incoming.id !== 'string' || !incoming.id ||
      !statuses.has(incoming.status) || !Number.isSafeInteger(incoming.sequence) || incoming.sequence < 0) return previous;
  if (Number.isSafeInteger(previous?.sequence) && incoming.sequence <= previous.sequence) return previous;
  if (previous?.id === incoming.id && !isScanActive(previous) && isScanActive(incoming)) return previous;
  return { ...incoming };
}

export function canCancelScan(task, capturedId, pending = false) {
  return Boolean(task?.id && task.id === capturedId && task.status === 'running' &&
    task.canCancel !== false && !pending);
}

export function scanPresentation(task, requestPending = false) {
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    visible: Boolean(task || requestPending),
    active: isScanActive(task) || requestPending,
    status: requestPending && !isScanActive(task) ? 'running' : task?.status ?? 'running',
    depth: Number.isInteger(task?.depth) ? task.depth : 6,
    visited: count(task?.visited), candidates: count(task?.candidates), found: count(task?.found),
    skipped: count(task?.skipped), unreadable: count(task?.unreadable), depthLimited: count(task?.depthLimited),
    probeLimited: count(task?.probeLimited),
    // A traversal has no known total. Do not turn visited directories into a percentage.
    indeterminate: isScanActive(task) || requestPending,
    previousLibraryPreserved: task?.status === 'cancelled' || (task?.status === 'failed' && task.saved !== true),
    savedRefreshFailed: task?.status === 'failed' && task.saved === true,
    canCancel: canCancelScan(task, task?.id),
  };
}

export function validScanDepth(value) {
  return Number.isInteger(value) && value >= 0 && value <= 12;
}

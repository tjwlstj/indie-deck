/** Display-only security state. Target selection and scan authority stay in main. */
const engineStates = new Set(['ready', 'stale', 'unavailable']);
const taskKinds = new Set(['scan-game', 'scan-file', 'signature-update']);
const taskStates = new Set(['running', 'complete', 'failed', 'cancelled']);
const verdicts = new Set(['clean', 'attention', 'not-checked']);
const opaque = /^[A-Za-z0-9:_-]{1,100}$/;
const version = /^[0-9A-Za-z.+_-]{1,64}$/;
const reason = /^(?:ui\.security\.[A-Za-z0-9.-]{1,100}|[A-Za-z0-9_-]{1,80})$/;

export function normalizeSecurityResult(value) {
  if (!value || typeof value !== 'object' || !verdicts.has(value.verdict)) return null;
  const result = { verdict: value.verdict };
  if (typeof value.reason === 'string' && reason.test(value.reason)) result.reason = value.reason;
  for (const key of ['signatureVersion', 'engineVersion']) {
    if (typeof value[key] === 'string' && version.test(value[key])) result[key] = value[key];
  }
  for (const key of ['checkedAt', 'startedAt', 'completedAt']) {
    if (typeof value[key] === 'string' && value[key].length < 40 && Number.isFinite(Date.parse(value[key]))) result[key] = value[key];
  }
  if (value.fingerprint && ['file', 'directory'].includes(value.fingerprint.scope) &&
    Number.isSafeInteger(value.fingerprint.files) && value.fingerprint.files >= 0 &&
    Number.isSafeInteger(value.fingerprint.bytes) && value.fingerprint.bytes >= 0) {
    result.fingerprint = { scope: value.fingerprint.scope, files: value.fingerprint.files, bytes: value.fingerprint.bytes };
  }
  for (const key of ['files', 'fileCount', 'bytes']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}

export function normalizeSecuritySnapshot(value) {
  if (!value || typeof value !== 'object' || !('engine' in value) || !('task' in value)) return null;
  let engine = null;
  if (value.engine !== null) {
    if (!value.engine || value.engine.provider !== 'microsoft-defender' || !engineStates.has(value.engine.state)) return null;
    engine = { provider: 'microsoft-defender', state: value.engine.state };
    for (const key of ['signatureVersion', 'engineVersion']) {
      if (typeof value.engine[key] === 'string' && version.test(value.engine[key])) engine[key] = value.engine[key];
    }
    if (Number.isFinite(value.engine.signatureAgeDays) && value.engine.signatureAgeDays >= 0 && value.engine.signatureAgeDays <= 36500) {
      engine.signatureAgeDays = value.engine.signatureAgeDays;
    }
    if (typeof value.engine.realTimeProtectionEnabled === 'boolean') engine.realTimeProtectionEnabled = value.engine.realTimeProtectionEnabled;
    if (typeof value.engine.reason === 'string' && reason.test(value.engine.reason)) engine.reason = value.engine.reason;
  }
  let task = null;
  if (value.task !== null) {
    const source = value.task;
    if (!source || typeof source.id !== 'string' || !opaque.test(source.id) || !Number.isSafeInteger(source.sequence) || source.sequence < 0 ||
      !taskKinds.has(source.kind) || !taskStates.has(source.status)) return null;
    task = { id: source.id, sequence: source.sequence, kind: source.kind, status: source.status };
    if (typeof source.gameId === 'string' && /^[0-9a-f]{16}$/.test(source.gameId)) task.gameId = source.gameId;
    const result = normalizeSecurityResult(source.result);
    if (result) task.result = result;
    if (source.updateResult && ['updated', 'not-updated'].includes(source.updateResult.state)) {
      task.updateResult = { state: source.updateResult.state };
      if (typeof source.updateResult.changed === 'boolean') task.updateResult.changed = source.updateResult.changed;
      if (typeof source.updateResult.reason === 'string' && reason.test(source.updateResult.reason)) task.updateResult.reason = source.updateResult.reason;
    }
    if (typeof source.error === 'string' && /^ui\.security\.[A-Za-z0-9.-]{1,100}$/.test(source.error)) task.error = source.error;
  }
  return { engine, task };
}

export function reduceSecuritySnapshot(previous, incoming) {
  const next = normalizeSecuritySnapshot(incoming);
  if (!next) return previous;
  const oldTask = previous?.task, task = next.task;
  if (oldTask) {
    if (!task || task.sequence < oldTask.sequence) return previous;
    if (task.sequence === oldTask.sequence && (task.id !== oldTask.id ||
      oldTask.status !== 'running' && task.status !== oldTask.status)) return previous;
  }
  return next;
}

export function createSecurityViewState() {
  return { snapshot: null, requestToken: 0, readPending: false, readError: false, action: null };
}

export function beginSecurityRead(view) {
  view.requestToken += 1; view.readPending = true; view.readError = false;
  return view.requestToken;
}

export function applySecuritySnapshot(view, incoming) {
  const next = reduceSecuritySnapshot(view.snapshot, incoming);
  if (!next || next === view.snapshot) return false;
  view.snapshot = next; view.requestToken += 1; view.readPending = false; view.readError = false;
  return true;
}

export function acceptSecurityRead(view, token, incoming) {
  if (token !== view.requestToken) return false;
  view.readPending = false;
  const next = reduceSecuritySnapshot(view.snapshot, incoming);
  if (!next) { view.readError = true; return false; }
  view.snapshot = next; view.readError = false;
  return true;
}

export function failSecurityRead(view, token) {
  if (token !== view.requestToken) return false;
  view.readPending = false; view.readError = true;
  return true;
}

export function isSecurityBusy(snapshot, action) {
  return snapshot?.task?.status === 'running' || action === 'scan-game' || action === 'signature-update';
}

export function canCancelSecurityTask(snapshot, capturedId, action) {
  return Boolean(snapshot?.task?.status === 'running' && snapshot.task.id === capturedId && action !== 'cancel');
}

export function securityPresentation(snapshot, options = {}) {
  const running = snapshot?.task?.status === 'running';
  const blocked = options.mutationBlocked === true || Boolean(options.action);
  const readable = !options.readPending && !options.readError;
  return {
    busy: isSecurityBusy(snapshot, options.action),
    indeterminate: running,
    canRefresh: !blocked && !running && !options.readPending,
    canUpdate: readable && !blocked && !running && ['ready', 'stale'].includes(snapshot?.engine?.state),
    canScan: readable && !blocked && !running && snapshot?.engine?.state === 'ready',
    canCancel: canCancelSecurityTask(snapshot, snapshot?.task?.id, options.action),
  };
}

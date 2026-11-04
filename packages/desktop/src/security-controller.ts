import crypto from 'node:crypto';
import type { createSecurityScanner, SecurityScanResult, SecurityScannerStatus, SecurityUpdateResult } from './security-scanner.ts';

type Scanner = ReturnType<typeof createSecurityScanner>;
export interface SecurityTask {
  id: string; sequence: number; kind: 'scan-game' | 'scan-file' | 'signature-update'; gameId?: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled'; startedAt: string; completedAt?: string;
  result?: SecurityScanResult; updateResult?: Pick<SecurityUpdateResult, 'state' | 'reason' | 'changed'>; error?: string;
}
export interface SecuritySnapshot { engine: SecurityScannerStatus | null; task: SecurityTask | null }
export interface SecurityControllerOptions {
  scanner: Scanner;
  enqueue: (work: () => Promise<void>) => Promise<void>;
  isBusy: () => boolean;
  emit?: (snapshot: SecuritySnapshot) => void;
}

function version(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^\d+(?:\.\d+){1,3}$/.test(value);
}
function validFingerprint(value: SecurityScanResult['fingerprint']): boolean {
  return Boolean(value && ['file', 'directory'].includes(value.scope) && /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.files) && value.files >= 0 && value.files <= 100_000 &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= 100 * 1024 ** 3 &&
    (value.scope !== 'file' || value.files === 1));
}
function readyStatus(value: SecurityScannerStatus): boolean {
  return value?.provider === 'microsoft-defender' && value.state === 'ready' && version(value.engineVersion) && version(value.signatureVersion);
}

/** Main supplies every target. Results never become reusable execution permits. */
export function createSecurityController(options: SecurityControllerOptions) {
  let engine: SecurityScannerStatus | null = null;
  let task: SecurityTask | null = null;
  let abort: AbortController | undefined;
  let sequence = 0;
  let refreshToken = 0;
  const snapshot = (): SecuritySnapshot => structuredClone({ engine, task });
  const publish = () => { try { options.emit?.(snapshot()); } catch { /* observers are not authority */ } };
  const refresh = async (): Promise<SecuritySnapshot> => {
    const token = ++refreshToken;
    let value: SecurityScannerStatus;
    try {
      value = await options.scanner.status();
      if (value.state === 'ready' && !readyStatus(value)) throw new Error('Invalid provider status.');
    } catch { value = { provider: 'microsoft-defender', state: 'unavailable', reason: 'status-error', policy: 'existing-defender-policy' }; }
    if (token === refreshToken) { engine = value; publish(); }
    return snapshot();
  };
  const begin = (kind: SecurityTask['kind'], gameId?: string) => {
    if (task?.status === 'running') throw new Error('ui.security.busy');
    abort = new AbortController();
    task = { id: crypto.randomUUID(), sequence: ++sequence, kind, status: 'running', startedAt: new Date().toISOString(), ...(gameId ? { gameId } : {}) };
    publish();
    return { id: task.id, signal: abort.signal, startedAt: task.startedAt };
  };
  const finish = (id: string, patch: Partial<SecurityTask>) => {
    if (!task || task.id !== id) return;
    task = { ...task, ...patch, completedAt: new Date().toISOString() }; abort = undefined; publish();
  };
  const completeScan = async (active: { id: string; signal: AbortSignal; startedAt: string }, target: string, expectedSha256?: string): Promise<SecurityScanResult> => {
    try {
      let result: SecurityScanResult = active.signal.aborted
        ? { provider: 'microsoft-defender', verdict: 'not-checked', reason: 'cancelled', startedAt: active.startedAt, completedAt: new Date().toISOString() }
        : await options.scanner.scanTarget(target, { signal: active.signal });
      if (active.signal.aborted) result = { ...result, verdict: 'not-checked', reason: 'cancelled', fingerprint: undefined };
      else if (result.verdict === 'clean' && (result.provider !== 'microsoft-defender' || !validFingerprint(result.fingerprint) || !version(result.engineVersion) || !version(result.signatureVersion))) {
        result = { provider: 'microsoft-defender', verdict: 'not-checked', reason: 'engine-error', startedAt: active.startedAt, completedAt: new Date().toISOString() };
      }
      if (result.verdict === 'clean' && expectedSha256 && result.fingerprint?.sha256 !== expectedSha256) {
        result = { ...result, verdict: 'not-checked', reason: 'target-changed', fingerprint: undefined };
      }
      if (result.verdict === 'clean') {
        ++refreshToken;
        engine = { provider: 'microsoft-defender', state: 'ready', policy: 'existing-defender-policy',
          engineVersion: result.engineVersion, signatureVersion: result.signatureVersion };
      }
      finish(active.id, { status: result.reason === 'cancelled' ? 'cancelled' : result.verdict === 'clean' ? 'complete' : 'failed', result });
      return result;
    } catch {
      const result: SecurityScanResult = { provider: 'microsoft-defender', verdict: 'not-checked', reason: active.signal.aborted ? 'cancelled' : 'engine-error',
        startedAt: active.startedAt, completedAt: new Date().toISOString() };
      finish(active.id, { status: active.signal.aborted ? 'cancelled' : 'failed', result });
      return result;
    }
  };
  const enqueueTask = (id: string, work: () => Promise<void>) => {
    try { void options.enqueue(work).catch(() => finish(id, { status: 'failed', error: 'ui.security.actionFailed' })); }
    catch { finish(id, { status: 'failed', error: 'ui.security.actionFailed' }); throw new Error('ui.security.actionFailed'); }
  };
  const startGameScan = (gameId: string, target: string): SecuritySnapshot => {
    // The enqueue contract reserves its mutation slot synchronously; begin is
    // called immediately so a renderer receives a running task in the handshake.
    if (options.isBusy() || task?.status === 'running') throw new Error('ui.security.busy');
    const active = begin('scan-game', gameId);
    enqueueTask(active.id, async () => { await completeScan(active, target); });
    return snapshot();
  };
  const startUpdate = (): SecuritySnapshot => {
    if (options.isBusy() || task?.status === 'running') throw new Error('ui.security.busy');
    const active = begin('signature-update');
    enqueueTask(active.id, async () => {
      try {
        if (active.signal.aborted) {
          finish(active.id, { status: 'cancelled', updateResult: { state: 'not-updated', reason: 'cancelled' } }); return;
        }
        const update = await options.scanner.updateSignatures({ signal: active.signal });
        ++refreshToken; engine = update.status;
        if (active.signal.aborted || update.reason === 'cancelled') {
          finish(active.id, { status: 'cancelled', updateResult: { state: 'not-updated', reason: 'cancelled' } }); return;
        }
        if (update.state === 'updated' && !readyStatus(update.status)) {
          engine = { provider: 'microsoft-defender', state: 'unavailable', reason: 'status-error', policy: 'existing-defender-policy' };
          finish(active.id, { status: 'failed', error: 'ui.security.updateFailed', updateResult: { state: 'not-updated', reason: 'status-error' } }); return;
        }
        finish(active.id, { status: update.state === 'updated' ? 'complete' : 'failed',
          updateResult: { state: update.state, reason: update.reason, changed: update.changed }, ...(update.state === 'not-updated' ? { error: 'ui.security.updateFailed' } : {}) });
      } catch { finish(active.id, { status: active.signal.aborted ? 'cancelled' : 'failed', error: 'ui.security.updateFailed' }); }
    });
    return snapshot();
  };
  return {
    current: snapshot, refresh, startGameScan, startUpdate,
    cancel: (id: unknown) => { if (task?.status === 'running' && task.id === id) abort?.abort(); return snapshot(); },
    scanBeforeUse: async (target: string, gameId?: string, expectedSha256?: string): Promise<SecurityScanResult> => {
      const active = begin('scan-file', gameId);
      const result = await completeScan(active, target, expectedSha256);
      if (expectedSha256 && result.reason === 'target-changed') throw new Error('ui.security.block.changed');
      if (result.verdict !== 'clean') throw new Error(result.verdict === 'attention' ? 'ui.security.block.attention' : 'ui.security.block.notChecked');
      return result;
    },
    scanStage: async (target: string): Promise<void> => {
      const result = await completeScan(begin('scan-game'), target);
      if (result.verdict !== 'clean') throw new Error(result.verdict === 'attention' ? 'ui.security.block.attention' : 'ui.security.block.notChecked');
    },
  };
}

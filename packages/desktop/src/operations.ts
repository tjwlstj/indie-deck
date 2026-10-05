import crypto from 'node:crypto';

export type OperationKind = 'install' | 'uninstall';
export type OperationPhase =
  | 'queued' | 'preflight' | 'download' | 'verify' | 'backup' | 'extract'
  | 'configure' | 'manual' | 'receipt' | 'rollback' | 'redetect' | 'audit';

export interface OperationRequest {
  requestId: string;
  gameId: string;
  kind: OperationKind;
  planId?: string;
}

export interface OperationProgress extends OperationRequest {
  operationId: string;
  sequence: number;
  phase: OperationPhase;
  stepIndex: number;
  stepCount: number;
  description?: string;
  descriptionKey?: string;
  descriptionParams?: Record<string, string | number | undefined>;
  assetId?: string;
  received?: number;
  total?: number;
  fromCache?: boolean;
  status?: 'started' | 'progress' | 'completed' | 'skipped' | 'pending-user' | 'failed';
  integrity?: 'verified' | 'unverified' | 'mismatch';
  detail?: string;
  log?: string;
}

export interface OperationSnapshot extends OperationProgress {
  logs: string[];
}

export interface OperationResult {
  status: 'success' | 'needs-user-action' | 'failed';
  mutationStatus: 'committed' | 'rolled-back' | 'partial';
  rollbackStatus: 'complete' | 'partial' | 'not-run';
  rollbackFailures: { path: string; error: string }[];
  result?: unknown;
  error?: string;
  refreshStatus: 'complete' | 'failed';
  refreshError?: string;
  postState?: unknown;
}

export interface OperationOutcome extends OperationRequest, OperationResult {
  operationId: string;
  sequence: number;
  logs: string[];
}

export type ProgressUpdate = Partial<Omit<OperationProgress, keyof OperationRequest | 'operationId' | 'sequence'>>;
type Reporter = (update: ProgressUpdate) => void;

/** In-memory operation lifetime, independent of Electron and the file writer.
 * A renderer reload can recover the last snapshot and every unacknowledged
 * outcome. This deliberately does not claim recovery after an app/OS crash. */
export class OperationManager {
  private active: OperationSnapshot | null = null;
  private readonly outcomes = new Map<string, OperationOutcome>();
  private readonly hooks: {
    enqueue: (work: () => Promise<void>) => void;
    progress: (event: OperationProgress) => void;
    outcome: (event: OperationOutcome) => void;
  };

  constructor(hooks: OperationManager['hooks']) { this.hooks = hooks; }

  start(request: OperationRequest, run: (report: Reporter) => Promise<OperationResult>) {
    if (this.active) throw new Error('Another file operation is already running.');
    // Preserve every result until ACK, and apply backpressure rather than
    // silently evicting the only recoverable final state of an older operation.
    if (this.outcomes.size >= 10) throw new Error('Reload the launcher to acknowledge pending operation results before starting another task.');
    if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.requestId)) {
      throw new Error('Malformed operation request id.');
    }
    if (request.kind !== 'install' && request.kind !== 'uninstall') throw new Error('Unknown operation kind.');
    if (!/^[0-9a-f]{16}$/.test(request.gameId)) throw new Error('Malformed game id.');

    const operationId = crypto.randomUUID();
    const snapshot: OperationSnapshot = {
      ...request, operationId, sequence: 0, phase: 'queued', stepIndex: 0, stepCount: 0, logs: [],
    };
    this.active = snapshot;
    const report: Reporter = (update) => {
      if (this.active !== snapshot) return;
      if (update.phase && update.phase !== snapshot.phase) {
        delete snapshot.received;
        delete snapshot.total;
        delete snapshot.fromCache;
        delete snapshot.assetId;
        delete snapshot.status;
        delete snapshot.integrity;
        delete snapshot.detail;
        delete snapshot.description;
        delete snapshot.descriptionKey;
        delete snapshot.descriptionParams;
      }
      delete snapshot.log;
      Object.assign(snapshot, update);
      snapshot.sequence += 1;
      if (update.log) {
        snapshot.logs.push(update.log);
        // Logs are supplemental UI data; avoid unbounded memory during a long
        // install. The final result still contains all performed plan steps.
        if (snapshot.logs.length > 500) snapshot.logs.shift();
      }
      const { logs: _logs, ...event } = snapshot;
      this.hooks.progress(structuredClone(event));
    };
    report({ phase: 'queued' });

    this.hooks.enqueue(async () => {
      let result: OperationResult;
      try {
        result = await run(report);
      } catch (err) {
        // All expected filesystem errors are normalised by the caller. This
        // last boundary still publishes exactly one terminal result if the
        // operation runner itself fails unexpectedly.
        result = {
          status: 'failed', mutationStatus: 'partial', rollbackStatus: 'not-run', rollbackFailures: [],
          error: err instanceof Error ? err.message : String(err),
          refreshStatus: 'failed', refreshError: 'The final game state could not be read.',
        };
      }
      const outcome: OperationOutcome = {
        ...request, operationId, sequence: snapshot.sequence + 1, logs: [...snapshot.logs], ...result,
      };
      this.outcomes.set(operationId, outcome);
      this.active = null;
      this.hooks.outcome(structuredClone(outcome));
    });
    return { requestId: request.requestId, operationId, gameId: request.gameId };
  }

  isActive(): boolean { return this.active !== null; }

  current(): { active: OperationSnapshot | null; outcomes: OperationOutcome[] } {
    return structuredClone({ active: this.active, outcomes: [...this.outcomes.values()] });
  }

  outcome(operationId: string): OperationOutcome | null {
    return structuredClone(this.outcomes.get(operationId) ?? null);
  }

  acknowledge(operationId: string): boolean { return this.outcomes.delete(operationId); }
}

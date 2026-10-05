import crypto from 'node:crypto';
import type { ScanProgress } from '@indiedeck/core';

export interface LibraryScanTask extends ScanProgress {
  id: string;
  /** Monotonic across tasks as well as within one task, for reload recovery. */
  sequence: number;
  status: 'running' | 'cancelling' | 'complete' | 'cancelled' | 'failed';
  canCancel: boolean;
  error?: string;
  /** A post-save display/audit failure must not claim the old index was kept. */
  saved?: boolean;
  result?: unknown;
}

/** Main-owned task state. Only an opaque task id can request cancellation. */
export class LibraryScanController {
  private state: LibraryScanTask | null = null;
  private abort: AbortController | null = null;
  private sequence = 0;
  private lastSentAt = 0;
  private readonly publish: (task: LibraryScanTask) => void;

  constructor(publish: (task: LibraryScanTask) => void) { this.publish = publish; }

  snapshot(): LibraryScanTask | null { return this.state ? structuredClone(this.state) : null; }

  private send(force = false): void {
    if (!this.state) return;
    this.state.sequence = ++this.sequence;
    const now = Date.now();
    if (!force && now - this.lastSentAt < 100) return;
    this.lastSentAt = now;
    this.publish(this.snapshot()!);
  }

  start(depth: number): AbortSignal {
    if (this.state?.status === 'running' || this.state?.status === 'cancelling') throw new Error('ui.operation.busy');
    this.abort = new AbortController();
    this.state = { id: crypto.randomUUID(), sequence: 0, status: 'running', canCancel: true,
      depth, visited: 0, candidates: 0, found: 0, skipped: 0, unreadable: 0, depthLimited: 0, current: '' };
    this.send(true);
    return this.abort.signal;
  }

  progress(progress: ScanProgress): void {
    if (!this.state || this.state.status !== 'running') return;
    Object.assign(this.state, progress);
    this.send();
  }

  cancel(id: unknown): boolean {
    if (typeof id !== 'string' || !this.state || id !== this.state.id ||
      this.state.status !== 'running' || !this.state.canCancel) return false;
    this.state.status = 'cancelling';
    this.state.canCancel = false;
    this.abort!.abort();
    this.send(true);
    return true;
  }

  /** Saving is atomic but cannot be interrupted after commit starts. This
   * synchronous transition closes the late-cancel/persist race. */
  commit(): void {
    if (!this.state || this.state.status !== 'running' || this.abort?.signal.aborted) {
      throw new Error('ui.scan.cancelled');
    }
    this.state.canCancel = false;
    this.send(true);
  }

  finish(status: 'complete' | 'cancelled' | 'failed', options: { result?: unknown; error?: string; saved?: boolean } = {}): void {
    if (!this.state || (this.state.status !== 'running' && this.state.status !== 'cancelling')) return;
    Object.assign(this.state, options, { status, canCancel: false });
    this.send(true);
    this.abort = null;
  }
}

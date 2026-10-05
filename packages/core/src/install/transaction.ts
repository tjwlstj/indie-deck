import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ReceiptEntry } from '../types.ts';
import { ensureDir, pathExists } from '../util/fsx.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import { extractZip, type ExtractOptions } from './unzip.ts';

/**
 * Every write into a game folder goes through here.
 *
 * The rule that makes uninstall safe is that a write is either a `create` (the
 * file did not exist, so removing it restores the folder) or a `modify` (it did
 * exist, so a copy is taken first and removing it means putting that copy back).
 * Deleting a file we merely overwrote - a game's own plugins.js, a file another
 * mod owns - destroys data that was never ours.
 *
 * If anything throws mid-install, `rollback()` walks the journal backwards and
 * puts the folder back exactly as it was.
 */

export interface TransactionOptions {
  /** Root that every relative path is resolved against - the game folder. */
  root: string;
  /** Where displaced originals are copied to, relative to root. */
  backupDir: string;
  logger?: Logger;
  dryRun?: boolean;
}

export interface RollbackFailure {
  /** Game-root-relative path from the transaction journal. */
  path: string;
  operation: ReceiptEntry['operation'];
  error: string;
}

export interface RollbackResult {
  /** `complete` means every journal entry was reversed without an I/O error. */
  status: 'complete' | 'partial' | 'not-run';
  attempted: number;
  completed: number;
  failures: RollbackFailure[];
}

function hash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function hashFile(file: string): Promise<string> {
  return hash(await fsp.readFile(file));
}

async function lstatIfExists(file: string): Promise<Awaited<ReturnType<typeof fsp.lstat>> | undefined> {
  try {
    return await fsp.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export class FileTransaction {
  readonly root: string;
  private readonly backupDir: string;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  private readonly journal: ReceiptEntry[] = [];
  /**
   * One backup per path per transaction. A second write to the same file must
   * not overwrite the pristine copy with the installer's own intermediate
   * content - the backup has to stay the state the folder was in before we
   * touched it.
   */
  private readonly backups = new Map<string, string>();
  private readonly stamp: string;
  private committed = false;

  constructor(options: TransactionOptions) {
    this.root = path.resolve(options.root);
    this.backupDir = options.backupDir;
    this.log = options.logger ?? silentLogger;
    this.dryRun = options.dryRun ?? false;
    this.stamp = new Date().toISOString().replace(/[:.]/g, '-');
  }

  get entries(): ReceiptEntry[] {
    return [...this.journal];
  }

  private abs(rel: string): string {
    const target = path.resolve(this.root, rel);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error(`Refusing to touch a path outside the game folder: ${rel}`);
    }
    return target;
  }

  /** Copies an existing file aside once and returns the backup's relative path. */
  private async backup(rel: string): Promise<string> {
    const key = rel.replace(/\\/g, '/').toLowerCase();
    const existing = this.backups.get(key);
    if (existing) return existing;

    const source = this.abs(rel);
    const backupRel = path.join(this.backupDir, this.stamp, rel);
    const dest = this.abs(backupRel);
    await ensureDir(path.dirname(dest));
    await fsp.cp(source, dest, { recursive: true });

    const normalised = backupRel.replace(/\\/g, '/');
    this.backups.set(key, normalised);
    return normalised;
  }

  /** Writes a file, recording whether it displaced an existing one. */
  async write(rel: string, data: Buffer | string): Promise<ReceiptEntry> {
    const normalised = rel.replace(/\\/g, '/');
    const target = this.abs(normalised);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const existed = await pathExists(target);

    const entry: ReceiptEntry = {
      path: normalised,
      operation: existed ? 'modify' : 'create',
      sha256: hash(buffer),
    };
    if (this.dryRun) {
      this.journal.push(entry);
      return entry;
    }

    if (existed) entry.backup = await this.backup(normalised);
    // Journal before the first target mutation. A short/failed write must still
    // be removable (or restorable from the backup) by rollback().
    this.journal.push(entry);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, buffer);
    return entry;
  }

  /**
   * Read-modify-write of an existing text file. The original is backed up, so a
   * later uninstall restores it verbatim rather than deleting a file the game
   * shipped.
   */
  async patch(rel: string, transform: (current: string) => string, encoding: BufferEncoding = 'utf8'): Promise<ReceiptEntry | undefined> {
    const target = this.abs(rel);
    if (!(await pathExists(target))) return undefined;
    const current = await fsp.readFile(target, encoding);
    const updated = transform(current);
    if (updated === current) return undefined;
    return this.write(rel, Buffer.from(updated, encoding));
  }

  /**
   * Extracts an archive into `destRel`. The file list is resolved first so that
   * anything already on disk is backed up before a single byte is written.
   */
  async extract(archivePath: string, destRel: string, options: ExtractOptions = {}): Promise<ReceiptEntry[]> {
    const destAbs = this.abs(destRel === '.' ? '' : destRel);
    const preview = await extractZip(archivePath, destAbs, { ...options, dryRun: true });

    const written: ReceiptEntry[] = [];
    if (this.dryRun) {
      for (const file of preview.files) {
        const rel = path.relative(this.root, path.join(destAbs, file)).replace(/\\/g, '/');
        const entry: ReceiptEntry = { path: rel, operation: (await pathExists(this.abs(rel))) ? 'modify' : 'create' };
        this.journal.push(entry);
        written.push(entry);
      }
      return written;
    }

    // Back up and journal every previewed target before extraction. If the
    // extractor stops halfway through, rollback still knows every path that
    // may have been created or displaced.
    for (const file of preview.files) {
      const rel = path.relative(this.root, path.join(destAbs, file)).replace(/\\/g, '/');
      const existed = await pathExists(this.abs(rel));
      const entry: ReceiptEntry = { path: rel, operation: existed ? 'modify' : 'create' };
      if (existed) entry.backup = await this.backup(rel);
      this.journal.push(entry);
      written.push(entry);
    }

    await extractZip(archivePath, destAbs, options);
    for (const entry of written) {
      // A v2 create/modify receipt without a post-write hash cannot safely
      // distinguish our payload from a later user edit. Hash failure therefore
      // fails the transaction instead of emitting unusable removal evidence.
      entry.sha256 = await hashFile(this.abs(entry.path));
    }
    return written;
  }

  /** Copies one regular file from outside the game folder into it. */
  async copyIn(sourceAbs: string, destRel: string): Promise<ReceiptEntry> {
    const normalised = destRel.replace(/\\/g, '/');
    const target = this.abs(normalised);
    const sourceStat = await fsp.lstat(sourceAbs);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error('copyIn only supports regular files; directory copies require per-file receipt entries.');
    }
    const targetStat = await lstatIfExists(target);
    if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
      throw new Error(`copyIn destination is not a regular file: ${normalised}`);
    }
    const entry: ReceiptEntry = {
      path: normalised,
      operation: targetStat ? 'modify' : 'create',
      sha256: await hashFile(sourceAbs),
    };

    if (this.dryRun) {
      this.journal.push(entry);
      return entry;
    }
    if (targetStat) entry.backup = await this.backup(normalised);
    // Record the target before copyFile so a partial copy or post-copy hash
    // failure remains rollback-visible.
    this.journal.push(entry);
    await ensureDir(path.dirname(target));
    await fsp.copyFile(sourceAbs, target);
    entry.sha256 = await hashFile(target);
    return entry;
  }

  /** Snapshots a path without changing it - used before running a patcher. */
  async snapshot(rel: string): Promise<ReceiptEntry | undefined> {
    const target = this.abs(rel);
    if (!(await pathExists(target))) return undefined;
    if (this.dryRun) return { path: rel, operation: 'modify' };
    const entry: ReceiptEntry = { path: rel.replace(/\\/g, '/'), operation: 'snapshot', backup: await this.backup(rel) };
    this.journal.push(entry);
    return entry;
  }

  commit(): ReceiptEntry[] {
    this.committed = true;
    return this.entries;
  }

  /** Undoes everything this transaction did, newest first, and reports gaps. */
  async rollback(): Promise<RollbackResult> {
    if (this.dryRun || this.committed) {
      return { status: 'not-run', attempted: 0, completed: 0, failures: [] };
    }
    const failures: RollbackFailure[] = [];
    let completed = 0;
    const attempted = this.journal.length;
    for (const entry of [...this.journal].reverse()) {
      try {
        if (entry.operation === 'create') {
          await fsp.rm(this.abs(entry.path), { recursive: true, force: true });
        } else if (!entry.backup) {
          throw new Error('No backup was recorded for this journal entry.');
        } else {
          const from = this.abs(entry.backup);
          if (!(await pathExists(from))) throw new Error(`Backup is missing: ${entry.backup}`);
          await ensureDir(path.dirname(this.abs(entry.path)));
          await fsp.cp(from, this.abs(entry.path), { recursive: true });
        }
        completed += 1;
      } catch (err) {
        const error = (err as Error).message;
        failures.push({ path: entry.path, operation: entry.operation, error });
        this.log.warn(`rollback could not restore ${entry.path}: ${error}`);
      }
    }
    this.journal.length = 0;
    this.backups.clear();
    return {
      status: failures.length === 0 ? 'complete' : 'partial',
      attempted,
      completed,
      failures,
    };
  }
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export async function withTransaction<T>(
  options: TransactionOptions,
  fn: (tx: FileTransaction) => Promise<T>,
): Promise<{ result: T; entries: ReceiptEntry[] }> {
  const tx = new FileTransaction(options);
  try {
    const result = await fn(tx);
    return { result, entries: tx.commit() };
  } catch (err) {
    const rollbackResult = await tx.rollback();
    throw Object.assign(err as Error, { rollbackResult });
  }
}

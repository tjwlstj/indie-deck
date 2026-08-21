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

function hash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
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
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, buffer);
    this.journal.push(entry);
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

    // Back up everything the archive is about to land on, before extracting.
    const displaced = new Map<string, string>();
    for (const file of preview.files) {
      const rel = path.relative(this.root, path.join(destAbs, file)).replace(/\\/g, '/');
      if (await pathExists(this.abs(rel))) displaced.set(rel, await this.backup(rel));
    }

    const result = await extractZip(archivePath, destAbs, options);
    for (const file of result.files) {
      const rel = path.relative(this.root, path.join(destAbs, file)).replace(/\\/g, '/');
      const backup = displaced.get(rel);
      const entry: ReceiptEntry = { path: rel, operation: backup ? 'modify' : 'create' };
      if (backup) entry.backup = backup;
      try {
        entry.sha256 = hash(await fsp.readFile(this.abs(rel)));
      } catch {
        /* unreadable right after writing - skip the hash rather than fail */
      }
      this.journal.push(entry);
      written.push(entry);
    }
    return written;
  }

  /** Copies a file or directory from outside the game folder into it. */
  async copyIn(sourceAbs: string, destRel: string): Promise<ReceiptEntry> {
    const normalised = destRel.replace(/\\/g, '/');
    const target = this.abs(normalised);
    const existed = await pathExists(target);
    const entry: ReceiptEntry = { path: normalised, operation: existed ? 'modify' : 'create' };

    if (this.dryRun) {
      this.journal.push(entry);
      return entry;
    }
    if (existed) entry.backup = await this.backup(normalised);
    await ensureDir(path.dirname(target));
    await fsp.cp(sourceAbs, target, { recursive: true });
    this.journal.push(entry);
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

  /** Undoes everything this transaction did, newest first. */
  async rollback(): Promise<void> {
    if (this.dryRun || this.committed) return;
    for (const entry of [...this.journal].reverse()) {
      try {
        if (entry.operation === 'create') {
          await fsp.rm(this.abs(entry.path), { recursive: true, force: true });
        } else if (entry.backup) {
          const from = this.abs(entry.backup);
          if (await pathExists(from)) {
            await ensureDir(path.dirname(this.abs(entry.path)));
            await fsp.cp(from, this.abs(entry.path), { recursive: true });
          }
        }
      } catch (err) {
        this.log.warn(`rollback could not restore ${entry.path}: ${(err as Error).message}`);
      }
    }
    this.journal.length = 0;
    this.backups.clear();
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
    await tx.rollback();
    throw err;
  }
}

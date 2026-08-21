import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { InstallReceipt, PlanStep, ReceiptEntry, TranslatorPlan } from '../types.ts';
import { ensureDir, pathExists } from '../util/fsx.ts';
import { applyIni } from '../util/ini.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import { defaultCacheDir, defaultToolsDir, downloadAsset, type DownloadOptions } from './download.ts';
import { extract7z, findExtractedEntry } from './sevenzip.ts';
import { FileTransaction } from './transaction.ts';

export const RECEIPT_DIR = '.indiedeck/receipts';
export const BACKUP_DIR = '.indiedeck/backups';

export interface ApplyOptions extends DownloadOptions {
  /** Print what would happen without touching the game folder. */
  dryRun?: boolean;
  /**
   * Allow IndieDeck to execute installer/patcher executables (ReiPatcher).
   * Off by default: those rewrite game assemblies in place.
   */
  allowRun?: boolean;
  toolsDir?: string;
  logger?: Logger;
}

export interface ApplyResult {
  receipts: InstallReceipt[];
  performed: { step: PlanStep; status: 'done' | 'skipped' | 'pending-user'; detail?: string }[];
  filesWritten: string[];
  pendingUserActions: string[];
  /** Set when the install failed and the folder was rolled back. */
  rolledBack?: { failedStep: string; error: string };
}

function resolveDest(gameRoot: string, dest: string | undefined, toolsDir: string): { abs: string; insideGame: boolean } {
  if (!dest || dest === '.') return { abs: gameRoot, insideGame: true };
  if (dest.startsWith('$toolsDir')) {
    return { abs: path.join(toolsDir, dest.replace('$toolsDir', '').replace(/^[\\/]/, '')), insideGame: false };
  }
  return { abs: path.join(gameRoot, dest), insideGame: true };
}

/**
 * Executes a resolved plan inside a single file transaction.
 *
 * Nothing is written without first recording whether it displaced an existing
 * file, and any failure rolls the whole thing back. Downloads are cached and
 * content-hashed; anything that would run a third-party executable stops and
 * asks unless `allowRun` is set.
 */
export async function applyPlan(plan: TranslatorPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const log = options.logger ?? silentLogger;
  const gameRoot = plan.gamePath;
  const toolsDir = options.toolsDir ?? defaultToolsDir();
  const result: ApplyResult = { receipts: [], performed: [], filesWritten: [], pendingUserActions: [] };

  const tx = new FileTransaction({
    root: gameRoot,
    backupDir: BACKUP_DIR,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    logger: log,
  });

  let lastDownload: { path: string; name: string } | undefined;
  const loaderEntries: ReceiptEntry[] = [];
  const translatorEntries: ReceiptEntry[] = [];
  let phase: 'loader' | 'translator' = plan.loader && !plan.loader.alreadyInstalled ? 'loader' : 'translator';
  const collect = (entries: ReceiptEntry[]): void => {
    (phase === 'loader' ? loaderEntries : translatorEntries).push(...entries);
    result.filesWritten.push(...entries.filter((e) => e.operation !== 'snapshot').map((e) => e.path));
  };

  try {
    for (const step of plan.steps) {
      switch (step.action) {
        case 'backup': {
          if (options.dryRun) {
            result.performed.push({ step, status: 'skipped', detail: 'dry run' });
            break;
          }
          const entry = await tx.snapshot(step.dest ?? '.');
          if (entry) translatorEntries.push(entry);
          result.performed.push({
            step,
            status: entry ? 'done' : 'skipped',
            detail: entry?.backup ?? 'nothing to back up',
          });
          break;
        }

        case 'download': {
          if (!step.source) {
            result.performed.push({ step, status: 'skipped', detail: 'no source' });
            break;
          }
          if (options.dryRun) {
            result.performed.push({ step, status: 'skipped', detail: 'dry run' });
            break;
          }
          const dl = await downloadAsset(step.source, { ...options, logger: log });
          lastDownload = { path: dl.path, name: path.basename(dl.path) };
          result.performed.push({
            step,
            status: 'done',
            detail:
              `${(dl.bytes / 1048576).toFixed(1)} MB${dl.fromCache ? ' (cached)' : ''} sha256=${dl.sha256.slice(0, 12)}` +
              (dl.integrity === 'verified' ? ' [verified]' : dl.integrity === 'mismatch' ? ' [MISMATCH]' : ''),
          });
          break;
        }

        case 'extract': {
          if (!lastDownload) {
            result.performed.push({ step, status: 'skipped', detail: 'nothing downloaded to extract' });
            break;
          }
          const dest = resolveDest(gameRoot, step.dest, toolsDir);

          if (!lastDownload.path.toLowerCase().endsWith('.zip')) {
            result.pendingUserActions.push(
              `${lastDownload.name} is not a ZIP archive - extract it manually into ${step.dest ?? '.'} (downloaded to ${lastDownload.path}).`,
            );
            result.performed.push({ step, status: 'pending-user', detail: 'non-zip archive' });
            break;
          }

          // Tool installs land outside the game folder, so they are not part of
          // the game's transaction and never appear in its receipt.
          if (!dest.insideGame) {
            if (options.dryRun) {
              result.performed.push({ step, status: 'skipped', detail: 'dry run' });
              break;
            }
            const { extractZip } = await import('./unzip.ts');
            await ensureDir(dest.abs);
            const extracted = await extractZip(lastDownload.path, dest.abs);
            result.performed.push({ step, status: 'done', detail: `${extracted.files.length} files -> ${dest.abs}` });
            break;
          }

          const relDest = step.dest && step.dest !== '.' ? step.dest : '.';
          const entries = await tx.extract(lastDownload.path, relDest);
          collect(entries);
          if (phase === 'loader') phase = 'translator';
          result.performed.push({
            step,
            status: options.dryRun ? 'skipped' : 'done',
            detail: `${entries.length} files${entries.some((e) => e.operation === 'modify') ? `, ${entries.filter((e) => e.operation === 'modify').length} displaced (backed up)` : ''}`,
          });
          break;
        }

        case 'copy': {
          if (!lastDownload || !step.dest) {
            result.performed.push({ step, status: 'skipped', detail: 'nothing downloaded to copy' });
            break;
          }
          if (options.dryRun) {
            result.performed.push({ step, status: 'skipped', detail: 'dry run' });
            break;
          }
          try {
            const extracted = await extract7z(lastDownload.path, options.cacheDir ?? defaultCacheDir());
            const source = await findExtractedEntry(extracted.dir, step.dest);
            if (!source) throw new Error(`${step.dest} not found inside ${lastDownload.name}`);
            const entry = await tx.copyIn(source, step.dest);
            collect([entry]);
            result.performed.push({
              step,
              status: 'done',
              detail: `via ${extracted.extractor}${extracted.fromCache ? ' (cached)' : ''}`,
            });
          } catch (err) {
            result.pendingUserActions.push(
              `Extract ${step.dest} from ${lastDownload.path} into the game folder manually - ${(err as Error).message}`,
            );
            result.performed.push({ step, status: 'pending-user', detail: '7z extraction unavailable' });
          }
          break;
        }

        case 'run': {
          const exe = String(step.details?.['exe'] ?? '');
          if (!options.allowRun || options.dryRun) {
            result.pendingUserActions.push(`Run ${exe} in ${gameRoot}, then launch the game once through the generated shortcut.`);
            result.performed.push({ step, status: 'pending-user', detail: 'requires --allow-run' });
            break;
          }
          const exePath = path.join(gameRoot, exe);
          if (!(await pathExists(exePath))) {
            result.performed.push({ step, status: 'skipped', detail: `${exe} not found` });
            break;
          }
          const code = await runProcess(exePath, gameRoot);
          result.performed.push({ step, status: code === 0 ? 'done' : 'skipped', detail: `exit ${code}` });
          break;
        }

        case 'config': {
          if (!step.dest || Object.keys(plan.config).length === 0) {
            result.performed.push({ step, status: 'skipped', detail: 'nothing to write' });
            break;
          }
          if (options.dryRun) {
            result.performed.push({ step, status: 'skipped', detail: 'dry run' });
            break;
          }
          const configPath = path.join(gameRoot, step.dest);
          const existing = (await pathExists(configPath)) ? await fsp.readFile(configPath, 'utf8') : '';
          const entry = await tx.write(step.dest, applyIni(existing, plan.config));
          collect([entry]);
          result.performed.push({ step, status: 'done', detail: Object.keys(plan.config).join(', ') });
          break;
        }

        case 'manual':
        default: {
          result.pendingUserActions.push(step.description);
          result.performed.push({ step, status: 'pending-user' });
          break;
        }
      }
    }
  } catch (err) {
    const failed = result.performed.at(-1)?.step.description ?? 'install';
    log.error(`Install failed during "${failed}" - rolling back`);
    await tx.rollback();
    result.rolledBack = { failedStep: failed, error: (err as Error).message };
    result.filesWritten = [];
    throw Object.assign(err as Error, { applyResult: result });
  }

  tx.commit();

  if (!options.dryRun) {
    if (plan.loader && !plan.loader.alreadyInstalled && loaderEntries.length > 0) {
      result.receipts.push(
        await writeReceipt(gameRoot, {
          kind: 'loader',
          componentId: plan.loader.loaderId,
          version: plan.loader.version,
          entries: loaderEntries,
        }),
      );
    }
    if (translatorEntries.length > 0) {
      result.receipts.push(
        await writeReceipt(gameRoot, {
          kind: 'translator',
          componentId: plan.translatorId,
          variantId: plan.variantId,
          version: plan.version,
          entries: translatorEntries,
          planFindings: plan.findings,
        }),
      );
    }
  }

  return result;
}

function runProcess(exe: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(exe, { cwd, stdio: 'inherit', windowsHide: false });
    child.on('close', (code) => resolve(code ?? -1));
    child.on('error', () => resolve(-1));
  });
}

export async function writeReceipt(
  gameRoot: string,
  data: Omit<InstallReceipt, 'id' | 'gamePath' | 'installedAt' | 'schemaVersion'>,
): Promise<InstallReceipt> {
  const receipt: InstallReceipt = {
    id: crypto.randomUUID(),
    schemaVersion: 2,
    gamePath: gameRoot,
    installedAt: new Date().toISOString(),
    ...data,
  };
  const dir = path.join(gameRoot, RECEIPT_DIR);
  await ensureDir(dir);
  await fsp.writeFile(
    path.join(dir, `${receipt.kind}-${receipt.componentId}.json`),
    JSON.stringify(receipt, null, 2),
    'utf8',
  );
  return receipt;
}

/** Reads a receipt of either schema version into the current shape. */
export function normaliseReceipt(raw: InstallReceipt): InstallReceipt {
  if (Array.isArray(raw.entries) && raw.entries.length > 0) return raw;

  // schemaVersion 1: a flat file list plus a separate backup list. Files that
  // have a matching backup were modifications, everything else was a creation.
  const backups = new Map((raw.backups ?? []).map((b) => [b.original.replace(/\\/g, '/'), b.backup]));
  const entries: ReceiptEntry[] = (raw.files ?? []).map((file) => {
    const normalised = file.replace(/\\/g, '/');
    const backup = backups.get(normalised);
    const entry: ReceiptEntry = { path: normalised, operation: backup ? 'modify' : 'create' };
    if (backup) entry.backup = backup;
    return entry;
  });
  for (const [original, backup] of backups) {
    if (!entries.some((e) => e.path === original)) entries.push({ path: original, operation: 'snapshot', backup });
  }
  return { ...raw, schemaVersion: 1, entries };
}

export async function readReceipts(gameRoot: string): Promise<InstallReceipt[]> {
  const dir = path.join(gameRoot, RECEIPT_DIR);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: InstallReceipt[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      out.push(normaliseReceipt(JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as InstallReceipt));
    } catch {
      /* skip unreadable receipt */
    }
  }
  return out;
}

export interface UninstallResult {
  removed: string[];
  restored: string[];
  missing: string[];
  /** Files left alone because they changed after IndieDeck wrote them. */
  keptModified: string[];
}

export interface UninstallOptions {
  dryRun?: boolean;
  /** Remove files even when they no longer match what IndieDeck wrote. */
  force?: boolean;
  logger?: Logger;
}

/**
 * Reverses one receipt: files IndieDeck created are removed, files it merely
 * displaced are restored from their backup. A file that was hand-edited after
 * the install is left alone unless `force` is set - the folder belongs to the
 * user, not to the installer.
 */
export async function uninstallReceipt(receipt: InstallReceipt, options: UninstallOptions = {}): Promise<UninstallResult> {
  const log = options.logger ?? silentLogger;
  const result: UninstallResult = { removed: [], restored: [], missing: [], keptModified: [] };
  const root = receipt.gamePath;
  const normalised = normaliseReceipt(receipt);

  for (const entry of [...normalised.entries].reverse()) {
    const target = path.join(root, entry.path);

    if (entry.operation === 'create') {
      if (!(await pathExists(target))) {
        result.missing.push(entry.path);
        continue;
      }
      if (entry.sha256 && !options.force) {
        const current = crypto.createHash('sha256').update(await fsp.readFile(target)).digest('hex');
        if (current !== entry.sha256) {
          result.keptModified.push(entry.path);
          log.warn(`kept ${entry.path}: changed since IndieDeck wrote it`);
          continue;
        }
      }
      if (!options.dryRun) await fsp.rm(target, { recursive: true, force: true });
      result.removed.push(entry.path);
      continue;
    }

    // modify / snapshot: put the displaced original back.
    if (!entry.backup) {
      log.warn(`no backup recorded for ${entry.path} - leaving it in place`);
      result.keptModified.push(entry.path);
      continue;
    }
    const from = path.join(root, entry.backup);
    if (!(await pathExists(from))) {
      result.missing.push(entry.backup);
      continue;
    }
    if (!options.dryRun) {
      await ensureDir(path.dirname(target));
      await fsp.cp(from, target, { recursive: true });
    }
    result.restored.push(entry.path);
  }

  if (!options.dryRun) {
    const receiptFile = path.join(root, RECEIPT_DIR, `${receipt.kind}-${receipt.componentId}.json`);
    await fsp.rm(receiptFile, { force: true });
    await pruneEmptyDirs(root, normalised.entries.map((e) => e.path));
    await pruneEmptyDirs(root, [path.join(RECEIPT_DIR, 'x'), path.join(BACKUP_DIR, 'x')]);
  }
  return result;
}

/**
 * Removes directories the uninstall emptied, deepest first, including every
 * ancestor up to the game root - otherwise a bare `BepInEx/config/` tree is
 * left behind and the folder still looks modded.
 */
async function pruneEmptyDirs(root: string, files: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const file of files) {
    let dir = path.dirname(file);
    while (dir && dir !== '.' && dir !== path.sep) {
      dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length);
  for (const dir of deepestFirst) {
    try {
      await fsp.rmdir(path.join(root, dir));
    } catch {
      /* still has content - leave it alone */
    }
  }
}

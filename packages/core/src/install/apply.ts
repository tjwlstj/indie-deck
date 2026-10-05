import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { InstallReceipt, PlanStep, ReceiptEntry, TranslatorPlan } from '../types.ts';
import { ensureDir, pathExists } from '../util/fsx.ts';
import { applyIni } from '../util/ini.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import {
  defaultCacheDir,
  defaultToolsDir,
  downloadAsset,
  type DownloadOptions,
  type DownloadProgressEvent,
} from './download.ts';
import { extract7z, findExtractedEntry } from './sevenzip.ts';
import { FileTransaction, type RollbackFailure } from './transaction.ts';

export const RECEIPT_DIR = '.indiedeck/receipts';
export const BACKUP_DIR = '.indiedeck/backups';

export type ApplyProgressPhase =
  | 'preflight'
  | 'download'
  | 'verify'
  | 'backup'
  | 'extract'
  | 'configure'
  | 'manual'
  | 'receipt'
  | 'rollback';

export interface ApplyProgress {
  phase: ApplyProgressPhase;
  status: 'started' | 'progress' | 'completed' | 'skipped' | 'pending-user' | 'failed';
  /** One-based logical step index. Preflight and receipt are included. */
  stepIndex: number;
  stepCount: number;
  description: string;
  descriptionKey?: string;
  descriptionParams?: Record<string, string | number | undefined>;
  assetId?: string;
  received?: number;
  total?: number;
  fromCache?: boolean;
  integrity?: 'verified' | 'unverified' | 'mismatch';
  detail?: string;
}

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
  /** Structured, best-effort observer. Observer errors never abort an install. */
  onEvent?: (event: ApplyProgress) => void;
}

export interface ApplyRollbackFailure extends RollbackFailure {
  /** `external` marks a write outside the game transaction that could not be proven restored. */
  scope?: 'game' | 'external';
}

export interface ApplyResult {
  receipts: InstallReceipt[];
  performed: { step: PlanStep; status: 'done' | 'skipped' | 'pending-user'; detail?: string }[];
  filesWritten: string[];
  pendingUserActions: string[];
  mutationStatus: 'rolled-back' | 'partial' | 'committed';
  rollbackStatus: 'complete' | 'partial' | 'not-run';
  rollbackFailures: ApplyRollbackFailure[];
  receiptStatus: 'not-run' | 'not-needed' | 'complete' | 'partial' | 'failed';
  receiptError?: string;
  failedStep?: string;
  /** Legacy failure summary; use mutationStatus/rollbackStatus for the verdict. */
  rolledBack?: { failedStep: string; error: string };
}

function phaseOf(step: PlanStep): ApplyProgressPhase {
  switch (step.action) {
    case 'download':
      return 'download';
    case 'backup':
      return 'backup';
    case 'extract':
    case 'copy':
      return 'extract';
    case 'config':
      return 'configure';
    case 'run':
    case 'manual':
    default:
      return 'manual';
  }
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
 * Nothing in the game folder is written without first recording whether it
 * displaced an existing file. Pre-commit failures attempt journal rollback and
 * report any gaps; a later receipt failure is reported as committed/unmanaged
 * instead of pretending the installed files were reverted. Downloads are
 * cached and content-hashed; third-party executables require `allowRun`.
 */
export async function applyPlan(plan: TranslatorPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const log = options.logger ?? silentLogger;
  const gameRoot = plan.gamePath;
  const toolsDir = options.toolsDir ?? defaultToolsDir();
  const stepCount = plan.steps.length + 2; // preflight + plan steps + receipt
  const result: ApplyResult = {
    receipts: [],
    performed: [],
    filesWritten: [],
    pendingUserActions: [],
    mutationStatus: 'partial',
    rollbackStatus: 'not-run',
    rollbackFailures: [],
    receiptStatus: 'not-run',
  };

  const emit = (event: ApplyProgress): void => {
    try {
      options.onEvent?.(event);
    } catch (err) {
      log.warn(`apply progress observer failed: ${(err as Error).message}`);
    }
  };

  const progressFor = (
    step: PlanStep,
    stepIndex: number,
    phase: ApplyProgressPhase,
    status: ApplyProgress['status'],
    extra: Partial<Pick<ApplyProgress, 'assetId' | 'received' | 'total' | 'fromCache' | 'integrity' | 'detail'>> = {},
  ): void => {
    emit({
      phase,
      status,
      stepIndex,
      stepCount,
      description: step.description,
      ...(step.descriptionKey ? { descriptionKey: step.descriptionKey } : {}),
      ...(step.descriptionParams ? { descriptionParams: step.descriptionParams } : {}),
      ...extra,
    });
  };

  const preflightDescription = `Prepare ${plan.translatorName} ${plan.version}`;
  emit({
    phase: 'preflight',
    status: 'started',
    stepIndex: 1,
    stepCount,
    description: preflightDescription,
    descriptionKey: 'core.progress.preflight',
    descriptionParams: { translator: plan.translatorName, version: plan.version },
  });

  const tx = new FileTransaction({
    root: gameRoot,
    backupDir: BACKUP_DIR,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    logger: log,
  });

  let lastDownload: { path: string; name: string } | undefined;
  const loaderEntries: ReceiptEntry[] = [];
  const translatorEntries: ReceiptEntry[] = [];
  const externalWrites: ApplyRollbackFailure[] = [];
  let currentStep: PlanStep | undefined;
  let currentStepIndex = 1;
  let currentPhase: ApplyProgressPhase = 'preflight';
  let failureEventEmitted = false;

  emit({
    phase: 'preflight',
    status: 'completed',
    stepIndex: 1,
    stepCount,
    description: preflightDescription,
    descriptionKey: 'core.progress.preflight',
    descriptionParams: { translator: plan.translatorName, version: plan.version },
  });

  /**
   * Which receipt a written file belongs to is decided by the step itself, not
   * by a cursor that advances on the first extract. A plan whose loader step is
   * a manual instruction, or whose loader archive is not a ZIP, used to file the
   * translator's whole payload under a loader receipt that was never installed.
   */
  const ownerOf = (step: PlanStep): 'loader' | 'translator' =>
    step.details?.['loaderId'] !== undefined ? 'loader' : 'translator';

  const collect = (step: PlanStep, entries: ReceiptEntry[]): void => {
    (ownerOf(step) === 'loader' ? loaderEntries : translatorEntries).push(...entries);
    result.filesWritten.push(...entries.filter((e) => e.operation !== 'snapshot').map((e) => e.path));
  };

  const record = (
    step: PlanStep,
    status: ApplyResult['performed'][number]['status'],
    detail?: string,
    emitProgress = true,
  ): void => {
    result.performed.push({ step, status, ...(detail !== undefined ? { detail } : {}) });
    if (!emitProgress) return;
    progressFor(
      step,
      currentStepIndex,
      currentPhase,
      status === 'done' ? 'completed' : status === 'pending-user' ? 'pending-user' : 'skipped',
      detail !== undefined ? { detail } : {},
    );
  };

  try {
    for (const [planStepIndex, step] of plan.steps.entries()) {
      currentStep = step;
      currentStepIndex = planStepIndex + 2;
      currentPhase = phaseOf(step);
      failureEventEmitted = false;
      if (step.action !== 'download') progressFor(step, currentStepIndex, currentPhase, 'started');
      switch (step.action) {
        case 'backup': {
          if (options.dryRun) {
            record(step, 'skipped', 'dry run');
            break;
          }
          const entry = await tx.snapshot(step.dest ?? '.');
          if (entry) translatorEntries.push(entry);
          record(step, entry ? 'done' : 'skipped', entry?.backup ?? 'nothing to back up');
          break;
        }

        case 'download': {
          if (!step.source) {
            progressFor(step, currentStepIndex, currentPhase, 'started');
            record(step, 'skipped', 'no source');
            break;
          }
          if (options.dryRun) {
            progressFor(step, currentStepIndex, currentPhase, 'started');
            record(step, 'skipped', 'dry run');
            break;
          }
          const callerDownloadEvent = options.onDownloadEvent;
          const dl = await downloadAsset(step.source, {
            ...options,
            logger: log,
            onDownloadEvent: (event: DownloadProgressEvent) => {
              currentPhase = event.phase;
              if (event.status === 'failed') failureEventEmitted = true;
              progressFor(step, currentStepIndex, event.phase, event.status, {
                assetId: event.assetId,
                ...(event.received !== undefined ? { received: event.received } : {}),
                ...(event.total !== undefined ? { total: event.total } : {}),
                ...(event.fromCache !== undefined ? { fromCache: event.fromCache } : {}),
                ...(event.integrity !== undefined ? { integrity: event.integrity } : {}),
                ...(event.error !== undefined ? { detail: event.error } : {}),
              });
              callerDownloadEvent?.(event);
            },
          });
          lastDownload = { path: dl.path, name: path.basename(dl.path) };
          record(
            step,
            'done',
            `${(dl.bytes / 1048576).toFixed(1)} MB${dl.fromCache ? ' (cached)' : ''} sha256=${dl.sha256.slice(0, 12)}` +
              (dl.integrity === 'verified' ? ' [verified]' : dl.integrity === 'mismatch' ? ' [MISMATCH]' : ''),
            false,
          );
          break;
        }

        case 'extract': {
          if (!lastDownload) {
            record(step, 'skipped', 'nothing downloaded to extract');
            break;
          }
          const dest = resolveDest(gameRoot, step.dest, toolsDir);

          if (!lastDownload.path.toLowerCase().endsWith('.zip')) {
            result.pendingUserActions.push(
              `${lastDownload.name} is not a ZIP archive - extract it manually into ${step.dest ?? '.'} (downloaded to ${lastDownload.path}).`,
            );
            record(step, 'pending-user', 'non-zip archive');
            break;
          }

          // Tool installs land outside the game folder, so they are not part of
          // the game's transaction and never appear in its receipt.
          if (!dest.insideGame) {
            if (options.dryRun) {
              record(step, 'skipped', 'dry run');
              break;
            }
            const { extractZip } = await import('./unzip.ts');
            await ensureDir(dest.abs);
            externalWrites.push({
              path: dest.abs,
              operation: 'create',
              error: 'This tools-directory write is outside the game transaction and was not rolled back.',
              scope: 'external',
            });
            const extracted = await extractZip(lastDownload.path, dest.abs);
            record(step, 'done', `${extracted.files.length} files -> ${dest.abs}`);
            break;
          }

          const relDest = step.dest && step.dest !== '.' ? step.dest : '.';
          const entries = await tx.extract(lastDownload.path, relDest);
          collect(step, entries);
          record(
            step,
            options.dryRun ? 'skipped' : 'done',
            `${entries.length} files${entries.some((e) => e.operation === 'modify') ? `, ${entries.filter((e) => e.operation === 'modify').length} displaced (backed up)` : ''}`,
          );
          break;
        }

        case 'copy': {
          if (!lastDownload || !step.dest) {
            record(step, 'skipped', 'nothing downloaded to copy');
            break;
          }
          if (options.dryRun) {
            record(step, 'skipped', 'dry run');
            break;
          }
          const download = lastDownload;
          const copyDest = step.dest;
          const prepared = await (async () => {
            try {
              const extracted = await extract7z(download.path, options.cacheDir ?? defaultCacheDir());
              const source = await findExtractedEntry(extracted.dir, copyDest);
              if (!source) throw new Error(`${copyDest} not found inside ${download.name}`);
              return { extracted, source };
            } catch (err) {
              result.pendingUserActions.push(
                `Extract ${copyDest} from ${download.path} into the game folder manually - ${(err as Error).message}`,
              );
              record(step, 'pending-user', '7z extraction unavailable');
              return undefined;
            }
          })();
          if (!prepared) break;

          // Once the source has been resolved, a copy failure is a transaction
          // failure. Do not turn it into a manual-success path: copyIn journals
          // before mutation so the outer catch can roll it back truthfully.
          const entry = await tx.copyIn(prepared.source, copyDest);
          collect(step, [entry]);
          record(
            step,
            'done',
            `via ${prepared.extracted.extractor}${prepared.extracted.fromCache ? ' (cached)' : ''}`,
          );
          break;
        }

        case 'run': {
          const exe = String(step.details?.['exe'] ?? '');
          if (!options.allowRun || options.dryRun) {
            result.pendingUserActions.push(`Run ${exe} in ${gameRoot}, then launch the game once through the generated shortcut.`);
            record(step, 'pending-user', 'requires --allow-run');
            break;
          }
          const exePath = path.join(gameRoot, exe);
          if (!(await pathExists(exePath))) {
            record(step, 'skipped', `${exe} not found`);
            break;
          }
          externalWrites.push({
            path: exe,
            operation: 'modify',
            error: 'An external setup process ran; changes beyond the transaction journal cannot be proven restored.',
            scope: 'external',
          });
          const code = await runProcess(exePath, gameRoot);
          record(step, code === 0 ? 'done' : 'skipped', `exit ${code}`);
          break;
        }

        case 'config': {
          if (!step.dest || Object.keys(plan.config).length === 0) {
            record(step, 'skipped', 'nothing to write');
            break;
          }
          if (options.dryRun) {
            record(step, 'skipped', 'dry run');
            break;
          }
          const configPath = path.join(gameRoot, step.dest);
          const existing = (await pathExists(configPath)) ? await fsp.readFile(configPath, 'utf8') : '';
          const entry = await tx.write(step.dest, applyIni(existing, plan.config));
          collect(step, [entry]);
          record(step, 'done', Object.keys(plan.config).join(', '));
          break;
        }

        case 'manual':
        default: {
          if (step.details?.['informational'] === true) {
            record(step, 'skipped', 'informational');
            break;
          }
          result.pendingUserActions.push(step.description);
          record(step, 'pending-user');
          break;
        }
      }
    }
  } catch (err) {
    const failed = currentStep?.description ?? 'install';
    result.failedStep = failed;
    if (!failureEventEmitted) {
      progressFor(currentStep ?? { action: 'manual', description: failed }, currentStepIndex, currentPhase, 'failed', {
        detail: (err as Error).message,
      });
    }
    log.error(`Install failed during "${failed}" - rolling back`);
    emit({
      phase: 'rollback',
      status: 'started',
      stepIndex: currentStepIndex,
      stepCount,
      description: 'Restore game folder after the failed install',
      descriptionKey: 'core.progress.rollback',
      descriptionParams: { failedStep: failed },
    });
    const rollback = await tx.rollback();
    result.rollbackFailures = [...rollback.failures.map((failure) => ({ ...failure, scope: 'game' as const })), ...externalWrites];
    result.rollbackStatus = result.rollbackFailures.length > 0 || rollback.status === 'partial' ? 'partial' : rollback.status;
    result.mutationStatus = result.rollbackStatus === 'complete' ? 'rolled-back' : 'partial';
    emit({
      phase: 'rollback',
      status: result.rollbackStatus === 'complete' ? 'completed' : result.rollbackStatus === 'not-run' ? 'skipped' : 'failed',
      stepIndex: currentStepIndex,
      stepCount,
      description: 'Restore game folder after the failed install',
      descriptionKey: 'core.progress.rollback',
      descriptionParams: { failedStep: failed },
      ...(result.rollbackFailures.length > 0
        ? { detail: result.rollbackFailures.map((failure) => `${failure.path}: ${failure.error}`).join('; ') }
        : {}),
    });
    result.rolledBack = { failedStep: failed, error: (err as Error).message };
    if (result.mutationStatus === 'rolled-back') result.filesWritten = [];
    throw Object.assign(err as Error, { applyResult: result });
  }

  tx.commit();
  result.mutationStatus = 'committed';

  const receiptStepIndex = stepCount;
  const receiptDescription = 'Record install receipts';
  emit({
    phase: 'receipt',
    status: 'started',
    stepIndex: receiptStepIndex,
    stepCount,
    description: receiptDescription,
    descriptionKey: 'core.progress.receipt',
  });

  const receiptsExpected =
    !options.dryRun &&
    ((plan.loader !== undefined && !plan.loader.alreadyInstalled && loaderEntries.length > 0 ? 1 : 0) +
      (translatorEntries.length > 0 ? 1 : 0));

  if (!receiptsExpected) {
    result.receiptStatus = options.dryRun ? 'not-run' : 'not-needed';
    emit({
      phase: 'receipt',
      status: 'skipped',
      stepIndex: receiptStepIndex,
      stepCount,
      description: receiptDescription,
      descriptionKey: 'core.progress.receipt',
      detail: options.dryRun ? 'dry run' : 'no managed files were written',
    });
    return result;
  }

  try {
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
    result.receiptStatus = 'complete';
    emit({
      phase: 'receipt',
      status: 'completed',
      stepIndex: receiptStepIndex,
      stepCount,
      description: receiptDescription,
      descriptionKey: 'core.progress.receipt',
      detail: `${result.receipts.length} receipt(s) written`,
    });
  } catch (err) {
    result.failedStep = receiptDescription;
    result.receiptError = (err as Error).message;
    result.receiptStatus = result.receipts.length > 0 ? 'partial' : 'failed';
    // The game transaction has already committed. Do not claim rollback or
    // erase filesWritten: callers must surface "installed but unmanaged".
    result.rollbackStatus = 'not-run';
    emit({
      phase: 'receipt',
      status: 'failed',
      stepIndex: receiptStepIndex,
      stepCount,
      description: receiptDescription,
      descriptionKey: 'core.progress.receipt',
      detail: result.receiptError,
    });
    throw Object.assign(err as Error, { applyResult: result });
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
  const storagePath = receiptStoragePath(gameRoot, receipt);
  await ensureDir(dir);
  await fsp.writeFile(
    storagePath,
    JSON.stringify(receipt, null, 2),
    'utf8',
  );
  return receipt;
}

/**
 * A receipt is a JSON file sitting in a game folder, so it is untrusted input:
 * an entry that escapes the root would turn uninstall into an arbitrary delete.
 */
function isInsideRoot(relative: string): boolean {
  const cleaned = relative.replace(/\\/g, '/');
  if (cleaned === '' || cleaned.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(cleaned)) return false;
  return !cleaned.split('/').includes('..');
}

/**
 * Component IDs become part of a Windows receipt filename. Keep them as one
 * canonical filename segment while allowing human-readable Unicode names and
 * internal spaces (for example, locally installed Korean mod names).
 */
export function isSafeReceiptComponentId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..') return false;
  if (/[\u0000-\u001f<>:"/\\|?*]/u.test(value) || /[ .]$/u.test(value)) return false;
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
}

function receiptStoragePath(gameRoot: string, receipt: Pick<InstallReceipt, 'kind' | 'componentId'>): string {
  if (!isSafeReceiptComponentId(receipt.componentId)) {
    throw new Error(
      `Refusing to use a receipt component ID outside the receipts folder or unsafe as a Windows filename: ${JSON.stringify(receipt.componentId)}.`,
    );
  }
  const dir = path.resolve(gameRoot, RECEIPT_DIR);
  const target = path.resolve(dir, `${receipt.kind}-${receipt.componentId}.json`);
  if (!target.startsWith(dir + path.sep)) throw new Error('Refusing to use a receipt path outside the receipts folder.');
  return target;
}

/** Reads a receipt of either schema version into the current shape. */
export function normaliseReceipt(raw: InstallReceipt): InstallReceipt {
  const safe = (entries: ReceiptEntry[]): ReceiptEntry[] =>
    entries.filter((e) => isInsideRoot(e.path) && (e.backup === undefined || isInsideRoot(e.backup)));

  if (Array.isArray(raw.entries) && raw.entries.length > 0) return { ...raw, entries: safe(raw.entries) };

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
  return { ...raw, schemaVersion: 1, entries: safe(entries) };
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
      const parsed = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as InstallReceipt;
      // The folder the receipt was found in is authoritative, not the path
      // recorded inside it.
      out.push(normaliseReceipt({ ...parsed, gamePath: gameRoot }));
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
  /** True when unresolved entries kept the receipt available for a retry. */
  receiptRetained?: boolean;
}

export interface UninstallOptions {
  /** Overrides the receipt's own gamePath. The caller knows where it read it from. */
  root?: string;
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
  const root = path.resolve(options.root ?? receipt.gamePath);
  // Validate the untrusted receipt identity before touching any managed file.
  const receiptFile = receiptStoragePath(root, receipt);
  const normalised = normaliseReceipt(receipt);
  const unresolved: ReceiptEntry[] = [];

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
          unresolved.unshift(entry);
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
      unresolved.unshift(entry);
      continue;
    }
    const from = path.join(root, entry.backup);
    if (!(await pathExists(from))) {
      result.missing.push(entry.backup);
      unresolved.unshift(entry);
      continue;
    }
    if (!options.force && (await pathExists(target))) {
      if (entry.operation === 'modify' && entry.sha256) {
        const current = crypto.createHash('sha256').update(await fsp.readFile(target)).digest('hex');
        if (current !== entry.sha256) {
          result.keptModified.push(entry.path);
          unresolved.unshift(entry);
          log.warn(`kept ${entry.path}: changed since IndieDeck wrote it`);
          continue;
        }
      }
      if (entry.operation === 'snapshot') {
        if (!(await samePathContents(target, from))) {
          result.keptModified.push(entry.path);
          unresolved.unshift(entry);
          log.warn(`kept ${entry.path}: snapshot has no post-write hash, so a changed path cannot be restored safely`);
          continue;
        }
        // It already matches the baseline snapshot; no copy is necessary.
        result.restored.push(entry.path);
        continue;
      }
    }
    if (!options.dryRun) {
      await ensureDir(path.dirname(target));
      await fsp.cp(from, target, { recursive: true });
    }
    result.restored.push(entry.path);
  }

  if (!options.dryRun) {
    if (unresolved.length > 0) {
      const retained: InstallReceipt = {
        ...normalised,
        schemaVersion: 2,
        entries: unresolved,
        files: undefined,
        backups: undefined,
      };
      await fsp.writeFile(receiptFile, JSON.stringify(retained, null, 2), 'utf8');
      result.receiptRetained = true;
    } else {
      await fsp.rm(receiptFile, { force: true });
    }
    await pruneEmptyDirs(root, normalised.entries.map((e) => e.path));
    await pruneEmptyDirs(root, [path.join(RECEIPT_DIR, 'x'), path.join(BACKUP_DIR, 'x')]);
  }
  return result;
}

/** Byte-for-byte comparison used only for conservative snapshot removal. */
async function samePathContents(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fsp.lstat(left), fsp.lstat(right)]);
  if (leftStat.isFile() !== rightStat.isFile() || leftStat.isDirectory() !== rightStat.isDirectory()) return false;
  if (leftStat.isFile()) {
    if (leftStat.size !== rightStat.size) return false;
    const [a, b] = await Promise.all([fsp.readFile(left), fsp.readFile(right)]);
    return a.equals(b);
  }
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    if (!leftStat.isSymbolicLink() || !rightStat.isSymbolicLink()) return false;
    const [a, b] = await Promise.all([fsp.readlink(left), fsp.readlink(right)]);
    return a === b;
  }
  if (!leftStat.isDirectory()) return false;
  const [leftNames, rightNames] = await Promise.all([fsp.readdir(left), fsp.readdir(right)]);
  leftNames.sort();
  rightNames.sort();
  if (leftNames.length !== rightNames.length || leftNames.some((name, index) => name !== rightNames[index])) return false;
  for (const name of leftNames) {
    if (!(await samePathContents(path.join(left, name), path.join(right, name)))) return false;
  }
  return true;
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

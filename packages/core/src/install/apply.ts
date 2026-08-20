import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { InstallReceipt, PlanStep, TranslatorPlan } from '../types.ts';
import { ensureDir, pathExists } from '../util/fsx.ts';
import { applyIni } from '../util/ini.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import { defaultCacheDir, defaultToolsDir, downloadAsset, type DownloadOptions } from './download.ts';
import { extract7z, findExtractedEntry } from './sevenzip.ts';
import { extractZip } from './unzip.ts';

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
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function backupPath(gameRoot: string, relative: string, log: Logger): Promise<{ original: string; backup: string } | undefined> {
  const source = path.join(gameRoot, relative);
  if (!(await pathExists(source))) return undefined;
  const dest = path.join(gameRoot, BACKUP_DIR, stamp(), relative);
  await ensureDir(path.dirname(dest));
  await fsp.cp(source, dest, { recursive: true });
  log.info(`Backed up ${relative} -> ${path.relative(gameRoot, dest)}`);
  return { original: relative, backup: path.relative(gameRoot, dest) };
}

function resolveDest(gameRoot: string, dest: string | undefined, toolsDir: string): string {
  if (!dest || dest === '.') return gameRoot;
  if (dest.startsWith('$toolsDir')) return path.join(toolsDir, dest.replace('$toolsDir', '').replace(/^[\\/]/, ''));
  return path.join(gameRoot, dest);
}

/**
 * Executes a resolved plan. Downloads are cached and content-hashed, every
 * write is recorded in a receipt next to the game, and anything that would run
 * a third-party executable stops and asks unless `allowRun` is set.
 */
export async function applyPlan(plan: TranslatorPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const log = options.logger ?? silentLogger;
  const gameRoot = plan.gamePath;
  const toolsDir = options.toolsDir ?? defaultToolsDir();
  const result: ApplyResult = { receipts: [], performed: [], filesWritten: [], pendingUserActions: [] };

  const backups: { original: string; backup: string }[] = [];
  let lastDownload: { path: string; name: string } | undefined;
  const loaderFiles: string[] = [];
  const translatorFiles: string[] = [];
  let phase: 'loader' | 'translator' = plan.loader && !plan.loader.alreadyInstalled ? 'loader' : 'translator';

  for (const step of plan.steps) {
    switch (step.action) {
      case 'backup': {
        if (options.dryRun) {
          result.performed.push({ step, status: 'skipped', detail: 'dry run' });
          break;
        }
        const done = await backupPath(gameRoot, step.dest ?? '.', log);
        if (done) backups.push(done);
        result.performed.push({ step, status: done ? 'done' : 'skipped', detail: done ? done.backup : 'nothing to back up' });
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
          detail: `${(dl.bytes / 1048576).toFixed(1)} MB${dl.fromCache ? ' (cached)' : ''} sha256=${dl.sha256.slice(0, 12)}`,
        });
        break;
      }

      case 'extract': {
        if (!lastDownload) {
          result.performed.push({ step, status: 'skipped', detail: 'nothing downloaded to extract' });
          break;
        }
        const dest = resolveDest(gameRoot, step.dest, toolsDir);
        if (options.dryRun) {
          const preview = await extractZip(lastDownload.path, dest, { dryRun: true });
          result.performed.push({ step, status: 'skipped', detail: `would write ${preview.files.length} files` });
          break;
        }
        if (!lastDownload.path.toLowerCase().endsWith('.zip')) {
          result.pendingUserActions.push(
            `${lastDownload.name} is not a ZIP archive - extract it manually into ${path.relative(gameRoot, dest) || '.'} (downloaded to ${lastDownload.path}).`,
          );
          result.performed.push({ step, status: 'pending-user', detail: 'non-zip archive' });
          break;
        }
        await ensureDir(dest);
        const extracted = await extractZip(lastDownload.path, dest);
        const written = extracted.files.map((f) => path.relative(gameRoot, path.join(dest, f)));
        result.filesWritten.push(...written);
        (phase === 'loader' ? loaderFiles : translatorFiles).push(...written);
        if (phase === 'loader') phase = 'translator';
        result.performed.push({ step, status: 'done', detail: `${extracted.files.length} files` });
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
        // Font bundles ship inside a .7z, which the built-in ZIP reader cannot
        // touch - borrow whatever 7z-capable extractor the machine already has.
        try {
          const extracted = await extract7z(lastDownload.path, options.cacheDir ?? defaultCacheDir());
          const source = await findExtractedEntry(extracted.dir, step.dest);
          if (!source) throw new Error(`${step.dest} not found inside ${lastDownload.name}`);
          const target = path.join(gameRoot, step.dest);
          await fsp.cp(source, target, { recursive: true });
          result.filesWritten.push(step.dest);
          translatorFiles.push(step.dest);
          result.performed.push({ step, status: 'done', detail: `via ${extracted.extractor}${extracted.fromCache ? ' (cached)' : ''}` });
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
        if (existing) backups.push((await backupPath(gameRoot, step.dest, log))!);
        await ensureDir(path.dirname(configPath));
        await fsp.writeFile(configPath, applyIni(existing, plan.config), 'utf8');
        result.filesWritten.push(step.dest);
        translatorFiles.push(step.dest);
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

  if (!options.dryRun) {
    if (plan.loader && !plan.loader.alreadyInstalled && loaderFiles.length > 0) {
      result.receipts.push(
        await writeReceipt(gameRoot, {
          kind: 'loader',
          componentId: plan.loader.loaderId,
          version: plan.loader.version,
          files: loaderFiles,
          backups: [],
        }),
      );
    }
    if (translatorFiles.length > 0) {
      result.receipts.push(
        await writeReceipt(gameRoot, {
          kind: 'translator',
          componentId: plan.translatorId,
          variantId: plan.variantId,
          version: plan.version,
          files: translatorFiles,
          backups,
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
  data: Omit<InstallReceipt, 'id' | 'gamePath' | 'installedAt'>,
): Promise<InstallReceipt> {
  const receipt: InstallReceipt = {
    id: crypto.randomUUID(),
    gamePath: gameRoot,
    installedAt: new Date().toISOString(),
    ...data,
  };
  const dir = path.join(gameRoot, RECEIPT_DIR);
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, `${receipt.kind}-${receipt.componentId}.json`), JSON.stringify(receipt, null, 2), 'utf8');
  return receipt;
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
      out.push(JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as InstallReceipt);
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
}

/** Removes exactly what a receipt recorded, then restores anything it displaced. */
export async function uninstallReceipt(receipt: InstallReceipt, options: { dryRun?: boolean } = {}): Promise<UninstallResult> {
  const result: UninstallResult = { removed: [], restored: [], missing: [] };
  const root = receipt.gamePath;

  for (const relative of receipt.files) {
    const target = path.join(root, relative);
    if (!(await pathExists(target))) {
      result.missing.push(relative);
      continue;
    }
    if (!options.dryRun) await fsp.rm(target, { recursive: true, force: true });
    result.removed.push(relative);
  }

  for (const backup of receipt.backups) {
    const from = path.join(root, backup.backup);
    if (!(await pathExists(from))) continue;
    if (!options.dryRun) {
      await ensureDir(path.dirname(path.join(root, backup.original)));
      await fsp.cp(from, path.join(root, backup.original), { recursive: true });
    }
    result.restored.push(backup.original);
  }

  if (!options.dryRun) {
    const receiptFile = path.join(root, RECEIPT_DIR, `${receipt.kind}-${receipt.componentId}.json`);
    await fsp.rm(receiptFile, { force: true });
    await pruneEmptyDirs(root, receipt.files);
    // Leave no IndieDeck trace behind once the last receipt and backup are gone.
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

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeScanDepth } from '../detect/index.ts';
import { t } from '../i18n/index.ts';
import { defaultDataDir } from '../install/download.ts';

export interface LauncherConfig {
  roots: string[];
  locale: string;
  defaults: { targetLanguage: string; sourceLanguage: string; endpoint: string };
  scanDepth: number;
  scanOnLaunch?: boolean;
  /** Undefined probes the Windows default; null explicitly disables MTool. */
  externalTools?: { mtoolRoot?: string | null };
}

const DEFAULT_CONFIG: LauncherConfig = {
  roots: [], locale: 'system',
  defaults: { targetLanguage: 'en', sourceLanguage: 'ja', endpoint: 'GoogleTranslate' },
  scanDepth: normalizeScanDepth(undefined), scanOnLaunch: true,
};

export function configPath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, 'config.json');
}

function parseConfig(bytes: Buffer): LauncherConfig {
  const parsed = JSON.parse(bytes.toString('utf8')) as Partial<LauncherConfig> | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      (parsed.roots !== undefined && (!Array.isArray(parsed.roots) || !parsed.roots.every(root => typeof root === 'string'))) ||
      (parsed.locale !== undefined && typeof parsed.locale !== 'string') ||
      (parsed.defaults !== undefined && (!parsed.defaults || typeof parsed.defaults !== 'object' || Array.isArray(parsed.defaults) ||
        Object.keys(DEFAULT_CONFIG.defaults).some(key => {
          const value = parsed.defaults?.[key as keyof LauncherConfig['defaults']];
          return value !== undefined && typeof value !== 'string';
        })))) throw new Error('Invalid launcher settings.');
  const root = parsed.externalTools?.mtoolRoot;
  const validMTool = root === null || (typeof root === 'string' && root.length > 0 && root.length <= 32768 && !root.includes('\0'));
  return {
    ...DEFAULT_CONFIG, ...parsed, roots: parsed.roots ?? [],
    defaults: { ...DEFAULT_CONFIG.defaults, ...parsed.defaults },
    scanDepth: normalizeScanDepth(parsed.scanDepth), scanOnLaunch: parsed.scanOnLaunch !== false,
    externalTools: validMTool ? { mtoolRoot: root } : undefined,
  };
}

async function readBytes(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(t('core.error.config-unsafe'));
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function fingerprint(bytes: Buffer | null): string | null {
  return bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex');
}

function validBackup(bytes: Buffer | null): Buffer | null {
  if (bytes === null) return null;
  try { parseConfig(bytes); return bytes; } catch { return null; }
}

export class LauncherConfigRecoveryError extends Error {
  readonly fingerprint: string | null;
  readonly backupFingerprint: string | null;

  constructor(fingerprint: string | null, backupFingerprint: string | null) {
    super(t('core.error.config-recovery'));
    this.fingerprint = fingerprint;
    this.backupFingerprint = backupFingerprint;
  }
}

async function readPrimary(file: string): Promise<{ bytes: Buffer | null; config: LauncherConfig }> {
  const bytes = await readBytes(file);
  if (bytes !== null) {
    try { return { bytes, config: parseConfig(bytes) }; } catch { /* Inspect the previous backup to offer recovery. */ }
  }
  const backup = await readBytes(file + '.bak');
  if (bytes === null && backup === null) return { bytes, config: structuredClone(DEFAULT_CONFIG) };
  throw new LauncherConfigRecoveryError(fingerprint(bytes), fingerprint(validBackup(backup)));
}

export async function loadConfig(dataDir = defaultDataDir()): Promise<LauncherConfig> {
  return (await readPrimary(configPath(dataDir))).config;
}

async function writeNew(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function replaceFile(file: string, bytes: Buffer): Promise<void> {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    await writeNew(temp, bytes);
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function saveConfig(config: LauncherConfig, dataDir = defaultDataDir()): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const file = configPath(dataDir);
  // A parse or I/O error must block all ordinary writes, including addRoot.
  const current = await readPrimary(file);
  const next = Buffer.from(JSON.stringify({ ...config, scanDepth: normalizeScanDepth(config.scanDepth), scanOnLaunch: config.scanOnLaunch !== false }, null, 2));
  parseConfig(next);
  // Keep the previous valid bytes (the initial settings on the first save).
  await replaceFile(file + '.bak', current.bytes ?? next);
  await replaceFile(file, next);
}

/** Called only after the user accepts recovery of the observed damaged version. */
export async function recoverLauncherConfig(issue: LauncherConfigRecoveryError, dataDir = defaultDataDir()): Promise<LauncherConfig> {
  const file = configPath(dataDir);
  const bytes = await readBytes(file);
  if (fingerprint(bytes) !== issue.fingerprint) throw new Error(t('core.error.config-changed'));
  const backup = validBackup(await readBytes(file + '.bak'));
  if (fingerprint(backup) !== issue.backupFingerprint) throw new Error(t('core.error.config-changed'));
  const next = backup ?? Buffer.from(JSON.stringify(DEFAULT_CONFIG, null, 2));
  const restored = parseConfig(next);
  if (bytes !== null) await writeNew(path.join(dataDir, 'config.damaged-' + crypto.randomUUID() + '.json'), bytes);
  await replaceFile(file, next);
  return restored;
}

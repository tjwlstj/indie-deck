import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isSafeReceiptComponentId } from '@indiedeck/core';
import type { InstallReceipt, ReceiptEntry } from '@indiedeck/core';

const RECEIPT_DIR = '.indiedeck/receipts';
const BACKUP_PREFIX = '.indiedeck/backups/';
const RECEIPT_KINDS = new Set<InstallReceipt['kind']>(['loader', 'translator', 'mod', 'font']);
const SHA256 = /^[a-fA-F0-9]{64}$/;

function fail(name: string, reason: string): never {
  throw new Error(`Unsafe install receipt ${JSON.stringify(name)}: ${reason}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(name, 'expected an object.');
  return value as Record<string, unknown>;
}

/** Normalises a receipt path without ever accepting an absolute or parent path. */
function safeRelative(value: unknown, name: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(name, `${field} must be a non-empty relative path.`);
  const normalised = value.replace(/\\/g, '/');
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised) || normalised.includes('\0')) {
    fail(name, `${field} must stay inside the game folder.`);
  }
  const parts = normalised.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes(':'))) {
    fail(name, `${field} contains an unsafe path segment.`);
  }
  return parts.join('/');
}

function pathKey(value: string): string {
  const normalised = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalised.toLowerCase() : normalised;
}

function wouldTouchProtected(target: string, protectedPaths: string[]): boolean {
  const candidate = pathKey(target);
  return protectedPaths.some((protectedPath) => {
    const protectedKey = pathKey(protectedPath);
    return candidate === protectedKey || protectedKey.startsWith(`${candidate}/`);
  });
}

async function lstatOrMissing(target: string): Promise<Awaited<ReturnType<typeof fsp.lstat>> | undefined> {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Rejects symlinks and Windows junctions in every existing component. Missing
 * tails are allowed: uninstallReceipt reports a missing managed file safely.
 */
async function assertNoLinkedAncestor(root: string, relative: string, name: string, field: string): Promise<void> {
  let current = root;
  const rootStat = await lstatOrMissing(current);
  if (!rootStat?.isDirectory()) fail(name, 'the game root is missing or is not a directory.');
  if (rootStat.isSymbolicLink()) fail(name, 'the game root is a symbolic link or junction.');

  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await lstatOrMissing(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) fail(name, `${field} crosses a symbolic link or junction at ${JSON.stringify(part)}.`);
  }
}

async function readReceiptOnce(file: string, name: string): Promise<unknown> {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) fail(name, 'the receipt itself is not a regular file.');

  // O_NOFOLLOW is available on POSIX but not on all Windows Node builds. The
  // lstat + opened-handle identity checks remain fail-closed on those builds.
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await fsp.open(file, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail(name, 'the receipt changed while it was being opened.');
    }
    const text = await handle.readFile('utf8');
    const after = await handle.stat();
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
      fail(name, 'the receipt changed while it was being read.');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return fail(name, 'invalid JSON.');
    }
  } finally {
    await handle.close();
  }
}

function requiredString(raw: Record<string, unknown>, field: string, name: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.length === 0) fail(name, `${field} must be a non-empty string.`);
  return value;
}

async function validateEntry(
  rawValue: unknown,
  gameRoot: string,
  protectedPaths: string[],
  receiptName: string,
  index: number,
): Promise<ReceiptEntry> {
  const raw = object(rawValue, receiptName);
  const field = `entries[${index}]`;
  const target = safeRelative(raw['path'], receiptName, `${field}.path`);
  if (pathKey(target) === '.indiedeck' || pathKey(target).startsWith('.indiedeck/')) {
    fail(receiptName, `${field}.path may not modify IndieDeck metadata.`);
  }
  if (wouldTouchProtected(target, protectedPaths)) {
    fail(receiptName, `${field}.path would remove or restore a protected game executable.`);
  }

  const operation = raw['operation'];
  if (operation !== 'create' && operation !== 'modify' && operation !== 'snapshot') {
    fail(receiptName, `${field}.operation is missing or unsupported.`);
  }
  const sha256 = raw['sha256'];
  if ((operation === 'create' || operation === 'modify') && (typeof sha256 !== 'string' || !SHA256.test(sha256))) {
    fail(receiptName, `${field}.sha256 must be a 64-digit hash for ${operation}.`);
  }
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !SHA256.test(sha256))) {
    fail(receiptName, `${field}.sha256 is malformed.`);
  }

  const entry: ReceiptEntry = { path: target, operation };
  if (typeof sha256 === 'string') entry.sha256 = sha256.toLowerCase();

  if (operation === 'create') {
    if (raw['backup'] !== undefined) fail(receiptName, `${field}.backup is not valid for a created file.`);
  } else {
    const backup = safeRelative(raw['backup'], receiptName, `${field}.backup`);
    if (!pathKey(backup).startsWith(pathKey(BACKUP_PREFIX))) {
      fail(receiptName, `${field}.backup must be inside .indiedeck/backups/.`);
    }
    entry.backup = backup;
    await assertNoLinkedAncestor(gameRoot, backup, receiptName, `${field}.backup`);
  }

  await assertNoLinkedAncestor(gameRoot, target, receiptName, `${field}.path`);
  return entry;
}

async function validateReceipt(
  rawValue: unknown,
  name: string,
  gameRoot: string,
  protectedPaths: string[],
): Promise<InstallReceipt> {
  const raw = object(rawValue, name);
  if (raw['schemaVersion'] !== 2) {
    fail(name, 'legacy v1 receipts cannot be removed automatically; review them manually first.');
  }
  const kindValue = raw['kind'];
  if (typeof kindValue !== 'string' || !RECEIPT_KINDS.has(kindValue as InstallReceipt['kind'])) {
    fail(name, 'kind is missing or unsupported.');
  }
  const kind = kindValue as InstallReceipt['kind'];
  const componentId = requiredString(raw, 'componentId', name);
  if (!isSafeReceiptComponentId(componentId)) fail(name, 'componentId is not a safe canonical filename segment.');
  if (name !== `${kind}-${componentId}.json`) fail(name, 'the file name does not match kind and componentId.');

  const entriesValue = raw['entries'];
  if (!Array.isArray(entriesValue)) fail(name, 'entries must be an array.');
  const entries: ReceiptEntry[] = [];
  for (let index = 0; index < entriesValue.length; index += 1) {
    entries.push(await validateEntry(entriesValue[index], gameRoot, protectedPaths, name, index));
  }

  const receipt: InstallReceipt = {
    id: requiredString(raw, 'id', name),
    schemaVersion: 2,
    gamePath: gameRoot,
    kind,
    componentId,
    version: requiredString(raw, 'version', name),
    installedAt: requiredString(raw, 'installedAt', name),
    entries,
  };
  if (raw['variantId'] !== undefined) {
    if (typeof raw['variantId'] !== 'string') fail(name, 'variantId must be a string when present.');
    receipt.variantId = raw['variantId'];
  }
  return receipt;
}

/**
 * Reads each canonical receipt exactly once, validates that same parsed object,
 * and returns only the sanitised objects that may be passed to uninstallReceipt.
 * No evidence-only/read-again split is left for an attacker to race.
 */
export async function readSafeRemovalReceipts(gameRoot: string, protectedPaths: string[]): Promise<InstallReceipt[]> {
  const root = path.resolve(gameRoot);
  const protectedRelative = protectedPaths.map((value, index) => safeRelative(value, '<protected>', `protectedPaths[${index}]`));
  await assertNoLinkedAncestor(root, RECEIPT_DIR, '<receipt directory>', 'receipt directory');
  const dir = path.join(root, RECEIPT_DIR);
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const jsonEntries = dirents.filter((entry) => entry.name.toLowerCase().endsWith('.json'));
  jsonEntries.sort((a, b) => a.name.localeCompare(b.name));
  const receipts: InstallReceipt[] = [];
  for (const entry of jsonEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== path.basename(entry.name) || /[\\/]/.test(entry.name)) {
      fail(entry.name, 'the receipt storage entry is not a plain canonical file.');
    }
    // Recheck immediately before opening so replacing the receipts directory
    // after readdir cannot silently redirect the content read.
    await assertNoLinkedAncestor(root, RECEIPT_DIR, entry.name, 'receipt directory');
    const raw = await readReceiptOnce(path.join(dir, entry.name), entry.name);
    receipts.push(await validateReceipt(raw, entry.name, root, protectedRelative));
  }
  return receipts;
}

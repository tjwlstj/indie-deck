/**
 * Shared test fixtures.
 *
 * One module owns the fake game folders, receipt samples and DLL version
 * evidence so the health, audit and (later) maintenance tests all exercise the
 * same shapes. Fault injection hooks the fs boundary in each test file; these
 * helpers only build what is on disk.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Builds a PE header with the given machine type, enough for peArch. */
export function fakeExe(machine: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80);
  buf.writeUInt16LE(machine, 0x84);
  return buf;
}

let tmpRoot: string | undefined;

/** Lazily created root under the OS temp dir holding every fixture folder. */
export function fixtureRoot(): string {
  tmpRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'indiedeck-fixtures-'));
  return tmpRoot;
}

export function cleanupFixtures(): void {
  if (!tmpRoot) return;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
}

export function makeGame(name: string, files: Record<string, string | Buffer>): string {
  const root = path.join(fixtureRoot(), name);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

/**
 * A DLL whose version resource peVersionString can read: it scans the file as
 * UTF-16LE text for ProductVersion/FileVersion, so the fixture simply is that
 * text. No resource tree needed.
 */
export function dllWithVersion(version: string): Buffer {
  return Buffer.from(`ProductVersion${version}`, 'utf16le');
}

export const sha256 = (content: string | Buffer): string =>
  crypto.createHash('sha256').update(content).digest('hex');

export interface ReceiptSeed {
  kind?: 'loader' | 'translator' | 'mod' | 'font';
  componentId?: string;
  variantId?: string;
  version?: string;
  schemaVersion?: number;
  entries?: { path: string; operation?: 'create' | 'modify' | 'snapshot'; backup?: string; sha256?: string }[];
}

/**
 * Writes a v2-shaped receipt into `<root>/.indiedeck/receipts/<storageName>` and
 * returns the parsed object. `storageName` defaults to the canonical
 * `kind-componentId.json` form; tests pass an explicit name to model damaged
 * or future-versioned storage ids.
 */
export function writeReceiptFile(root: string, seed: ReceiptSeed = {}, storageName?: string): Record<string, unknown> {
  const kind = seed.kind ?? 'translator';
  const componentId = seed.componentId ?? 'xunity-autotranslator';
  const receipt: Record<string, unknown> = {
    id: crypto.randomUUID(),
    schemaVersion: seed.schemaVersion ?? 2,
    gamePath: root,
    kind,
    componentId,
    version: seed.version ?? '5.6.1',
    installedAt: new Date().toISOString(),
    entries: seed.entries ?? [],
  };
  if (seed.variantId) receipt.variantId = seed.variantId;
  const dir = path.join(root, '.indiedeck', 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  const name = storageName ?? `${kind}-${componentId}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(receipt, null, 2), 'utf8');
  return receipt;
}

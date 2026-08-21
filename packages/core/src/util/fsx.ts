import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** A single directory listing, cached and indexed case-insensitively. */
export interface DirIndex {
  dir: string;
  names: string[];
  lower: Map<string, { name: string; isDir: boolean; size: number }>;
}

const EMPTY: DirIndex = { dir: '', names: [], lower: new Map() };

export class FsProbe {
  readonly root: string;
  private cache = new Map<string, DirIndex>();

  constructor(root: string) {
    this.root = root;
  }

  /** Lists a directory relative to the root, memoised. Missing dirs read as empty. */
  list(rel = ''): DirIndex {
    const key = rel.replace(/\\/g, '/').toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    const abs = rel ? path.join(this.root, rel) : this.root;
    let index: DirIndex;
    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const lower = new Map<string, { name: string; isDir: boolean; size: number }>();
      const names: string[] = [];
      for (const e of entries) {
        names.push(e.name);
        let size = 0;
        if (e.isFile()) {
          try {
            size = fs.statSync(path.join(abs, e.name)).size;
          } catch {
            size = 0;
          }
        }
        lower.set(e.name.toLowerCase(), { name: e.name, isDir: e.isDirectory(), size });
      }
      index = { dir: abs, names, lower };
    } catch {
      index = { ...EMPTY, dir: abs };
    }
    this.cache.set(key, index);
    return index;
  }

  /** Case-insensitive existence check for a relative path (`a/b/c`). */
  has(rel: string): boolean {
    return this.stat(rel) !== undefined;
  }

  hasFile(rel: string): boolean {
    return this.stat(rel)?.isDir === false;
  }

  hasDir(rel: string): boolean {
    return this.stat(rel)?.isDir === true;
  }

  stat(rel: string): { name: string; isDir: boolean; size: number } | undefined {
    const parts = rel.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0) return { name: '', isDir: true, size: 0 };
    const parent = parts.slice(0, -1).join('/');
    const leaf = parts[parts.length - 1]!;
    return this.list(parent).lower.get(leaf.toLowerCase());
  }

  /** Resolves a relative path to its real on-disk casing, or undefined. */
  real(rel: string): string | undefined {
    const parts = rel.split(/[\\/]/).filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = this.list(out.join('/')).lower.get(parts[i]!.toLowerCase());
      if (!entry) return undefined;
      out.push(entry.name);
    }
    return path.join(this.root, ...out);
  }

  namesIn(rel = ''): string[] {
    return this.list(rel).names;
  }

  filesWithExt(rel: string, ext: string): string[] {
    const lower = ext.toLowerCase();
    return this.list(rel).names.filter((n) => n.toLowerCase().endsWith(lower));
  }

  /** Reads at most `bytes` from the head of a file; returns an empty buffer on failure. */
  head(rel: string, bytes: number): Buffer {
    const abs = this.real(rel);
    if (!abs) return Buffer.alloc(0);
    let fd: number | undefined;
    try {
      fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, read);
    } catch {
      return Buffer.alloc(0);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  readText(rel: string, maxBytes = 1024 * 512): string {
    return this.head(rel, maxBytes).toString('utf8');
  }
}

/** Glob with `*` only (no `**`), anchored, case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesGlob(name: string, glob: string): boolean {
  return globToRegExp(glob).test(name);
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursive size, capped so a scan never walks a 200 GB folder to the end. */
export function dirSize(dir: string, capBytes = 8 * 1024 * 1024 * 1024): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total < capBytes) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}



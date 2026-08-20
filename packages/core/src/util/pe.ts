import type { Arch } from '../types.ts';
import type { FsProbe } from './fsx.ts';

const MACHINE: Record<number, Arch> = {
  0x014c: 'x86',
  0x8664: 'x64',
  0xaa64: 'arm64',
};

/**
 * Reads the COFF machine type out of a PE image. This is how IndieDeck decides
 * between the x86 and x64 build of a loader: guessing from folder names is
 * wrong often enough to matter (plenty of 32-bit Unity games ship in a folder
 * named x64 and vice versa).
 */
export function peArchFromBuffer(buf: Buffer): Arch {
  if (buf.length < 0x40) return 'unknown';
  if (buf.readUInt16LE(0) !== 0x5a4d) return 'unknown'; // 'MZ'
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 6 > buf.length) return 'unknown';
  if (buf.readUInt32LE(peOffset) !== 0x00004550) return 'unknown'; // 'PE\0\0'
  return MACHINE[buf.readUInt16LE(peOffset + 4)] ?? 'unknown';
}

export function peArch(probe: FsProbe, rel: string): Arch {
  return peArchFromBuffer(probe.head(rel, 4096));
}

/**
 * Best-effort product/file version pulled from a PE resource section.
 * Rather than walking the resource directory tree, this scans the UTF-16
 * string table for the `FileVersion` / `ProductVersion` keys, which is what
 * VS_VERSIONINFO stores them as. Returns undefined when nothing looks sane.
 */
export function peVersionString(probe: FsProbe, rel: string, maxBytes = 6 * 1024 * 1024): string | undefined {
  const buf = probe.head(rel, maxBytes);
  if (buf.length === 0) return undefined;
  const text = buf.toString('utf16le');
  for (const key of ['ProductVersion', 'FileVersion']) {
    const idx = text.indexOf(key);
    if (idx < 0) continue;
    const window = text.slice(idx + key.length, idx + key.length + 64);
    const m = /(\d+(?:\.\d+){1,3}[a-z]?\d*)/i.exec(window);
    if (m) return m[1];
  }
  return undefined;
}

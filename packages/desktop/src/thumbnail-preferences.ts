import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Legacy numeric Steam ids stay readable; GOG stores only a product id and
// validated image hash, never an arbitrary URL or local filesystem path.
function validSelection(value: unknown): value is string {
  return typeof value === 'string' && (/^[1-9]\d{0,9}$/.test(value) || /^gog:[1-9]\d{0,19}:[0-9a-f]{64}$/.test(value));
}

/** Only opaque game ids and validated provider identifiers are persisted. */
export async function readThumbnailPreferences(dataDir: string): Promise<Map<string, string>> {
  const file = path.join(dataDir, 'thumbnail-preferences.json');
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid thumbnail preferences file.');
  const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid thumbnail preferences file.');
  const entries = Object.entries(parsed);
  if (entries.length > 20000 || entries.some(([id, app]) => !/^[0-9a-f]{16}$/.test(id) || !validSelection(app))) {
    throw new Error('Invalid thumbnail preferences file.');
  }
  return new Map(entries as [string, string][]);
}

export async function saveThumbnailPreference(dataDir: string, gameId: string, appId: string): Promise<void> {
  if (!/^[0-9a-f]{16}$/.test(gameId) || !validSelection(appId)) throw new Error('Invalid thumbnail selection.');
  await fs.mkdir(dataDir, { recursive: true });
  const existing = await readThumbnailPreferences(dataDir);
  if (!existing.has(gameId) && existing.size >= 20000) throw new Error('Thumbnail preferences are full.');
  existing.set(gameId, appId);
  const serialized = JSON.stringify(Object.fromEntries(existing), null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) throw new Error('Thumbnail preferences are full.');
  const target = path.join(dataDir, 'thumbnail-preferences.json');
  const temporary = path.join(dataDir, `.thumbnail-preferences.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, serialized, { flag: 'wx' });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

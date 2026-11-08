import crypto from 'node:crypto';
import type { GogCoverCandidate } from './thumbnails.ts';

export interface GogSearchGrant { readonly generation: string; readonly hash: string }
interface SearchRecord { generation: string; completed: boolean; results: Map<string, string> }

/** Main-owned, bounded search authority. A renderer only receives product
 * names and IDs; the validated image hash never crosses the IPC boundary. */
export function createGogSearchAuthority(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid GOG search limit.');
  const records = new Map<string, SearchRecord>();
  function begin(gameId: string): string {
    if (typeof gameId !== 'string' || !/^[0-9a-f]{16}$/.test(gameId)) throw new Error('Invalid game id.');
    records.delete(gameId);
    while (records.size >= limit) records.delete(records.keys().next().value!);
    const generation = crypto.randomUUID();
    records.set(gameId, { generation, completed: false, results: new Map() });
    return generation;
  }
  function complete(gameId: string, generation: string, candidates: GogCoverCandidate[]): { id: string; name: string }[] {
    const record = records.get(gameId);
    if (!record || record.generation !== generation || record.completed || !Array.isArray(candidates)) return [];
    record.completed = true;
    const visible: { id: string; name: string }[] = [];
    for (const entry of candidates.slice(0, 30)) {
      if (!entry || typeof entry.id !== 'string' || !/^[1-9]\d{0,19}$/.test(entry.id) ||
          typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(entry.name) ||
          typeof entry.imageHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.imageHash) || record.results.has(entry.id)) continue;
      record.results.set(entry.id, entry.imageHash);
      visible.push({ id: entry.id, name: entry.name });
      if (visible.length >= 10) break;
    }
    return visible;
  }
  function grant(gameId: string, id: unknown): GogSearchGrant | undefined {
    const record = records.get(gameId);
    const hash = typeof id === 'string' ? record?.results.get(id) : undefined;
    return record && hash ? { generation: record.generation, hash } : undefined;
  }
  function isCurrent(gameId: string, id: string, authorization: GogSearchGrant): boolean {
    const record = records.get(gameId);
    return Boolean(record && record.generation === authorization.generation && record.results.get(id) === authorization.hash);
  }
  return { begin, complete, grant, isCurrent };
}

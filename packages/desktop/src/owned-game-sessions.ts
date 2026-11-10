export interface OwnedGameSession { gameId: string; status: 'starting' | 'running'; startedAt?: string }
export interface OwnedGameSessionsSnapshot { revision: number; sessions: OwnedGameSession[] }
export interface OwnedGameSessionsOptions {
  onChange?: (snapshot: OwnedGameSessionsSnapshot) => void;
  now?: () => Date;
}

/** Only describes child processes created by this launcher. A root executable
 * can hand off to an unobserved process, so this is not global gameplay detection.
 * No process enumeration, scheduling changes, PIDs or paths are exposed. */
export function createOwnedGameSessions(options: OwnedGameSessionsOptions = {}) {
  const sessions = new Map<string, OwnedGameSession & { token: number }>();
  let token = 0, revision = 0;
  const snapshot = (): OwnedGameSessionsSnapshot => ({ revision,
    sessions: [...sessions.values()].map(({ token: _token, ...session }) => ({ ...session })) });
  const publish = () => { revision += 1; try { options.onChange?.(snapshot()); } catch { /* Observers have no lifecycle authority. */ } };
  return {
    snapshot,
    has(gameId: string): boolean { return sessions.has(gameId); },
    reserve(gameId: string): number {
      if (typeof gameId !== 'string' || !/^[0-9a-f]{16}$/.test(gameId)) throw new Error('ui.gaming.error.invalidGame');
      if (sessions.has(gameId)) throw new Error('ui.gaming.error.alreadyRunning');
      if (sessions.size >= 100) throw new Error('ui.gaming.error.sessionLimit');
      const next = ++token;
      sessions.set(gameId, { gameId, token: next, status: 'starting' }); publish(); return next;
    },
    started(gameId: string, expectedToken: number): boolean {
      const current = sessions.get(gameId);
      if (!current || current.token !== expectedToken || current.status !== 'starting') return false;
      current.status = 'running'; current.startedAt = (options.now?.() ?? new Date()).toISOString(); publish(); return true;
    },
    finish(gameId: string, expectedToken: number): boolean {
      if (sessions.get(gameId)?.token !== expectedToken) return false;
      sessions.delete(gameId); publish(); return true;
    },
  };
}

/** Pause only optional launcher activity while its window is hidden and an
 * owned game child is running. Explicit user work and mandatory scans retain
 * their existing lifecycle; no game/foreign-process priority is changed. */
export function shouldDeferBackgroundWork(snapshot: OwnedGameSessionsSnapshot, windowVisible: boolean): boolean {
  return windowVisible === false && snapshot.sessions.some(session => session.status === 'running');
}

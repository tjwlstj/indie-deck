export type LaunchDiagnostic =
  | { kind: 'spawn-failed'; at: string }
  | { kind: 'nonzero-exit'; at: string; code: number };

/** Session-only evidence from children started by this launcher. Never holds
 * paths, process IDs, output, logs, or handles to unrelated processes. */
export function createLaunchDiagnostics(onChange: (gameId: string, value: LaunchDiagnostic | null) => void = () => {}) {
  const entries = new Map<string, { token: number; result: LaunchDiagnostic | null }>();
  let sequence = 0;
  const publish = (gameId: string, token: number, result: LaunchDiagnostic | null) => {
    const entry = entries.get(gameId);
    if (!entry || entry.token !== token) return;
    entry.result = result;
    try { onChange(gameId, result ? { ...result } : null); } catch { /* Observers cannot affect the game. */ }
  };
  return {
    begin(gameId: string): number {
      entries.delete(gameId);
      while (entries.size >= 100) entries.delete(entries.keys().next().value!);
      const token = ++sequence;
      entries.set(gameId, { token, result: null });
      publish(gameId, token, null);
      return token;
    },
    failed(gameId: string, token: number): void {
      publish(gameId, token, { kind: 'spawn-failed', at: new Date().toISOString() });
    },
    exited(gameId: string, token: number, code: number | null): void {
      publish(gameId, token, Number.isSafeInteger(code) && code !== 0
        ? { kind: 'nonzero-exit', at: new Date().toISOString(), code: code! } : null);
    },
    get(gameId: string): LaunchDiagnostic | null {
      const value = entries.get(gameId)?.result;
      return value ? { ...value } : null;
    },
  };
}

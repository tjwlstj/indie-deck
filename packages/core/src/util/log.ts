export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  level: LogLevel;
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  child(prefix: string): Logger;
}

export function createLogger(level: LogLevel = 'info', prefix = ''): Logger {
  const emit = (at: LogLevel, stream: 'out' | 'err', msg: string, rest: unknown[]) => {
    if (RANK[at] < RANK[level]) return;
    const line = `${prefix ? `${prefix} ` : ''}${msg}`;
    if (stream === 'err') console.error(line, ...rest);
    else console.log(line, ...rest);
  };
  return {
    level,
    debug: (m, ...r) => emit('debug', 'out', m, r),
    info: (m, ...r) => emit('info', 'out', m, r),
    warn: (m, ...r) => emit('warn', 'err', m, r),
    error: (m, ...r) => emit('error', 'err', m, r),
    child: (p: string) => createLogger(level, `${prefix}${p}`),
  };
}

export const silentLogger: Logger = createLogger('silent');

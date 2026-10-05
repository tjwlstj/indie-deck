/** User-driven launcher updates. Renderer callers never supply a feed URL or executable. */
export const LAUNCHER_RELEASE_URL = 'https://github.com/tjwlstj/indie-deck/releases/latest';

export type LauncherUpdateMode = 'installed' | 'portable' | 'development' | 'disabled';
export type LauncherUpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'manual' | 'disabled';
export interface LauncherUpdateProgress { percent: number; transferred: number; total?: number; bytesPerSecond?: number }
export interface LauncherUpdateSnapshot {
  seq: number;
  status: LauncherUpdateStatus;
  mode: LauncherUpdateMode;
  supported: boolean;
  currentVersion: string;
  releaseUrl: string;
  availableVersion?: string;
  downloadedVersion?: string;
  progress?: LauncherUpdateProgress;
  reasonKey?: string;
  errorKey?: string;
  /** Fixed bounded category summary; never raw provider messages, paths, tokens or URLs. */
  error?: string;
}
export interface LauncherUpdater {
  autoDownload?: boolean;
  autoInstallOnAppQuit?: boolean;
  autoRunAppAfterInstall?: boolean;
  allowPrerelease?: boolean;
  allowDowngrade?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}
export interface LauncherUpdateOptions {
  currentVersion: string;
  mode?: LauncherUpdateMode;
  supported?: boolean;
  onChange?: (snapshot: LauncherUpdateSnapshot) => void;
  /** Game mutations, not this controller's own restart reservation. */
  isBusy: () => boolean;
  isShutdownSafe?: () => boolean;
  /** Synchronously reserve the main-process shutdown gate. Must return true only after reserving it. */
  reserveInstall?: () => boolean;
  /** Undo that gate only if quitAndInstall throws or the final safety check fails. */
  releaseInstallReservation?: () => void;
}
export interface LauncherUpdateController {
  snapshot(): LauncherUpdateSnapshot;
  check(): Promise<LauncherUpdateSnapshot>;
  download(): Promise<LauncherUpdateSnapshot>;
  install(): LauncherUpdateSnapshot;
  dispose(): void;
}

const PREFIX = 'ui.update.reason.';
const ERROR_PREFIX = 'ui.update.error.';
const errorCode = (reason: string) => ({ notAvailable: 'unavailable', notDownloaded: 'unavailable', restartUnsafe: 'reservation', disabled: 'disposed', unknown: 'generic' } as Record<string, string>)[reason] ?? reason;
const fail = (reason: string): never => { throw new Error(ERROR_PREFIX + errorCode(reason)); };
type Version = { text: string; numbers: [number, number, number] };
function version(value: unknown): Version | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return undefined;
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  return numbers.every(Number.isSafeInteger) ? { text: value, numbers } : undefined;
}
function newer(candidate: Version, current: Version): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (candidate.numbers[index] !== current.numbers[index]) return candidate.numbers[index]! > current.numbers[index]!;
  }
  return false;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function infoVersion(info: unknown): unknown { return object(info)?.['version']; }

/** Categorise privately. Arbitrary updater exception text is never forwarded to the renderer. */
function safeError(error: unknown): { errorKey: string; error: string } {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const explicit = text.startsWith(ERROR_PREFIX) ? text.slice(ERROR_PREFIX.length) : undefined;
  const reason = explicit && ['check', 'download', 'install', 'unavailable', 'busy', 'disposed', 'reservation', 'invalidVersion', 'network', 'integrity', 'permission', 'cancelled', 'downloadIncomplete', 'generic'].includes(explicit)
    ? explicit
    : /sha512|checksum|signature|certificate|integrity/i.test(text) ? 'integrity'
      : /eacces|eperm|permission|access denied/i.test(text) ? 'permission'
        : /cancel|abort/i.test(text) ? 'cancelled'
          : /network|enotfound|econn|timed? ?out|http|fetch|socket/i.test(text) ? 'network' : 'generic';
  return { errorKey: ERROR_PREFIX + reason, error: `Launcher update failed (${reason}).` };
}
function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : undefined;
}
function progress(value: unknown, previous?: LauncherUpdateProgress): LauncherUpdateProgress | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const percent = numeric(raw['percent']), transferred = numeric(raw['transferred']);
  if (percent === undefined || transferred === undefined) return undefined;
  const total = numeric(raw['total']), speed = numeric(raw['bytesPerSecond']);
  return {
    percent: Math.max(previous?.percent ?? 0, Math.min(percent, 100)),
    transferred: Math.max(previous?.transferred ?? 0, Math.floor(transferred)),
    ...(total === undefined ? previous?.total === undefined ? {} : { total: previous.total } : { total: Math.floor(total) }),
    ...(speed === undefined ? {} : { bytesPerSecond: Math.floor(speed) }),
  };
}

type CheckAttempt = { kind: 'check'; outcome?: 'available' | 'up-to-date'; advertised?: unknown; error?: unknown };
type DownloadAttempt = { kind: 'download'; version: string; downloaded: boolean; error?: unknown };

export function createLauncherUpdateController(updater: LauncherUpdater, options: LauncherUpdateOptions): LauncherUpdateController {
  // These policies are set even for disabled/manual modes so an earlier caller
  // cannot leave automatic installation armed behind a disabled settings page.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  const current = version(options.currentVersion);
  const mode = options.mode ?? (options.supported === false ? 'disabled' : 'installed');
  const supported = mode === 'installed' && options.supported !== false && Boolean(current);
  const reasonKey = !current ? PREFIX + 'unsupported'
    : mode !== 'installed' ? PREFIX + mode
      : options.supported === false ? PREFIX + 'unsupported' : undefined;
  let state: LauncherUpdateSnapshot = {
    seq: 0, status: supported ? 'idle' : mode === 'portable' || mode === 'development' ? 'manual' : 'disabled',
    mode, supported, currentVersion: current?.text ?? '', releaseUrl: LAUNCHER_RELEASE_URL,
    ...(reasonKey ? { reasonKey } : {}),
    ...(!current ? { errorKey: ERROR_PREFIX + 'invalidVersion' } : {}),
  };
  let disposed = false;
  let active: CheckAttempt | DownloadAttempt | undefined;
  let checking: Promise<LauncherUpdateSnapshot> | undefined;
  let downloading: Promise<LauncherUpdateSnapshot> | undefined;
  let installReserved = false;
  const listeners: [string, (...args: unknown[]) => void][] = [];
  const snapshot = (): LauncherUpdateSnapshot => ({ ...state, ...(state.progress ? { progress: { ...state.progress } } : {}) });
  const publish = (next: Omit<LauncherUpdateSnapshot, 'seq'>): void => {
    if (disposed || JSON.stringify({ ...state, seq: undefined }) === JSON.stringify({ ...next, seq: undefined })) return;
    state = { ...next, seq: state.seq + 1 };
    try { options.onChange?.(snapshot()); } catch { /* observers are not lifecycle authority */ }
  };
  const transition = (status: LauncherUpdateStatus, values: Partial<LauncherUpdateSnapshot> = {}) => {
    const { error: _error, errorKey: _errorKey, reasonKey: _reason, progress: _progress, ...previous } = state;
    publish({ ...previous, status, ...values });
  };
  const errorState = (error: unknown) => transition('error', safeError(error));
  const usable = () => {
    if (disposed) fail('disabled');
    if (!supported) throw new Error(state.reasonKey ?? PREFIX + 'unsupported');
    if (state.status === 'installing') fail('busy');
  };
  const listen = (event: string, fn: (...args: unknown[]) => void) => { updater.on(event, fn); listeners.push([event, fn]); };
  listen('update-available', (info) => {
    if (disposed || active?.kind !== 'check') return;
    active.outcome = 'available'; active.advertised = infoVersion(info);
  });
  listen('update-not-available', (info) => {
    if (disposed || active?.kind !== 'check') return;
    active.outcome = 'up-to-date'; active.advertised = infoVersion(info);
  });
  listen('download-progress', (info) => {
    if (disposed || active?.kind !== 'download' || active.error) return;
    const next = progress(info, state.progress);
    if (next) transition('downloading', { progress: next });
  });
  listen('update-downloaded', (info) => {
    if (disposed || active?.kind !== 'download') return;
    const downloaded = version(infoVersion(info));
    if (!downloaded || downloaded.text !== active.version) active.error = new Error(ERROR_PREFIX + 'invalidVersion');
    else active.downloaded = true;
  });
  // Keep an error listener attached to consume EventEmitter's special error event,
  // but ignore unsolicited or late errors from a completed updater action.
  listen('error', (error) => {
    if (disposed) return;
    if (state.status === 'installing' && installReserved) {
      installReserved = false;
      try { options.releaseInstallReservation?.(); } catch { /* root may keep a failed reservation gated */ }
      errorState(error);
    } else if (active) active.error = error;
  });

  const check = (): Promise<LauncherUpdateSnapshot> => {
    try { usable(); } catch (error) { return Promise.reject(error); }
    if (checking) return checking;
    if (downloading) return Promise.reject(new Error(ERROR_PREFIX + 'busy'));
    const attempt: CheckAttempt = { kind: 'check' };
    active = attempt;
    const request = Promise.resolve().then(() => updater.checkForUpdates()).then((result) => {
      if (disposed || active !== attempt) return snapshot();
      if (attempt.error) throw attempt.error;
      const raw = object(result);
      const info = object(raw?.['updateInfo']);
      // The check's own promise result wins over event hints, so a replayed late
      // event cannot replace the version returned by the current native check.
      const supplied = info ? info['version'] : attempt.advertised;
      const advertised = supplied === undefined ? undefined : version(supplied);
      if (supplied !== undefined && !advertised) fail('invalidVersion');
      const availability = typeof raw?.['isUpdateAvailable'] === 'boolean'
        ? raw['isUpdateAvailable'] : attempt.outcome === 'available';
      if (availability) {
        if (!advertised || !newer(advertised, current!)) fail('invalidVersion');
        transition('available', { availableVersion: advertised!.text, downloadedVersion: undefined });
      } else {
        if (!raw && !attempt.outcome) fail('unknown');
        transition('up-to-date', { availableVersion: undefined, downloadedVersion: undefined });
      }
      return snapshot();
    }).catch((error: unknown) => {
      if (!disposed && active === attempt) errorState(error);
      throw new Error(safeError(error).errorKey);
    }).finally(() => {
      if (active === attempt) active = undefined;
      if (checking === request) checking = undefined;
    });
    checking = request;
    transition('checking');
    return request;
  };

  const download = (): Promise<LauncherUpdateSnapshot> => {
    try { usable(); } catch (error) { return Promise.reject(error); }
    if (downloading) return downloading;
    if (checking) return Promise.reject(new Error(ERROR_PREFIX + 'busy'));
    const target = version(state.availableVersion);
    if (!target || !newer(target, current!)) return Promise.reject(new Error(ERROR_PREFIX + 'unavailable'));
    if (state.downloadedVersion === target.text) return Promise.resolve(snapshot());
    const attempt: DownloadAttempt = { kind: 'download', version: target.text, downloaded: false };
    active = attempt;
    const request = Promise.resolve().then(() => updater.downloadUpdate()).then(() => {
      if (disposed || active !== attempt) return snapshot();
      if (attempt.error) throw attempt.error;
      if (!attempt.downloaded) fail('downloadIncomplete');
      transition('downloaded', { downloadedVersion: target.text, progress: { ...(state.progress ?? { transferred: 0 }), percent: 100 } });
      return snapshot();
    }).catch((error: unknown) => {
      if (!disposed && active === attempt) errorState(error);
      throw new Error(safeError(error).errorKey);
    }).finally(() => {
      if (active === attempt) active = undefined;
      if (downloading === request) downloading = undefined;
    });
    downloading = request;
    transition('downloading', { progress: { percent: 0, transferred: 0 } });
    return request;
  };

  const install = (): LauncherUpdateSnapshot => {
    usable();
    if (checking || downloading || active) fail('busy');
    const downloaded = version(state.downloadedVersion);
    if (!downloaded || downloaded.text !== state.availableVersion || !newer(downloaded, current!)) fail('notDownloaded');
    if (options.isBusy() || options.isShutdownSafe?.() === false) fail('busy');
    const reserve = options.reserveInstall;
    if (!reserve) fail('restartUnsafe');
    let reserved = false;
    try {
      reserved = reserve!();
      if (!reserved) fail('busy');
      installReserved = true;
      // Reservation happens synchronously BEFORE observer/UI publication. Root
      // must reject any new game writes from this point through application quit.
      if (options.isBusy() || options.isShutdownSafe?.() === false) fail('busy');
      transition('installing');
      if (options.isBusy() || options.isShutdownSafe?.() === false) fail('busy');
      updater.quitAndInstall(false, true);
      if (state.status !== 'installing') throw new Error(state.errorKey ?? ERROR_PREFIX + 'install');
      return snapshot();
    } catch (error) {
      if (reserved && installReserved) {
        installReserved = false;
        try { options.releaseInstallReservation?.(); } catch { /* fail closed in root gate */ }
      }
      if ((error as Error).message === ERROR_PREFIX + 'busy') transition('downloaded', { errorKey: ERROR_PREFIX + 'busy' });
      else errorState(error);
      throw new Error(safeError(error).errorKey);
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    active = undefined;
    for (const [event, listener] of listeners) updater.removeListener?.(event, listener);
  };
  return { snapshot, check, download, install, dispose };
}

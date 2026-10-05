/** Launcher update state only. Release URL, download and quit authority stay in main. */
const statuses = new Set([
  'idle', 'checking', 'available', 'up-to-date', 'downloading', 'downloaded',
  'installing', 'error', 'manual', 'disabled',
]);
const modes = new Set(['installed', 'portable', 'development', 'disabled']);

/** Display guard only; main independently validates release and install authority. */
export function isNewerLauncherVersion(candidate, current) {
  const parse = (value) => {
    if (typeof value !== 'string') return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) return null;
    const parts = match.slice(1, 4).map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const next = parse(candidate), installed = parse(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

export function reduceLauncherUpdateStatus(previous, incoming) {
  if (!incoming || !Number.isSafeInteger(incoming.seq) || incoming.seq < 0 ||
      !statuses.has(incoming.status) || !modes.has(incoming.mode)) return previous;
  if (Number.isSafeInteger(previous?.seq) && incoming.seq <= previous.seq) return previous;
  return { ...incoming, ...(incoming.progress ? { progress: { ...incoming.progress } } : {}) };
}

export function launcherUpdateInstallPending(snapshot, action) {
  return action === 'install' || snapshot?.status === 'installing';
}

export function launcherUpdatePresentation(snapshot, { mutationBlocked = false, action = null, readPending = false, readError = false } = {}) {
  const supported = snapshot?.mode === 'installed' && snapshot?.supported === true;
  const inFlight = Boolean(action) || readPending || ['checking', 'downloading', 'installing'].includes(snapshot?.status);
  return {
    supported,
    manual: Boolean(snapshot && !supported),
    canCheck: supported && !inFlight && !readError && ['idle', 'up-to-date', 'available', 'error'].includes(snapshot.status),
    canDownload: supported && !inFlight && !readError && ['available', 'error'].includes(snapshot.status) &&
      isNewerLauncherVersion(snapshot.availableVersion, snapshot.currentVersion) && snapshot.downloadedVersion !== snapshot.availableVersion,
    canInstall: supported && !inFlight && !readError && !mutationBlocked && ['downloaded', 'error'].includes(snapshot.status) &&
      snapshot.downloadedVersion === snapshot.availableVersion && isNewerLauncherVersion(snapshot.downloadedVersion, snapshot.currentVersion),
    installPending: launcherUpdateInstallPending(snapshot, action),
    // Neither an available release nor a successful download means installation.
    installedVersion: snapshot?.currentVersion,
  };
}

export function beginLauncherUpdateStatusRequest(state) {
  state.updateStatusRequestToken = (state.updateStatusRequestToken ?? 0) + 1;
  state.updateStatusLoading = true;
  state.updateReadError = false;
  return state.updateStatusRequestToken;
}

export function applyLauncherUpdateStatus(state, incoming) {
  const next = reduceLauncherUpdateStatus(state.updateStatus, incoming);
  if (next === state.updateStatus) return false;
  state.updateStatus = next;
  // A live event invalidates an older current() read, including its error path.
  state.updateStatusRequestToken = (state.updateStatusRequestToken ?? 0) + 1;
  state.updateStatusLoading = false;
  state.updateReadError = false;
  return true;
}

export function acceptLauncherUpdateStatusResponse(state, token, incoming) {
  if (token !== state.updateStatusRequestToken) return false;
  state.updateStatusLoading = false;
  const next = reduceLauncherUpdateStatus(state.updateStatus, incoming);
  if (next === state.updateStatus && !state.updateStatus) {
    state.updateReadError = true;
    return false;
  }
  state.updateReadError = false;
  state.updateStatus = next;
  return true;
}

export function failLauncherUpdateStatusRequest(state, token) {
  if (token !== state.updateStatusRequestToken) return false;
  state.updateStatusLoading = false;
  state.updateReadError = true;
  return true;
}

export function captureLauncherUpdateInstall(snapshot) {
  if (!launcherUpdatePresentation(snapshot).canInstall) return null;
  return { downloadedVersion: snapshot.downloadedVersion, currentVersion: snapshot.currentVersion };
}

export function canConfirmLauncherUpdateInstall(snapshot, captured, options = {}) {
  return Boolean(captured && launcherUpdatePresentation(snapshot, options).canInstall &&
    snapshot.downloadedVersion === captured.downloadedVersion && snapshot.currentVersion === captured.currentVersion);
}

import { $, el, setStatus } from '../dom.js';
import { t } from '../i18n.js';
import { api, emit, mutationBlocked, state } from '../store.js';
import {
  acceptLauncherUpdateStatusResponse, applyLauncherUpdateStatus, beginLauncherUpdateStatusRequest,
  canConfirmLauncherUpdateInstall, captureLauncherUpdateInstall, failLauncherUpdateStatusRequest,
  launcherUpdateInstallPending, launcherUpdatePresentation,
} from '../update-model.js';

function presentation() {
  return launcherUpdatePresentation(state.updateStatus, {
    mutationBlocked: mutationBlocked(), action: state.updateAction,
    readPending: state.updateStatusLoading, readError: state.updateReadError,
  });
}

function localizedUpdateError(error, fallbackKey = 'ui.update.error.generic') {
  const key = typeof error === 'string' ? error : error?.message;
  return t(/^ui\.update\.error\.[A-Za-z]+$/.test(key ?? '') ? key : fallbackKey);
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function statusText(snapshot) {
  if (!snapshot) return t('ui.update.loading', undefined, 'Reading launcher update status…');
  return t(`ui.update.status.${snapshot.status}`, undefined, snapshot.status);
}

function acceptStatus(snapshot) {
  const wasReserved = launcherUpdateInstallPending(state.updateStatus, state.updateAction);
  if (!applyLauncherUpdateStatus(state, snapshot)) return;
  if (snapshot.status === 'available') setStatus(t('ui.update.availableNotice', { version: snapshot.availableVersion }, 'IndieDeck {version} is available. Open settings to review the update.'));
  else if (snapshot.status === 'downloaded') setStatus(t('ui.update.downloadedNotice', { version: snapshot.downloadedVersion }, 'IndieDeck {version} is downloaded. Restart from settings when ready.'), 'ok');
  else if (snapshot.status === 'error') setStatus(localizedUpdateError(snapshot.errorKey ?? snapshot.error), 'err');
  emit(wasReserved !== launcherUpdateInstallPending(state.updateStatus, state.updateAction) ? 'all' : 'updates');
}

/** Live events subscribe before current() so reload never misses a download state. */
export function bindLauncherUpdateEvents() {
  if (!api.updates?.onStatus) {
    state.updateReadError = true;
    return;
  }
  api.updates.onStatus(acceptStatus);
}

export async function refreshLauncherUpdateStatus() {
  const token = beginLauncherUpdateStatusRequest(state);
  renderLauncherUpdates();
  try {
    if (!api.updates?.current) throw new Error('ui.update.error.unavailable');
    const snapshot = await api.updates.current();
    const wasReserved = launcherUpdateInstallPending(state.updateStatus, state.updateAction);
    if (acceptLauncherUpdateStatusResponse(state, token, snapshot)) {
      emit(wasReserved !== launcherUpdateInstallPending(state.updateStatus, state.updateAction) ? 'all' : 'updates');
    }
    else renderLauncherUpdates();
  } catch (error) {
    if (failLauncherUpdateStatusRequest(state, token)) {
      setStatus(localizedUpdateError(error, 'ui.update.error.unavailable'), 'err');
      emit('updates');
    }
  }
}

async function runUpdateAction(kind) {
  const display = presentation();
  if (!(kind === 'check' ? display.canCheck : kind === 'download' ? display.canDownload : kind === 'install' ? display.canInstall : false)) return;
  // Set install reservation before awaiting IPC so a same-frame game action
  // cannot start between the confirmation click and main's install reservation.
  state.updateAction = kind;
  setStatus(t(`ui.update.status.${kind === 'check' ? 'checking' : kind === 'download' ? 'downloading' : 'installing'}`));
  emit(kind === 'install' ? 'all' : 'updates');
  try {
    const snapshot = await api.updates[kind]();
    if (snapshot) acceptStatus(snapshot);
  } catch (error) {
    setStatus(localizedUpdateError(error, `ui.update.error.${kind}`), 'err');
  } finally {
    state.updateAction = null;
    await refreshLauncherUpdateStatus();
    emit(kind === 'install' ? 'all' : 'updates');
  }
}

function confirmInstall() {
  const captured = captureLauncherUpdateInstall(state.updateStatus);
  if (!captured || !presentation().canInstall) return;
  document.getElementById('launcherUpdateConfirm')?.remove();
  const dialog = el('dialog', 'launcher-update-confirm maintenance-confirm');
  dialog.id = 'launcherUpdateConfirm';
  const heading = el('h2', null, t('ui.update.confirmTitle', undefined, 'Restart to install the launcher update?'));
  heading.id = 'launcherUpdateConfirmTitle';
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(heading,
    el('p', null, t('ui.update.confirmVersion', { current: captured.currentVersion, next: captured.downloadedVersion }, 'IndieDeck {current} → {next}')),
    el('p', 'update-help', t('ui.update.confirmBody', undefined, 'IndieDeck will close and launch its update installer. Your games and launcher data are kept. Finish all game file operations first.')),
  );
  const actions = el('div', 'update-actions');
  const cancel = el('button', 'ghost', t('ui.update.cancel', undefined, 'Cancel'));
  cancel.addEventListener('click', () => dialog.close());
  const confirm = el('button', 'primary update-confirm', t('ui.update.install', undefined, 'Restart and install'));
  confirm.addEventListener('click', () => {
    if (!canConfirmLauncherUpdateInstall(state.updateStatus, captured, {
      mutationBlocked: mutationBlocked(), action: state.updateAction,
      readPending: state.updateStatusLoading, readError: state.updateReadError,
    })) {
      setStatus(t('ui.update.error.busy'), 'err');
      dialog.close();
      return;
    }
    dialog.close();
    void runUpdateAction('install');
  });
  actions.append(cancel, confirm);
  dialog.append(actions);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}

export function renderLauncherUpdates() {
  const body = $('launcherUpdatesBody');
  if (!body) return;
  body.replaceChildren();
  const snapshot = state.updateStatus;
  const display = presentation();
  const card = el('section', `launcher-update-card ${snapshot?.status ?? 'loading'}`);
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const currentVersion = snapshot?.currentVersion || state.appInfo.version;
  if (currentVersion) card.append(el('p', 'update-version', t('ui.update.currentVersion', { version: currentVersion }, 'Current launcher: {version}')));
  card.append(el('strong', 'update-status', statusText(snapshot)));
  if (snapshot?.availableVersion) card.append(el('p', 'update-version', t('ui.update.availableVersion', { version: snapshot.availableVersion }, 'Available: {version}')));
  if (snapshot?.downloadedVersion) card.append(el('p', 'update-version', t('ui.update.downloadedVersion', { version: snapshot.downloadedVersion }, 'Downloaded: {version} (not installed yet)')));
  if (snapshot?.reasonKey) card.append(el('p', 'update-warning', t(snapshot.reasonKey)));
  if (snapshot?.errorKey || snapshot?.error) card.append(el('p', 'update-warning', localizedUpdateError(snapshot.errorKey ?? snapshot.error)));
  if (state.updateReadError) card.append(el('p', 'update-warning', t('ui.update.error.unavailable')));
  if (snapshot?.status === 'downloading') {
    const progress = el('progress', 'update-progress');
    progress.max = 100;
    const percent = Number(snapshot.progress?.percent);
    if (Number.isFinite(percent)) progress.value = Math.min(100, Math.max(0, percent));
    progress.setAttribute('aria-label', statusText(snapshot));
    card.append(progress);
    const detail = [
      Number.isFinite(percent) ? `${percent.toFixed(1)}%` : '',
      snapshot.progress?.total
        ? `${formatBytes(snapshot.progress.transferred)} / ${formatBytes(snapshot.progress.total)}`
        : formatBytes(snapshot.progress?.transferred),
      snapshot.progress?.bytesPerSecond ? `${formatBytes(snapshot.progress.bytesPerSecond)}/s` : '',
    ].filter(Boolean).join(' · ');
    card.append(el('p', 'plan-sub', detail));
  }
  card.append(el('p', 'update-help', display.supported
    ? t('ui.update.explicitSteps', undefined, 'Updates are checked automatically after startup. Download and restart happen only when you choose them; closing the launcher does not install a pending update.')
    : t('ui.update.manualHelp', undefined, 'Open the official release page and choose the appropriate installer or portable package. This build does not perform in-app updates.')));
  const actions = el('div', 'update-actions');
  if (display.supported) {
    const check = el('button', 'ghost update-check', t('ui.update.check', undefined, 'Check for updates'));
    check.disabled = !display.canCheck;
    check.addEventListener('click', () => void runUpdateAction('check'));
    actions.append(check);
    if (snapshot.status === 'available' || snapshot.status === 'downloading' || display.canDownload) {
      const download = el('button', 'primary update-download', t('ui.update.download', undefined, 'Download update'));
      download.disabled = !display.canDownload;
      download.addEventListener('click', () => void runUpdateAction('download'));
      actions.append(download);
    }
    if (snapshot.status === 'downloaded' || snapshot.status === 'installing' || (snapshot.status === 'error' && snapshot.downloadedVersion)) {
      const install = el('button', 'primary update-install', t('ui.update.install', undefined, 'Restart and install'));
      install.disabled = !display.canInstall;
      install.addEventListener('click', confirmInstall);
      actions.append(install);
      if (mutationBlocked()) card.append(el('p', 'update-warning', t('ui.update.finishTask', undefined, 'Finish the active file operation before restarting.')));
    }
  }
  if (state.updateReadError) {
    const retry = el('button', 'ghost update-retry', t('ui.update.retryStatus', undefined, 'Read status again'));
    retry.disabled = state.updateStatusLoading;
    retry.addEventListener('click', () => void refreshLauncherUpdateStatus());
    actions.append(retry);
  }
  const release = el('button', 'ghost update-release', t('ui.update.openRelease', undefined, 'Official releases'));
  release.disabled = !api.updates?.openRelease;
  release.addEventListener('click', () => void api.updates.openRelease().catch((error) => setStatus(localizedUpdateError(error), 'err')));
  actions.append(release);
  card.append(actions);
  body.append(card);
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptLauncherUpdateStatusResponse, applyLauncherUpdateStatus, beginLauncherUpdateStatusRequest,
  canConfirmLauncherUpdateInstall, captureLauncherUpdateInstall, failLauncherUpdateStatusRequest,
  launcherUpdateInstallPending, launcherUpdatePresentation, reduceLauncherUpdateStatus,
  isNewerLauncherVersion,
} from '../../desktop/renderer/update-model.js';

function snapshot(overrides = {}) {
  return { seq: 1, status: 'idle', mode: 'installed', supported: true, currentVersion: '0.1.2', ...overrides };
}

function rendererState() {
  return { updateStatus: snapshot(), updateStatusRequestToken: 0, updateStatusLoading: false, updateReadError: false };
}

test('launcher update snapshots require known status/mode and monotonic main sequence', () => {
  const current = snapshot({ seq: 4, status: 'downloaded', downloadedVersion: '0.1.3' });
  assert.equal(reduceLauncherUpdateStatus(current, snapshot({ seq: 3, status: 'checking' })), current);
  assert.equal(reduceLauncherUpdateStatus(current, snapshot({ seq: 4, status: 'error' })), current);
  assert.equal(reduceLauncherUpdateStatus(current, snapshot({ seq: 5, status: 'unknown' })), current);
  assert.equal(reduceLauncherUpdateStatus(current, snapshot({ seq: 5, mode: 'unknown' })), current);
  assert.equal(reduceLauncherUpdateStatus(current, snapshot({ seq: Number.NaN })), current);
  assert.equal(reduceLauncherUpdateStatus(current, snapshot({ seq: 5, status: 'installing' })).status, 'installing');
});

test('progress snapshots are copied and availability or download never changes the installed version', () => {
  const incoming = snapshot({ seq: 2, status: 'downloading', availableVersion: '0.1.3', progress: { percent: 20, transferred: 400 } });
  const reduced = reduceLauncherUpdateStatus(snapshot(), incoming);
  incoming.progress.percent = 100;
  assert.equal(reduced.progress.percent, 20);
  assert.equal(launcherUpdatePresentation(reduced).installedVersion, '0.1.2');
  assert.equal(launcherUpdatePresentation(snapshot({ status: 'downloaded', downloadedVersion: '0.1.3' })).installedVersion, '0.1.2');
});

test('only supported installed builds offer in-app update actions', () => {
  assert.equal(launcherUpdatePresentation(snapshot()).canCheck, true);
  for (const mode of ['portable', 'development', 'disabled']) {
    const display = launcherUpdatePresentation(snapshot({ mode, status: 'downloaded', downloadedVersion: '0.1.3' }));
    assert.equal(display.supported, false);
    assert.equal(display.canCheck, false);
    assert.equal(display.canDownload, false);
    assert.equal(display.canInstall, false);
    assert.equal(display.manual, true);
  }
  assert.equal(launcherUpdatePresentation(snapshot({ supported: false })).canCheck, false);
});

test('check and download stay usable during game file tasks but install requires completed download and idle mutations', () => {
  assert.equal(launcherUpdatePresentation(snapshot(), { mutationBlocked: true }).canCheck, true);
  const available = snapshot({ status: 'available', availableVersion: '0.1.3' });
  assert.equal(launcherUpdatePresentation(available, { mutationBlocked: true }).canDownload, true);
  assert.equal(launcherUpdatePresentation(available).canInstall, false);
  const downloaded = snapshot({ status: 'downloaded', availableVersion: '0.1.3', downloadedVersion: '0.1.3' });
  assert.equal(launcherUpdatePresentation(downloaded).canInstall, true);
  assert.equal(launcherUpdatePresentation(downloaded, { mutationBlocked: true }).canInstall, false);
  assert.equal(launcherUpdatePresentation(snapshot({ status: 'available' })).canDownload, false);
  assert.equal(launcherUpdatePresentation(snapshot({ status: 'downloaded' })).canInstall, false);
});

test('install reservation blocks game mutations immediately before IPC while check/download do not', () => {
  assert.equal(launcherUpdateInstallPending(snapshot(), 'install'), true);
  assert.equal(launcherUpdateInstallPending(snapshot({ status: 'installing' }), null), true);
  assert.equal(launcherUpdateInstallPending(snapshot({ status: 'downloading' }), 'download'), false);
  assert.equal(launcherUpdateInstallPending(snapshot({ status: 'checking' }), 'check'), false);
  for (const action of ['check', 'download', 'install']) {
    assert.equal(launcherUpdatePresentation(snapshot(), { action }).canCheck, false);
  }
});

test('a live newer update event invalidates an older current() response and its later error path', () => {
  const state = rendererState();
  const token = beginLauncherUpdateStatusRequest(state);
  assert.equal(applyLauncherUpdateStatus(state, snapshot({ seq: 3, status: 'downloaded', downloadedVersion: '0.1.3' })), true);
  assert.equal(acceptLauncherUpdateStatusResponse(state, token, snapshot({ seq: 2, status: 'downloading' })), false);
  assert.equal(failLauncherUpdateStatusRequest(state, token), false);
  assert.equal(state.updateStatus.status, 'downloaded');
  assert.equal(state.updateReadError, false);
});

test('status lookup failure closes actions and never reports an unverified latest-version success', () => {
  const state = rendererState();
  const token = beginLauncherUpdateStatusRequest(state);
  assert.equal(failLauncherUpdateStatusRequest(state, token), true);
  assert.equal(state.updateReadError, true);
  assert.equal(state.updateStatus.status, 'idle');
  assert.equal(launcherUpdatePresentation(state.updateStatus, { readError: state.updateReadError }).canCheck, false);
  const retry = beginLauncherUpdateStatusRequest(state);
  assert.equal(acceptLauncherUpdateStatusResponse(state, retry, snapshot()), true);
  assert.equal(state.updateReadError, false);
  const unavailable = { ...rendererState(), updateStatus: null };
  const unavailableToken = beginLauncherUpdateStatusRequest(unavailable);
  assert.equal(acceptLauncherUpdateStatusResponse(unavailable, unavailableToken, null), false);
  assert.equal(unavailable.updateReadError, true);
});

test('restart confirmation binds displayed versions and is invalidated by a task, pending read or changed downloaded release', () => {
  const downloaded = snapshot({ status: 'downloaded', availableVersion: '0.1.3', downloadedVersion: '0.1.3' });
  const captured = captureLauncherUpdateInstall(downloaded);
  assert.deepEqual(captured, { downloadedVersion: '0.1.3', currentVersion: '0.1.2' });
  assert.equal(canConfirmLauncherUpdateInstall(downloaded, captured), true);
  assert.equal(canConfirmLauncherUpdateInstall(downloaded, captured, { mutationBlocked: true }), false);
  assert.equal(canConfirmLauncherUpdateInstall(downloaded, captured, { readPending: true }), false);
  assert.equal(canConfirmLauncherUpdateInstall({ ...downloaded, downloadedVersion: '0.1.4' }, captured), false);
  assert.equal(canConfirmLauncherUpdateInstall({ ...downloaded, status: 'installing' }, captured), false);
  assert.equal(captureLauncherUpdateInstall(snapshot({ status: 'available', availableVersion: '0.1.3' })), null);
});

test('failed download/install retains safe explicit retry without allowing downgrade or mismatched cached install', () => {
  const failedInstall = snapshot({ status: 'error', availableVersion: '0.1.3', downloadedVersion: '0.1.3', errorKey: 'ui.update.error.install' });
  assert.equal(launcherUpdatePresentation(failedInstall).canInstall, true);
  assert.equal(launcherUpdatePresentation(failedInstall).canDownload, false);
  assert.equal(launcherUpdatePresentation({ ...failedInstall, downloadedVersion: '0.1.4' }).canInstall, false);
  assert.equal(launcherUpdatePresentation({ ...failedInstall, currentVersion: '0.1.3' }).canInstall, false);
  assert.equal(launcherUpdatePresentation(snapshot({ status: 'error', availableVersion: '0.1.3' })).canDownload, true);
  assert.equal(launcherUpdatePresentation(snapshot({ status: 'error', availableVersion: '0.1.1' })).canDownload, false);
  assert.equal(isNewerLauncherVersion('0.1.3-beta', '0.1.2'), false);
  assert.equal(isNewerLauncherVersion('0.2.0', '0.1.9'), true);
});

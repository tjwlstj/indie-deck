import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  createLauncherUpdateController, LAUNCHER_RELEASE_URL,
  type LauncherUpdateController, type LauncherUpdateOptions, type LauncherUpdateSnapshot, type LauncherUpdater,
} from '../../desktop/src/launcher-updates.ts';

class FakeUpdater extends EventEmitter implements LauncherUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  quits: [boolean | undefined, boolean | undefined][] = [];
  checkImpl: () => Promise<unknown> = async () => ({ updateInfo: { version: '0.1.3' }, isUpdateAvailable: true });
  downloadImpl: () => Promise<unknown> = async () => { this.emit('update-downloaded', { version: '0.1.3' }); return ['private-installer-path']; };
  quitImpl: () => void = () => undefined;
  checkForUpdates() { this.checks += 1; return this.checkImpl(); }
  downloadUpdate() { this.downloads += 1; return this.downloadImpl(); }
  quitAndInstall(silent?: boolean, force?: boolean) { this.quits.push([silent, force]); this.quitImpl(); }
}
function controller(updater = new FakeUpdater(), overrides: Partial<LauncherUpdateOptions> = {}) {
  return { updater, updates: createLauncherUpdateController(updater, { currentVersion: '0.1.2', isBusy: () => false, reserveInstall: () => true, ...overrides }) };
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function ready(updates: LauncherUpdateController) { await updates.check(); await updates.download(); }

test('all update actions are explicit; automatic download/install/prerelease/downgrade are disabled, restart-after-install enabled', () => {
  const { updater, updates } = controller();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(updater.checks, 0);
  assert.equal(updater.downloads, 0);
  assert.deepEqual(updater.quits, []);
  assert.equal(updates.snapshot().status, 'idle');
  assert.equal(updates.snapshot().releaseUrl, LAUNCHER_RELEASE_URL);
});

test('portable/development/disabled modes expose fixed release fallback and never invoke native updater actions', async () => {
  for (const mode of ['portable', 'development', 'disabled'] as const) {
    const { updater, updates } = controller(undefined, { mode });
    assert.equal(updates.snapshot().supported, false);
    assert.equal(updates.snapshot().status, mode === 'disabled' ? 'disabled' : 'manual');
    assert.equal(updates.snapshot().reasonKey, `ui.update.reason.${mode}`);
    await assert.rejects(updates.check(), new RegExp(`ui.update.reason.${mode}`));
    await assert.rejects(updates.download(), new RegExp(`ui.update.reason.${mode}`));
    assert.throws(() => updates.install(), new RegExp(`ui.update.reason.${mode}`));
    assert.equal(updater.checks + updater.downloads + updater.quits.length, 0);
  }
});

test('unsupported or malformed current-version metadata fails closed without leaking invalid metadata', async () => {
  const unsupported = controller(undefined, { supported: false }).updates;
  assert.equal(unsupported.snapshot().status, 'disabled');
  await assert.rejects(unsupported.check(), /ui\.update\.reason\.disabled|ui\.update\.reason\.unsupported/);
  const invalid = controller(undefined, { currentVersion: 'https://user:credential@example.invalid/secret' }).updates;
  assert.equal(invalid.snapshot().supported, false);
  assert.equal(invalid.snapshot().currentVersion, '');
  assert.equal(invalid.snapshot().errorKey, 'ui.update.error.invalidVersion');
  assert.ok(!JSON.stringify(invalid.snapshot()).includes('credential'));
});

test('concurrent checks dedupe one native request and snapshots remain available across renderer reloads', async () => {
  const pending = deferred();
  const { updater, updates } = controller();
  updater.checkImpl = () => pending.promise;
  const first = updates.check(), second = updates.check();
  assert.equal(first, second);
  assert.equal(updates.snapshot().status, 'checking');
  await Promise.resolve();
  assert.equal(updater.checks, 1);
  updater.emit('update-available', { version: '0.1.3' });
  assert.equal(updates.snapshot().status, 'checking', 'event hints do not outrun the current check promise');
  pending.resolve({ updateInfo: { version: '0.1.3' }, isUpdateAvailable: true });
  assert.equal((await first).status, 'available');
  assert.equal(updates.snapshot().availableVersion, '0.1.3');
  assert.equal(updater.downloads, 0);
  assert.ok(updates.snapshot().seq >= 2);
});

test('up-to-date checks clear prior availability and late/replayed events cannot replace a current promise result', async () => {
  const { updater, updates } = controller();
  await updates.check();
  const prior = updates.snapshot();
  updater.emit('update-available', { version: '9.9.9' });
  assert.deepEqual(updates.snapshot(), prior);
  const pending = deferred();
  updater.checkImpl = () => pending.promise;
  const checking = updates.check();
  await Promise.resolve();
  updater.emit('update-available', { version: '9.9.9' });
  pending.resolve({ updateInfo: { version: '0.1.2' }, isUpdateAvailable: false });
  const result = await checking;
  assert.equal(result.status, 'up-to-date');
  assert.equal(result.availableVersion, undefined);
  assert.equal(result.downloadedVersion, undefined);
  updater.emit('update-not-available', { version: '0.0.1' });
  assert.deepEqual(updates.snapshot(), result);
});

test('stable newer versions alone authorise downloads; old/same/prerelease/malformed advertised updates reject', async () => {
  for (const candidate of ['0.1.2', '0.1.1', '0.1.3-beta.1', 'v0.1.3', '0.01.3', '../installer.exe', '1.2.3 token=secret']) {
    const { updater, updates } = controller();
    updater.checkImpl = async () => ({ updateInfo: { version: candidate }, isUpdateAvailable: true });
    await assert.rejects(updates.check(), /ui\.update\.error\.invalidVersion/, candidate);
    assert.equal(updates.snapshot().status, 'error');
    assert.equal(updates.snapshot().availableVersion, undefined);
    await assert.rejects(updates.download(), /ui\.update\.error\.unavailable/);
    assert.equal(updater.downloads, 0);
  }
});

test('native event-only adapters are supported while an empty check response is not false up-to-date proof', async () => {
  const { updater, updates } = controller();
  updater.checkImpl = async () => { updater.emit('update-available', { version: '0.1.3' }); return undefined; };
  assert.equal((await updates.check()).status, 'available');
  updater.checkImpl = async () => undefined;
  await assert.rejects(updates.check(), /ui\.update\.error\.generic/);
});

test('check errors are bounded/category-only and preserve a previously validated available version for retry', async () => {
  const { updater, updates } = controller();
  await updates.check();
  updater.checkImpl = async () => { throw new Error('HTTP 403 https://name:password@example.invalid/update?token=secret ' + 'x'.repeat(10000)); };
  await assert.rejects(updates.check(), /ui\.update\.error\.network/);
  const snapshot = updates.snapshot();
  assert.equal(snapshot.availableVersion, '0.1.3');
  assert.equal(snapshot.errorKey, 'ui.update.error.network');
  assert.ok(snapshot.error!.length < 100);
  assert.ok(!JSON.stringify(snapshot).includes('password'));
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
});

test('download requires validated availability and cannot overlap a check', async () => {
  const { updater, updates } = controller();
  await assert.rejects(updates.download(), /ui\.update\.error\.unavailable/);
  assert.throws(() => updates.install(), /ui\.update\.error\.unavailable/);
  const pending = deferred();
  updater.checkImpl = () => pending.promise;
  const checking = updates.check();
  await assert.rejects(updates.download(), /ui\.update\.error\.busy/);
  pending.resolve({ updateInfo: { version: '0.1.3' }, isUpdateAvailable: true });
  await checking;
});

test('downloads dedupe, progress is finite/monotonic, and event acknowledgement alone cannot enable installation', async () => {
  const { updater, updates } = controller();
  await updates.check();
  const pending = deferred();
  updater.downloadImpl = () => pending.promise;
  const first = updates.download(), second = updates.download();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(updater.downloads, 1);
  await assert.rejects(updates.check(), /ui\.update\.error\.busy/);
  updater.emit('download-progress', { percent: 40, transferred: 400, total: 1000, bytesPerSecond: 25 });
  const progress = updates.snapshot();
  updater.emit('download-progress', { percent: 40, transferred: 400, total: 1000, bytesPerSecond: 25 });
  assert.equal(updates.snapshot().seq, progress.seq, 'identical progress does not inflate revisions');
  updater.emit('download-progress', { percent: 5, transferred: 50, total: 1000 });
  assert.equal(updates.snapshot().progress?.percent, 40);
  assert.equal(updates.snapshot().progress?.transferred, 400);
  updater.emit('download-progress', { percent: NaN, transferred: Infinity });
  assert.equal(updates.snapshot().progress?.percent, 40);
  updater.emit('download-progress', { percent: 200, transferred: 1100, total: 1000 });
  assert.equal(updates.snapshot().progress?.percent, 100);
  updater.emit('update-downloaded', { version: '0.1.3' });
  updater.emit('update-downloaded', { version: '0.1.3' });
  assert.equal(updates.snapshot().status, 'downloading');
  assert.throws(() => updates.install(), /ui\.update\.error\.busy/);
  pending.resolve(['C:\\private\\secret-installer.exe']);
  const result = await first;
  assert.equal(result.status, 'downloaded');
  assert.equal(result.downloadedVersion, '0.1.3');
  assert.ok(!JSON.stringify(result).includes('secret-installer'));
  await updates.download();
  assert.equal(updater.downloads, 1, 'already downloaded release is not fetched again');
});

test('wrong-version and missing download acknowledgements fail closed and allow an explicit retry', async () => {
  for (const failure of ['wrong-version', 'missing-event']) {
    const { updater, updates } = controller();
    await updates.check();
    updater.downloadImpl = async () => {
      if (failure === 'wrong-version') updater.emit('update-downloaded', { version: '9.9.9' });
      return ['private-installer-path'];
    };
    await assert.rejects(updates.download(), failure === 'wrong-version' ? /invalidVersion/ : /downloadIncomplete/);
    assert.equal(updates.snapshot().downloadedVersion, undefined);
    assert.equal(updates.snapshot().availableVersion, '0.1.3');
    assert.throws(() => updates.install(), /unavailable/);
    updater.downloadImpl = async () => { updater.emit('update-downloaded', { version: '0.1.3' }); return []; };
    assert.equal((await updates.download()).status, 'downloaded');
  }
});

test('native download error events are consumed and cannot silently become a successful download', async () => {
  const { updater, updates } = controller();
  await updates.check();
  updater.downloadImpl = async () => {
    updater.emit('error', new Error('sha512 checksum mismatch https://private.invalid/?key=secret'));
    updater.emit('update-downloaded', { version: '0.1.3' });
    return [];
  };
  await assert.rejects(updates.download(), /ui\.update\.error\.integrity/);
  assert.equal(updates.snapshot().status, 'error');
  assert.equal(updates.snapshot().downloadedVersion, undefined);
  assert.ok(!JSON.stringify(updates.snapshot()).includes('key=secret'));
});

test('busy game mutations and unsafe OS shutdown prevent restart without consuming the downloaded update', async () => {
  let busy = true, safe = true, reservations = 0;
  const { updater, updates } = controller(undefined, { isBusy: () => busy, isShutdownSafe: () => safe, reserveInstall: () => { reservations += 1; return true; } });
  await ready(updates);
  assert.throws(() => updates.install(), /busy/);
  busy = false; safe = false;
  assert.throws(() => updates.install(), /busy/);
  assert.equal(reservations, 0);
  assert.equal(updater.quits.length, 0);
  assert.equal(updates.snapshot().status, 'downloaded');
  assert.equal(updates.snapshot().downloadedVersion, '0.1.3');
});

test('restart reserves the shutdown gate synchronously before observer publication and before native quit', async () => {
  let reserved = false, observerSawReservation = false;
  const { updater, updates } = controller(undefined, {
    reserveInstall: () => { reserved = true; return true; },
    onChange: (state) => { if (state.status === 'installing') { assert.equal(reserved, true); observerSawReservation = true; } },
  });
  updater.quitImpl = () => assert.equal(reserved, true);
  await ready(updates);
  const installed = updates.install();
  assert.equal(installed.status, 'installing');
  assert.equal(observerSawReservation, true);
  assert.deepEqual(updater.quits, [[false, true]]);
  assert.throws(() => updates.install(), /busy/);
  await assert.rejects(updates.check(), /busy/);
});

test('missing or rejected shutdown reservation fails closed before invoking quitAndInstall', async () => {
  for (const reserveInstall of [undefined, () => false]) {
    const { updater, updates } = controller(undefined, { reserveInstall });
    await ready(updates);
    assert.throws(() => updates.install(), reserveInstall ? /busy/ : /reservation/);
    assert.equal(updater.quits.length, 0);
  }
});

test('a final busy-state change after reservation releases the gate and keeps update available for safe retry', async () => {
  let busy = false, releases = 0;
  const { updater, updates } = controller(undefined, {
    isBusy: () => busy,
    reserveInstall: () => { busy = true; return true; },
    releaseInstallReservation: () => { releases += 1; busy = false; },
  });
  await ready(updates);
  assert.throws(() => updates.install(), /busy/);
  assert.equal(releases, 1);
  assert.equal(updater.quits.length, 0);
  assert.equal(updates.snapshot().status, 'downloaded');
});

test('synchronous native install throws release reservation and preserve the verified download for explicit retry', async () => {
  let releases = 0;
  const { updater, updates } = controller(undefined, { releaseInstallReservation: () => { releases += 1; } });
  await ready(updates);
  updater.quitImpl = () => { throw new Error('EACCES C:\\private\\token-secret\\installer.exe'); };
  assert.throws(() => updates.install(), /ui\.update\.error\.permission/);
  assert.equal(releases, 1);
  assert.equal(updates.snapshot().status, 'error');
  assert.equal(updates.snapshot().downloadedVersion, '0.1.3');
  assert.ok(!JSON.stringify(updates.snapshot()).includes('token-secret'));
  updater.quitImpl = () => undefined;
  assert.equal(updates.install().status, 'installing');
});

test('asynchronous native install errors release the root gate even though no check/download action is active', async () => {
  let releases = 0;
  const { updater, updates } = controller(undefined, { releaseInstallReservation: () => { releases += 1; } });
  await ready(updates);
  updates.install();
  updater.emit('error', new Error('Permission denied while spawning installer https://private.invalid/?key=secret'));
  assert.equal(releases, 1);
  assert.equal(updates.snapshot().status, 'error');
  assert.equal(updates.snapshot().errorKey, 'ui.update.error.permission');
  assert.equal(updates.snapshot().downloadedVersion, '0.1.3');
  assert.ok(!JSON.stringify(updates.snapshot()).includes('key=secret'));
  const failed = updates.snapshot();
  updater.emit('download-progress', { percent: 1, transferred: 1 });
  assert.deepEqual(updates.snapshot(), failed);
  assert.equal(updates.install().status, 'installing');
});

test('synchronously emitted native install errors do not double-release reservation or falsely report installing', async () => {
  let releases = 0;
  const { updater, updates } = controller(undefined, { releaseInstallReservation: () => { releases += 1; } });
  await ready(updates);
  updater.quitImpl = () => updater.emit('error', new Error('installer failed'));
  assert.throws(() => updates.install(), /ui\.update\.error\.generic/);
  assert.equal(releases, 1);
  assert.equal(updates.snapshot().status, 'error');
});

test('observers cannot abort actions, snapshots cannot mutate authority, and revisions are monotonic', async () => {
  const observed: LauncherUpdateSnapshot[] = [];
  const { updater, updates } = controller(undefined, { onChange: (state) => { observed.push(state); throw new Error('isolated observer error'); } });
  await ready(updates);
  const returned = updates.snapshot();
  returned.availableVersion = '999.999.999';
  returned.progress!.percent = 1;
  assert.equal(updates.snapshot().availableVersion, '0.1.3');
  assert.equal(updates.snapshot().progress?.percent, 100);
  updates.install();
  assert.equal(updater.quits.length, 1);
  for (let index = 1; index < observed.length; index += 1) assert.ok(observed[index]!.seq > observed[index - 1]!.seq);
});

test('dispose removes owned listeners, ignores late check completion and rejects new requests', async () => {
  const pending = deferred();
  const { updater, updates } = controller();
  updater.checkImpl = () => pending.promise;
  const checking = updates.check();
  await Promise.resolve();
  const before = updates.snapshot();
  updates.dispose(); updates.dispose();
  assert.equal(updater.listenerCount('update-available'), 0);
  assert.equal(updater.listenerCount('download-progress'), 0);
  assert.equal(updater.listenerCount('error'), 0);
  pending.resolve({ updateInfo: { version: '9.9.9' }, isUpdateAvailable: true });
  await checking;
  assert.deepEqual(updates.snapshot(), before);
  await assert.rejects(updates.check(), /ui\.update\.error\.disposed/);
  assert.throws(() => updates.install(), /ui\.update\.error\.disposed/);
});

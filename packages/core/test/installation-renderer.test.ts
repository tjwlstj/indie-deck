import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptsInstallationCatalog, installationVersionPresentation, managedInstallationForGame,
  managedProductVersions, recoverableInstallJobs, nextArchiveRecoveryError,
} from '../../desktop/renderer/archive-model.js';

function fixture() {
  return {
    revision: 4,
    products: [
      { id: 'product-a', title: 'Shared title', activeInstallationId: 'install-a' },
      { id: 'product-b', title: 'Shared title', activeInstallationId: 'install-other-edition' },
    ],
    installations: [
      { id: 'install-a', productId: 'product-a', archiveId: 'archive-a', releaseId: 'release-a', createdAt: '2026-11-01T00:00:00Z' },
      { id: 'install-b', productId: 'product-a', archiveId: 'archive-b', releaseId: 'release-b', createdAt: '2026-11-02T00:00:00Z' },
      { id: 'install-other-edition', productId: 'product-b', archiveId: 'archive-other-edition', releaseId: 'release-other-edition' },
    ],
    releases: [
      { id: 'release-a', label: '1.0' },
      { id: 'release-b', label: 'test copy', versionHint: '99.0', versionEvidence: 'filename-hint' },
    ],
    jobs: [
      { id: 'interrupted-published', phase: 'recovery-required' },
      { id: 'finished', phase: 'activated' },
      { id: 'stopped-before-publish', phase: 'failed' },
    ],
  };
}

const records = [
  { id: 'archive-a', gameId: 'path-game-a', label: '1.0' },
  { id: 'archive-b', gameId: 'path-game-b', label: 'test copy' },
  { id: 'archive-other-edition', gameId: 'path-game-other' },
];

test('same-title editions remain distinct; version labels never choose the active installation', () => {
  const catalog = fixture();
  const current = managedInstallationForGame(catalog, records, 'path-game-a');
  assert.equal(current?.product.id, 'product-a');
  assert.equal(current?.active, true);
  const newer = managedInstallationForGame(catalog, records, 'path-game-b');
  assert.equal(newer?.active, false);
  const versions = managedProductVersions(catalog, records, 'product-a');
  assert.deepEqual(versions.map((entry) => entry.installation.id), ['install-b', 'install-a']);
  assert.equal(versions[0].active, false);
  assert.equal(versions[0].release?.versionEvidence, 'filename-hint');
  assert.equal(versions.some((entry) => entry.installation.id === 'install-other-edition'), false);
  assert.equal(managedInstallationForGame(catalog, records, 'unknown-path'), null);
});

test('a disconnected or unregistered copy remains visible without an activation action', () => {
  const catalog = fixture();
  const versions = managedProductVersions(catalog, records.filter((entry) => entry.id !== 'archive-b'), 'product-a');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].record, null);
  assert.deepEqual(installationVersionPresentation(versions[0]), { canOpen: false, canActivate: false });
  assert.equal(installationVersionPresentation(versions[1]).canActivate, false);
  const available = managedProductVersions(catalog, records, 'product-a')[0];
  assert.equal(installationVersionPresentation(available).canActivate, true);
  assert.equal(installationVersionPresentation(available, true).canActivate, false);
  assert.equal(installationVersionPresentation(available, true).canOpen, true);
});

test('old retained import results cannot undo activation and recovery distinguishes unpublished failures', () => {
  const active = fixture();
  const retainedImport = { ...active, revision: 3 };
  assert.equal(acceptsInstallationCatalog(active, retainedImport), false);
  assert.equal(acceptsInstallationCatalog(active, { ...active, revision: 5 }), true);
  assert.equal(acceptsInstallationCatalog(active, { ...active }), true);
  assert.equal(acceptsInstallationCatalog(null, active), true);
  for (const invalid of [null, {}, { ...active, revision: undefined }, { ...active, revision: -1 }, { ...active, jobs: null }]) {
    assert.equal(acceptsInstallationCatalog(active, invalid), false);
  }
  assert.deepEqual(recoverableInstallJobs(active).map((job) => job.id), ['interrupted-published']);
  const switched = { ...active, revision: 5, products: [{ ...active.products[0], activeInstallationId: 'install-b' }] };
  assert.equal(managedInstallationForGame(switched, records, 'path-game-b')?.active, true);
  assert.equal(managedInstallationForGame(switched, records, 'path-game-a')?.active, false);
});

test('a retained successful import cannot clear a later catalog read error', () => {
  const error = 'The installation catalog could not be read';
  const success = { catalog: fixture() };
  assert.equal(nextArchiveRecoveryError(error, success), error);
  assert.equal(nextArchiveRecoveryError(error, { records: [], catalog: null, recoveryError: error }, true), error);
  assert.equal(nextArchiveRecoveryError(error, success, true), null);
  assert.equal(nextArchiveRecoveryError(null, { recoveryError: error }), error);
});

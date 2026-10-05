import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canConfirmTranslatorMaintenance, captureTranslatorMaintenance,
  hasTranslatorMaintenance, translatorMaintenancePresentation,
} from '../../desktop/renderer/maintenance-model.js';
import {
  archiveCandidatePresentation, archiveRecordForGame, isArchiveActive,
  mergeArchiveRecords, reduceArchiveProgress,
} from '../../desktop/renderer/archive-model.js';
import { createProvisionalOperation, reduceOperationOutcome, reduceOperationProgress } from '../../desktop/renderer/state-model.js';

function context() {
  return {
    profile: { id: 'game-a', engineId: 'unity' },
    translatorMaintenance: {
      supported: true, previewId: 'opaque-preview-a', canRemove: true, canReinstall: true,
      files: [{ path: 'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll', size: 42, sha256: 'digest', managed: false }],
      preservedPaths: ['AutoTranslator/Config.ini'], targetVersion: '5.5.2',
    },
  };
}

test('translator maintenance is Unity-only and requires explicit main-issued capability and preview id', () => {
  assert.equal(hasTranslatorMaintenance(context()), true);
  for (const engineId of ['rpgmaker-mv', 'renpy', 'unknown']) {
    assert.equal(hasTranslatorMaintenance({ ...context(), profile: { id: 'game-a', engineId } }), false);
  }
  assert.equal(translatorMaintenancePresentation(context()).canRemove, true);
  assert.equal(translatorMaintenancePresentation(context(), true).canReinstall, false);
  assert.equal(translatorMaintenancePresentation({ ...context(), translatorMaintenance: { ...context().translatorMaintenance, previewId: '' } }).canRemove, false);
  assert.equal(translatorMaintenancePresentation({ ...context(), translatorMaintenance: { ...context().translatorMaintenance, canReinstall: false } }).canReinstall, false);
});

test('confirmation captures exact displayed files and opaque preview without granting arbitrary file authority', () => {
  const detail = context();
  const captured = captureTranslatorMaintenance(detail, 'reinstall-translator');
  assert.equal(captured.planId, 'opaque-preview-a');
  assert.equal(captured.gameId, 'game-a');
  assert.deepEqual(captured.files, detail.translatorMaintenance.files);
  detail.translatorMaintenance.files[0].path = 'changed-after-confirmation.dll';
  assert.notEqual(captured.files[0].path, detail.translatorMaintenance.files[0].path);
  assert.equal(captureTranslatorMaintenance(detail, 'install'), null);
  assert.equal(captureTranslatorMaintenance(detail, 'remove-translator', true), null);
});

test('confirmation refuses changed game selection and refreshed opaque authority', () => {
  const detail = context();
  const captured = captureTranslatorMaintenance(detail, 'remove-translator');
  assert.equal(canConfirmTranslatorMaintenance({ selected: 'game-a', detail }, captured), true);
  assert.equal(canConfirmTranslatorMaintenance({ selected: 'game-b', detail }, captured), false);
  assert.equal(canConfirmTranslatorMaintenance({ selected: 'game-a', detail: { ...detail, translatorMaintenance: { ...detail.translatorMaintenance, previewId: 'new-preview' } } }, captured), false);
});

test('remove/reinstall kinds use existing operation correlation and keep terminal post-state on reload', () => {
  for (const kind of ['remove-translator', 'reinstall-translator']) {
    const operation = createProvisionalOperation({ requestId: 'request', gameId: 'game-a', kind, planId: 'opaque' });
    const progress = reduceOperationProgress(operation, { requestId: 'request', operationId: 'job', gameId: 'game-a', kind, sequence: 1, phase: 'backup' });
    assert.equal(progress.kind, kind);
    const completed = reduceOperationOutcome(progress, { requestId: 'request', operationId: 'job', gameId: 'game-a', kind, sequence: 2, status: 'success', postState: { gameId: 'game-a' }, result: { backupDirectory: 'backup' } });
    assert.equal(completed.outcome.result.backupDirectory, 'backup');
    assert.equal(completed.planId, 'opaque');
  }
});

test('archive import requires inspected ZIP capability and never promotes filename hints to game-version evidence', () => {
  const ready = { id: 'archive', format: 'zip', status: 'ready', canImport: true, versionHint: '1.2' };
  assert.equal(archiveCandidatePresentation(ready).canImport, true);
  assert.equal(archiveCandidatePresentation(ready, true).canImport, false);
  assert.equal(archiveCandidatePresentation(ready).versionIsAuthoritative, false);
  for (const format of ['7z', 'rar']) {
    const display = archiveCandidatePresentation({ ...ready, format, status: 'recognized' });
    assert.equal(display.canImport, false);
    assert.equal(display.manualOnly, true);
  }
  assert.equal(archiveCandidatePresentation({ ...ready, status: 'invalid' }).canImport, false);
});

test('archive snapshots use main-global sequence so stale events cannot regress terminal or newer tasks', () => {
  const complete = { id: 'archive-a', sequence: 12, status: 'complete', phase: 'complete', result: { record: { id: 'copy-a' } } };
  assert.equal(reduceArchiveProgress(complete, { id: 'archive-a', sequence: 11, status: 'running', phase: 'extract' }), complete);
  assert.equal(reduceArchiveProgress(complete, { id: 'archive-old', sequence: 3, status: 'running', phase: 'inspect' }), complete);
  const next = reduceArchiveProgress(complete, { id: 'archive-b', sequence: 13, status: 'running', phase: 'inspect' });
  assert.equal(next.id, 'archive-b');
  assert.equal(isArchiveActive(next), true);
  assert.equal(isArchiveActive(complete), false);
  // Main may report detection as inspect after extracting. A newer sequence
  // still wins; presentation phase order is not transaction authority.
  const extracted = { id: 'archive-b', sequence: 14, status: 'running', phase: 'extract' };
  assert.equal(reduceArchiveProgress(extracted, { id: 'archive-b', sequence: 15, status: 'running', phase: 'inspect' }).phase, 'inspect');
});

test('a provisional import accepts current() recovery and stale list responses retain newly imported versions', () => {
  const provisional = { id: 'archive-a', sequence: -1, status: 'running', phase: 'inspect' };
  const restored = reduceArchiveProgress(provisional, { id: 'archive-a', sequence: 10, status: 'running', phase: 'extract', completedFiles: 3 });
  assert.equal(restored.completedFiles, 3);
  const copyA = { id: 'copy-a', importedAt: '2026-10-05T00:00:00Z', label: '1.2', gameId: 'game-a' };
  const copyB = { id: 'copy-b', importedAt: '2026-10-04T00:00:00Z', gameId: 'game-b' };
  assert.deepEqual(mergeArchiveRecords([copyA], [copyB]), [copyA, copyB]);
  assert.equal(archiveRecordForGame([copyA, copyB], 'game-a'), copyA);
  assert.equal(archiveRecordForGame([copyA, copyB], 'unknown'), null);
});

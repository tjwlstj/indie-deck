import { $, el, setStatus } from '../dom.js';
import { t } from '../i18n.js';
import { api, applyLibraryPayload, emit, mutationBlocked, state } from '../store.js';
import {
  acceptsInstallationCatalog, archiveCandidatePresentation, managedInstallationForGame,
  managedProductVersions, mergeArchiveRecords, recoverableInstallJobs, reduceArchiveProgress, installationVersionPresentation, nextArchiveRecoveryError,
} from '../archive-model.js';

let progressEpoch = 0;
let recordsEpoch = 0;

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function archiveProgressLabel(progress) {
  if (!progress && state.archiveAction) return t(`ui.archive.${state.archiveAction}`);
  progress ??= state.archiveProgress;
  return progress ? t(`ui.archive.phase.${progress.phase}`, undefined, progress.phase) : '';
}

function mergeImportResult(result, { clearRecoveryError = false } = {}) {
  if (!result) return;
  if (result.catalog && !acceptsInstallationCatalog(state.archiveCatalog, result.catalog)) return;
  if (result.catalog) state.archiveCatalog = result.catalog;
  state.archiveRecoveryError = nextArchiveRecoveryError(state.archiveRecoveryError, result, clearRecoveryError);
  state.archiveRecords = mergeArchiveRecords(state.archiveRecords, result.records ?? (result.record ? [result.record] : []));
  recordsEpoch += 1;
  if (result.config) state.config = result.config;
  if (result.library) applyLibraryPayload(result.library);
}

function archiveInstallationBlocked() {
  return mutationBlocked() || Boolean(state.archiveRecoveryError);
}

function importCompletionLabel(result) {
  return result?.duplicate
    ? t('ui.archive.duplicateReused', undefined, 'This identical archive is already installed. The existing copy was reused; no additional copy was created.')
    : t('ui.archive.complete', undefined, 'Archive imported into a separate game folder.');
}

function acceptProgress(progress) {
  const next = reduceArchiveProgress(state.archiveProgress, progress);
  if (next === state.archiveProgress) return;
  progressEpoch += 1;
  state.archiveProgress = next;
  if (next.status === 'complete') {
    mergeImportResult(next.result);
    state.archiveCandidate = null;
    state.archiveProductId = '';
    state.archiveProductConfirmed = false;
    setStatus(state.archiveRecoveryError || importCompletionLabel(next.result), state.archiveRecoveryError ? 'err' : 'ok');
  } else if (next.status === 'failed') setStatus(next.error ?? t('ui.archive.failed', undefined, 'Archive import failed.'), 'err');
  else setStatus(archiveProgressLabel(next));
  emit('all');
}

/** Subscribe before current(): progress from an in-flight import survives renderer reload. */
export function bindArchiveEvents() {
  api.archives.onProgress(acceptProgress);
}

export async function recoverArchiveProgress() {
  const epoch = progressEpoch;
  const progress = await api.archives.current();
  if (epoch !== progressEpoch || !progress) return;
  acceptProgress(progress);
}

export async function refreshArchiveRecords() {
  const epoch = recordsEpoch;
  const result = await api.archives.list();
  if (epoch !== recordsEpoch && !result.catalog && result.recoveryError) return;
  if (result.catalog && !acceptsInstallationCatalog(state.archiveCatalog, result.catalog)) return;
  if (result.catalog) state.archiveCatalog = result.catalog;
  state.archiveRecoveryError = nextArchiveRecoveryError(state.archiveRecoveryError, result, true);
  // A current list is authoritative (including removed/unregistered copies).
  // Keep newer import records only when they arrived during this list read.
  state.archiveRecords = epoch === recordsEpoch
    ? Array.isArray(result.records) ? result.records : []
    : mergeArchiveRecords(state.archiveRecords, result.records);
  state.archiveRecordsLoaded = true;
  renderArchiveSettings();
  emit('all');
}

async function pickArchive() {
  if (archiveInstallationBlocked()) return;
  state.archiveBusy = true;
  state.archiveAction = 'inspecting';
  emit('all');
  setStatus(t('ui.archive.inspecting', undefined, 'Inspecting archive contents…'));
  try {
    const result = await api.archives.pick();
    mergeImportResult(result, { clearRecoveryError: true });
    state.archiveRecordsLoaded = true;
    if (result.candidate) {
      state.archiveCandidate = result.candidate;
      state.archiveLabel = '';
      state.archiveProductId = '';
      state.archiveProductConfirmed = false;
      setStatus(result.candidate.canImport
        ? t('ui.archive.ready', undefined, 'Archive inspected. Review it before importing.')
        : result.candidate.reasonKey
          ? t(result.candidate.reasonKey)
          : t('ui.archive.manualOnly', undefined, 'This archive format is recognized; extract it yourself and add its folder.'));
    } else setStatus(t('ui.app.ready', undefined, 'Ready'));
  } catch (error) {
    setStatus(error.message, 'err');
  } finally {
    state.archiveBusy = false;
    state.archiveAction = null;
    emit('all');
  }
}

async function importArchive(candidate) {
  if (!archiveCandidatePresentation(candidate, archiveInstallationBlocked()).canImport || state.archiveCandidate?.id !== candidate.id) return;
  const productId = state.archiveProductId || undefined;
  if (productId && (!state.archiveProductConfirmed || !(state.archiveCatalog?.products ?? []).some((product) => product.id === productId))) return;
  const label = state.archiveLabel.trim();
  state.archiveBusy = true;
  state.archiveProgress = {
    id: candidate.id, sequence: -1, status: 'running', phase: 'inspect',
    completedFiles: 0, totalFiles: candidate.fileCount ?? 0,
    completedBytes: 0, totalBytes: candidate.unpackedBytes ?? 0,
  };
  emit('all');
  setStatus(archiveProgressLabel());
  try {
    const result = await api.archives.import(candidate.id, label || undefined, productId);
    mergeImportResult(result, { clearRecoveryError: true });
    state.archiveCandidate = null;
    state.archiveLabel = '';
    state.archiveProductId = '';
    state.archiveProductConfirmed = false;
    // The retained main snapshot remains authoritative for final status. This
    // await also covers delivery gaps when import() returns before its event.
    await recoverArchiveProgress();
    setStatus(state.archiveRecoveryError || importCompletionLabel(result), state.archiveRecoveryError ? 'err' : 'ok');
  } catch (error) {
    await recoverArchiveProgress().catch(() => {});
    if (state.archiveProgress?.id === candidate.id && state.archiveProgress.status === 'running') {
      state.archiveProgress = { ...state.archiveProgress, status: 'failed', phase: 'failed', error: error.message };
    }
    setStatus(error.message, 'err');
    await refreshArchiveRecords().catch(() => {});
  } finally {
    state.archiveBusy = false;
    emit('all');
  }
}

async function activateInstallation(installationId) {
  if (archiveInstallationBlocked()) return;
  state.archiveBusy = true;
  state.archiveAction = 'activating';
  emit('all');
  try {
    const result = await api.archives.activate(installationId);
    mergeImportResult(result, { clearRecoveryError: true });
    setStatus(t('ui.archive.activeChanged', undefined, 'Active version changed. Each copy keeps its own game files; no save or translation data was moved.'), 'ok');
    if (result.gameId) openGameRecord(result.gameId);
  } catch (error) {
    setStatus(error.message, 'err');
    await refreshArchiveRecords().catch(() => {});
  } finally {
    state.archiveBusy = false;
    state.archiveAction = null;
    emit('all');
  }
}

async function recoverInstallations() {
  if (mutationBlocked()) return;
  state.archiveBusy = true;
  state.archiveAction = 'recovering';
  emit('all');
  try {
    const result = await api.archives.recover();
    mergeImportResult(result, { clearRecoveryError: true });
    const pending = recoverableInstallJobs(state.archiveCatalog).length || Boolean(state.archiveRecoveryError);
    setStatus(pending
      ? t('ui.archive.recoveryPending', undefined, 'Some installations still need recovery. Review the details below.')
      : t('ui.archive.recoveryComplete', undefined, 'Installation records recovered. Existing versions were kept.'), pending ? 'err' : 'ok');
  } catch (error) {
    setStatus(error.message, 'err');
    await refreshArchiveRecords().catch(() => {});
  } finally {
    state.archiveBusy = false;
    state.archiveAction = null;
    emit('all');
  }
}

function progressCard(progress) {
  const card = el('section', `archive-progress ${progress.status}`);
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  card.append(el('strong', null, archiveProgressLabel(progress)));
  if (progress.status === 'running') {
    const bar = el('progress');
    bar.max = 100;
    if (Number(progress.totalBytes) > 0) bar.value = Math.min(100, Number(progress.completedBytes ?? 0) / Number(progress.totalBytes) * 100);
    else if (Number(progress.totalFiles) > 0) bar.value = Math.min(100, Number(progress.completedFiles ?? 0) / Number(progress.totalFiles) * 100);
    bar.setAttribute('aria-label', archiveProgressLabel(progress));
    card.append(bar, el('p', 'plan-sub', t('ui.archive.filesProgress', {
      completed: progress.completedFiles ?? 0, total: progress.totalFiles ?? 0,
    }, 'Files {completed}/{total}')),
    el('p', 'plan-sub', `${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}`));
  }
  if (progress.error) card.append(el('p', 'archive-warning', progress.error));
  return card;
}

function openGameRecord(gameId) {
  window.dispatchEvent(new CustomEvent('indiedeck:select-game', { detail: { gameId } }));
}

function versionName(version) {
  return version.record?.label || version.release?.label || version.record?.archiveName ||
    t('ui.archive.importedCopy', undefined, 'Imported copy');
}

function appendVersionActions(card, version) {
  const presentation = installationVersionPresentation(version, archiveInstallationBlocked());
  const actions = el('div', 'archive-version-actions');
  const badge = el('span', `pill ${version.active ? 'ok' : 'archive-inactive'}`, version.active
    ? t('ui.archive.active', undefined, 'Active version')
    : t('ui.archive.inactive', undefined, 'Retained version'));
  actions.append(badge);
  if (presentation.canOpen) {
    const open = el('button', 'ghost archive-open-game', t('ui.archive.openGame', undefined, 'Open game in library'));
    open.addEventListener('click', () => openGameRecord(version.record.gameId));
    actions.append(open);
    if (!version.active) {
      const activate = el('button', 'ghost archive-activate', t('ui.archive.activate', undefined, 'Use this version'));
      activate.dataset.installationId = version.installation.id;
      activate.disabled = !presentation.canActivate;
      activate.addEventListener('click', () => void activateInstallation(version.installation.id));
      actions.append(activate);
    }
  } else card.append(el('p', 'archive-warning', t('ui.archive.unregistered', undefined, 'This version is no longer registered in the library. Add its game folder to use it.')));
  card.append(actions);
}

function appendRecovery(body) {
  const jobs = recoverableInstallJobs(state.archiveCatalog);
  const failed = (state.archiveCatalog?.jobs ?? []).filter((job) => job.phase === 'failed').slice(-3).reverse();
  if (!jobs.length && !failed.length && !state.archiveRecoveryError) return;
  const card = el('section', 'archive-recovery');
  card.setAttribute('role', 'status');
  card.append(el('strong', null, t('ui.archive.recoveryTitle', undefined, 'Interrupted installation needs review')),
    el('p', 'archive-warning', jobs.length || state.archiveRecoveryError
      ? t('ui.archive.recoveryDescription', undefined, 'The previous active version is preserved. Retry registration of verified installed files; a new copy will not be extracted.')
      : t('ui.archive.failedHistory', undefined, 'These installations stopped before completion. Existing versions are preserved. Select and inspect the original archive again to retry.')));
  for (const job of [...jobs, ...failed]) {
    const product = (state.archiveCatalog?.products ?? []).find((entry) => entry.id === job.productId);
    const message = job.error?.startsWith('ui.') ? t(job.error) : job.error || job.phase;
    card.append(el('p', 'plan-sub', `${product?.title || t('ui.archive.importedCopy', undefined, 'Imported copy')} · ${message}`));
  }
  if (state.archiveRecoveryError) card.append(el('p', 'archive-warning', state.archiveRecoveryError.startsWith('ui.') ? t(state.archiveRecoveryError) : state.archiveRecoveryError));
  if (jobs.length || state.archiveRecoveryError) {
    const retry = el('button', 'ghost archive-recover', t('ui.archive.retryRecovery', undefined, 'Retry installation recovery'));
    retry.disabled = mutationBlocked();
    retry.addEventListener('click', () => void recoverInstallations());
    card.append(retry);
  }
  body.append(card);
}

/** The detail view always retains access to sibling copies, including older ones. */
export function renderManagedVersions(panel, profile) {
  const current = managedInstallationForGame(state.archiveCatalog, state.archiveRecords, profile.id);
  if (!current) return;
  const card = el('section', 'archive-product detail-versions');
  card.dataset.productId = current.product.id;
  card.append(el('h3', null, t('ui.archive.managedVersions', undefined, 'Installed versions')),
    el('p', 'plan-sub', current.product.title),
    el('p', 'settings-hint', t('ui.archive.noMigration', undefined, 'Each version has its own game folder. Saves, mods and translators are not copied automatically. Shared saves outside the game folder may still be used by the game.')));
  for (const version of managedProductVersions(state.archiveCatalog, state.archiveRecords, current.product.id)) {
    const row = el('div', 'archive-sibling');
    row.append(el('strong', null, versionName(version)));
    if (version.record?.gameId === profile.id) row.append(el('span', 'plan-sub', t('ui.archive.viewing', undefined, 'Currently viewing')));
    appendVersionActions(row, version);
    card.append(row);
  }
  const update = el('button', 'ghost archive-add-version', t('ui.archive.addVersion', undefined, 'Install another downloaded version'));
  update.disabled = archiveInstallationBlocked();
  update.addEventListener('click', () => {
    if (archiveInstallationBlocked()) return;
    window.dispatchEvent(new CustomEvent('indiedeck:open-settings', { detail: { section: 'archiveSettings' } }));
    void pickArchive().then(() => {
      if (state.archiveCandidate?.canImport && (state.archiveCatalog?.products ?? []).some((product) => product.id === current.product.id)) {
        state.archiveProductId = current.product.id;
        state.archiveProductConfirmed = false;
        emit('all');
      }
    });
  });
  card.append(update);
  panel.append(card);
}

export function renderArchiveSettings() {
  const body = $('archiveSettingsBody');
  if (!body) return;
  body.replaceChildren();
  body.append(el('p', 'settings-hint', t('ui.archive.description', undefined, 'Install downloaded ZIP games as a new game or a separate version of a managed game. Choose which version to use while retaining the original archive and older copies.')),
    el('p', 'archive-warning', t('ui.archive.manualOnly', undefined, '7z and RAR are recognized but cannot be imported here yet. Extract them yourself and add the extracted game folder.')),
    el('p', 'settings-hint', t('ui.archive.versionCaveat', undefined, 'Filename version hints are guesses, not verified game versions. Labels help you identify your own copies.')));
  appendRecovery(body);
  const pick = el('button', 'ghost archive-pick', t('ui.archive.pick', undefined, 'Choose game archive'));
  pick.disabled = archiveInstallationBlocked();
  pick.addEventListener('click', () => void pickArchive());
  body.append(pick);

  const candidate = state.archiveCandidate;
  if (candidate) {
    const card = el('section', 'archive-candidate');
    card.append(el('strong', 'archive-name', candidate.archiveName),
      el('p', 'plan-sub', `${String(candidate.format).toUpperCase()} · ${formatBytes(candidate.sizeBytes)}`));
    if (candidate.fileCount !== undefined) card.append(el('p', 'plan-sub', t('ui.archive.contents', {
      count: candidate.fileCount, size: formatBytes(candidate.unpackedBytes),
    }, '{count} files · unpacked {size}')));
    if (candidate.sha256) card.append(el('p', 'archive-hash', `SHA-256: ${candidate.sha256}`));
    if (candidate.versionHint) card.append(el('p', 'archive-warning', t('ui.archive.versionHint', { version: candidate.versionHint }, 'Filename hint: {version} (unverified)')));
    if (candidate.reasonKey) card.append(el('p', 'archive-warning', t(candidate.reasonKey)));
    if (candidate.canImport) {
      const productRow = el('label', 'archive-label-row');
      const productSelect = el('select');
      productSelect.id = 'archiveProduct';
      const newProduct = el('option', null, t('ui.archive.newProduct', undefined, 'Install as a new game'));
      newProduct.value = '';
      productSelect.append(newProduct);
      for (const product of state.archiveCatalog?.products ?? []) {
        const option = el('option', null, t('ui.archive.existingProduct', { title: product.title }, 'Another version of: {title}'));
        option.value = product.id;
        productSelect.append(option);
      }
      productSelect.value = state.archiveProductId;
      productSelect.disabled = archiveInstallationBlocked();
      productSelect.addEventListener('change', () => {
        state.archiveProductId = productSelect.value;
        state.archiveProductConfirmed = false;
        renderArchiveSettings();
      });
      productRow.append(el('span', null, t('ui.archive.product', undefined, 'Game / edition')), productSelect);
      card.append(productRow);
      if (state.archiveProductId) {
        const confirmRow = el('label', 'archive-product-confirm');
        const confirmed = el('input');
        confirmed.id = 'archiveProductConfirmed';
        confirmed.type = 'checkbox';
        confirmed.checked = state.archiveProductConfirmed;
        confirmed.disabled = archiveInstallationBlocked();
        confirmed.addEventListener('change', () => {
          state.archiveProductConfirmed = confirmed.checked;
          const importButton = $('archiveImportVersion');
          if (importButton) importButton.disabled = archiveInstallationBlocked() || !confirmed.checked;
        });
        confirmRow.append(confirmed, el('span', null, t('ui.archive.confirmProduct', undefined, 'This is a full package for the same game and edition, not DLC, a trial or a patch.')));
        card.append(confirmRow, el('p', 'archive-warning', t('ui.archive.updateInactive', undefined, 'The new copy stays inactive until you choose “Use this version”. The current active version is preserved.')));
      }
      card.append(el('p', 'settings-hint', t('ui.archive.noMigration', undefined, 'Each version has its own game folder. Saves, mods and translators are not copied automatically. Shared saves outside the game folder may still be used by the game.')));
      const row = el('label', 'archive-label-row');
      const input = el('input');
      input.id = 'archiveVersionLabel';
      input.type = 'text';
      input.maxLength = 80;
      input.value = state.archiveLabel;
      input.placeholder = t('ui.archive.labelPlaceholder', undefined, 'e.g. 1.2 / original / test copy');
      input.disabled = archiveInstallationBlocked();
      input.addEventListener('input', () => { state.archiveLabel = input.value; });
      row.append(el('span', null, t('ui.archive.label', undefined, 'Version label (optional)')), input);
      const button = el('button', 'primary archive-import', t('ui.archive.import', undefined, 'Import as a separate version'));
      button.id = 'archiveImportVersion';
      button.disabled = !archiveCandidatePresentation(candidate, archiveInstallationBlocked()).canImport || Boolean(state.archiveProductId && !state.archiveProductConfirmed);
      button.addEventListener('click', () => void importArchive(candidate));
      card.append(row, button);
    }
    body.append(card);
  }
  if (state.archiveProgress) body.append(progressCard(state.archiveProgress));
  body.append(el('h3', null, t('ui.archive.versions', undefined, 'Imported game versions')));
  if (!state.archiveRecordsLoaded && state.archiveRecords.length === 0) {
    body.append(el('p', 'plan-sub', t('ui.archive.loading', undefined, 'Loading imported versions…')));
  } else if (state.archiveRecords.length === 0) body.append(el('p', 'plan-sub', t('ui.archive.empty', undefined, 'No archives imported yet.')));
  const managedArchiveIds = new Set();
  for (const product of state.archiveCatalog?.products ?? []) {
    const versions = managedProductVersions(state.archiveCatalog, state.archiveRecords, product.id);
    const group = el('section', 'archive-product');
    group.dataset.productId = product.id;
    group.append(el('h3', null, product.title));
    for (const version of versions) {
      managedArchiveIds.add(version.installation.archiveId);
      const card = el('section', 'archive-record');
      card.dataset.archiveId = version.installation.archiveId;
      card.append(el('strong', null, versionName(version)),
        el('p', 'plan-sub', `${version.record?.engineId || ''} · ${version.installation.createdAt}`));
      if (version.record) {
        card.append(el('p', 'archive-name', version.record.archiveName),
          el('p', 'archive-hash', `SHA-256: ${version.record.sourceSha256}`),
          el('p', 'path', version.record.gameRoot));
        if (version.record.versionHint) card.append(el('p', 'archive-warning', t('ui.archive.versionHint', { version: version.record.versionHint }, 'Filename hint: {version} (unverified)')));
      }
      appendVersionActions(card, version);
      group.append(card);
    }
    body.append(group);
  }
  for (const record of state.archiveRecords.filter((entry) => !managedArchiveIds.has(entry.id))) {
    const card = el('section', 'archive-record');
    card.dataset.archiveId = record.id;
    card.append(el('strong', null, `${record.title || record.gameName || record.archiveName}${record.label ? ` · ${record.label}` : ''}`),
      el('p', 'plan-sub', `${record.engineId} · ${record.importedAt}`),
      el('p', 'archive-name', record.archiveName),
      el('p', 'archive-hash', `SHA-256: ${record.sourceSha256}`),
      el('p', 'path', record.gameRoot));
    if (record.versionHint) card.append(el('p', 'archive-warning', t('ui.archive.versionHint', { version: record.versionHint }, 'Filename hint: {version} (unverified)')));
    if (record.gameId) {
      const open = el('button', 'ghost archive-open-game', t('ui.archive.openGame', undefined, 'Open game in library'));
      open.addEventListener('click', () => openGameRecord(record.gameId));
      card.append(open);
    } else card.append(el('p', 'archive-warning', t('ui.archive.unregistered', undefined, 'This version is no longer registered in the library. Add its game folder to use it.')));
    body.append(card);
  }
}

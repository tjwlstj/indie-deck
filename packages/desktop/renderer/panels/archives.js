import { $, el, setStatus } from '../dom.js';
import { t } from '../i18n.js';
import { api, applyLibraryPayload, emit, mutationBlocked, state } from '../store.js';
import { archiveCandidatePresentation, mergeArchiveRecords, reduceArchiveProgress } from '../archive-model.js';

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

export function archiveProgressLabel(progress = state.archiveProgress) {
  return progress ? t(`ui.archive.phase.${progress.phase}`, undefined, progress.phase) : '';
}

function mergeImportResult(result) {
  if (!result) return;
  state.archiveRecords = mergeArchiveRecords(state.archiveRecords, result.records ?? (result.record ? [result.record] : []));
  recordsEpoch += 1;
  if (result.config) state.config = result.config;
  if (result.library) applyLibraryPayload(result.library);
}

function acceptProgress(progress) {
  const next = reduceArchiveProgress(state.archiveProgress, progress);
  if (next === state.archiveProgress) return;
  progressEpoch += 1;
  state.archiveProgress = next;
  if (next.status === 'complete') {
    mergeImportResult(next.result);
    state.archiveCandidate = null;
    setStatus(t('ui.archive.complete', undefined, 'Archive imported into a separate game folder.'), 'ok');
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
  // A current list is authoritative (including removed/unregistered copies).
  // Keep newer import records only when they arrived during this list read.
  state.archiveRecords = epoch === recordsEpoch
    ? Array.isArray(result.records) ? result.records : []
    : mergeArchiveRecords(state.archiveRecords, result.records);
  state.archiveRecordsLoaded = true;
  renderArchiveSettings();
  emit('library');
}

async function pickArchive() {
  if (mutationBlocked()) return;
  state.archiveBusy = true;
  emit('all');
  setStatus(t('ui.archive.inspecting', undefined, 'Inspecting archive contents…'));
  try {
    const result = await api.archives.pick();
    state.archiveRecords = mergeArchiveRecords(state.archiveRecords, result.records);
    state.archiveRecordsLoaded = true;
    if (result.candidate) {
      state.archiveCandidate = result.candidate;
      state.archiveLabel = '';
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
    emit('all');
  }
}

async function importArchive(candidate) {
  if (!archiveCandidatePresentation(candidate, mutationBlocked()).canImport || state.archiveCandidate?.id !== candidate.id) return;
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
    const result = await api.archives.import(candidate.id, label || undefined);
    mergeImportResult(result);
    state.archiveCandidate = null;
    state.archiveLabel = '';
    // The retained main snapshot remains authoritative for final status. This
    // await also covers delivery gaps when import() returns before its event.
    await recoverArchiveProgress();
    setStatus(t('ui.archive.complete', undefined, 'Archive imported into a separate game folder.'), 'ok');
  } catch (error) {
    await recoverArchiveProgress().catch(() => {});
    if (state.archiveProgress?.id === candidate.id && state.archiveProgress.status === 'running') {
      state.archiveProgress = { ...state.archiveProgress, status: 'failed', phase: 'failed', error: error.message };
    }
    setStatus(error.message, 'err');
  } finally {
    state.archiveBusy = false;
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

export function renderArchiveSettings() {
  const body = $('archiveSettingsBody');
  if (!body) return;
  body.replaceChildren();
  body.append(el('p', 'settings-hint', t('ui.archive.description', undefined, 'Import ZIP games into separate folders and keep each version as its own library entry. The original archive and existing games are not overwritten.')),
    el('p', 'archive-warning', t('ui.archive.manualOnly', undefined, '7z and RAR are recognized but cannot be imported here yet. Extract them yourself and add the extracted game folder.')),
    el('p', 'settings-hint', t('ui.archive.versionCaveat', undefined, 'Filename version hints are guesses, not verified game versions. Labels help you identify your own copies.')));
  const pick = el('button', 'ghost archive-pick', t('ui.archive.pick', undefined, 'Choose game archive'));
  pick.disabled = mutationBlocked();
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
      const row = el('label', 'archive-label-row');
      const input = el('input');
      input.id = 'archiveVersionLabel';
      input.type = 'text';
      input.maxLength = 80;
      input.value = state.archiveLabel;
      input.placeholder = t('ui.archive.labelPlaceholder', undefined, 'e.g. 1.2 / original / test copy');
      input.disabled = mutationBlocked();
      input.addEventListener('input', () => { state.archiveLabel = input.value; });
      row.append(el('span', null, t('ui.archive.label', undefined, 'Version label (optional)')), input);
      const button = el('button', 'primary archive-import', t('ui.archive.import', undefined, 'Import as a separate version'));
      button.disabled = !archiveCandidatePresentation(candidate, mutationBlocked()).canImport;
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
  for (const record of state.archiveRecords) {
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

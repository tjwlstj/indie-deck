import { el, setStatus } from '../dom.js';
import { t } from '../i18n.js';
import { mutationBlocked, state } from '../store.js';
import {
  canConfirmTranslatorMaintenance,
  captureTranslatorMaintenance,
  translatorMaintenancePresentation,
} from '../maintenance-model.js';

function fileList(files) {
  const list = el('ul', 'maintenance-files');
  for (const file of files) {
    const row = el('li');
    row.append(el('code', null, file.path), el('span', 'muted-text', ` · ${file.size} B`));
    row.title = `SHA-256: ${file.sha256}`;
    list.append(row);
  }
  return list;
}

function confirmMaintenance(context, kind) {
  if (mutationBlocked()) return;
  const captured = captureTranslatorMaintenance(context, kind);
  if (!captured) return;
  document.getElementById('translatorMaintenanceConfirm')?.remove();
  const dialog = el('dialog', 'maintenance-confirm');
  dialog.id = 'translatorMaintenanceConfirm';
  const heading = el('h2', null, kind === 'remove-translator'
    ? t('ui.maintenance.confirmRemove', undefined, 'Remove existing translator files?')
    : t('ui.maintenance.confirmReinstall', undefined, 'Clean up and reinstall the translator?'));
  heading.id = 'translatorMaintenanceConfirmTitle';
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(heading,
    el('p', null, t('ui.maintenance.confirmScope', { count: captured.files.length }, 'Only these {count} recognized translator files will be backed up and removed.')),
    fileList(captured.files),
    el('p', 'maintenance-safety', t('ui.maintenance.preserve', undefined, 'Game files, loaders, unrelated mods, fonts, translation settings and saved translations are kept. Unknown or unsafe files block automatic cleanup.')),
  );
  if (kind === 'reinstall-translator') dialog.append(el('p', null,
    t('ui.maintenance.reinstallScope', { version: captured.targetVersion ?? '?' }, 'After cleanup, install the compatible registered translator build {version}. Existing settings are retained.')));
  dialog.append(el('p', 'maintenance-safety', t('ui.maintenance.closeGame', undefined, 'Close the game and external translation tools first. Keep the backup until you have checked the game.')));
  const actions = el('div', 'maintenance-actions');
  const cancel = el('button', 'ghost', t('ui.maintenance.cancel', undefined, 'Cancel'));
  cancel.addEventListener('click', () => dialog.close());
  const confirm = el('button', 'primary translator-confirm', kind === 'remove-translator'
    ? t('ui.maintenance.remove', undefined, 'Clean up existing translator')
    : t('ui.maintenance.reinstall', undefined, 'Clean up and reinstall'));
  confirm.addEventListener('click', () => {
    if (mutationBlocked() || !canConfirmTranslatorMaintenance(state, captured)) {
      setStatus(t('ui.maintenance.reason.stale', undefined, 'The game or cleanup preview changed. Refresh and review a new preview.'), 'err');
      dialog.close();
      return;
    }
    dialog.close();
    window.dispatchEvent(new CustomEvent('indiedeck:translator-maintenance', { detail: {
      gameId: captured.gameId, kind: captured.kind, planId: captured.planId,
    } }));
  });
  actions.append(cancel, confirm);
  dialog.append(actions);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}

export function renderTranslatorMaintenance(panel, context) {
  const preview = context.translatorMaintenance;
  const presentation = translatorMaintenancePresentation(context, mutationBlocked());
  panel.append(el('h3', null, t('ui.maintenance.title', undefined, 'Existing Unity translator maintenance')));
  const card = el('section', 'translator-maintenance');
  card.append(el('p', null, t('ui.maintenance.description', undefined, 'Review recognized XUnity.AutoTranslator files before cleanup or replacement. No files are deleted merely because a game was scanned.')));
  const versions = (preview.currentVersions ?? []).join(', ');
  if (versions) card.append(el('p', 'plan-sub', t('ui.maintenance.versions', { versions, target: preview.targetVersion ?? '?' }, 'Detected: {versions} · Registered replacement: {target}')));
  if (presentation.files.length > 0) {
    const details = el('details', 'maintenance-preview');
    details.append(el('summary', null, t('ui.maintenance.files', { count: presentation.files.length }, '{count} cleanup candidate file(s)')),
      fileList(presentation.files));
    card.append(details);
  }
  if (preview.blockedReason) card.append(el('p', 'maintenance-safety maintenance-remove-reason', preview.blockedReason));
  if (preview.reinstallBlockedReason && preview.reinstallBlockedReason !== preview.blockedReason) {
    card.append(el('p', 'maintenance-safety maintenance-reinstall-reason', preview.reinstallBlockedReason));
  }
  card.append(el('p', 'maintenance-help', t('ui.maintenance.preserve', undefined, 'Game files, loaders, unrelated mods, fonts, translation settings and saved translations are kept. Unknown or unsafe files block automatic cleanup.')));
  const actions = el('div', 'maintenance-actions');
  const remove = el('button', 'ghost translator-remove', t('ui.maintenance.remove', undefined, 'Clean up existing translator'));
  remove.disabled = !presentation.canRemove;
  remove.addEventListener('click', () => confirmMaintenance(context, 'remove-translator'));
  const reinstall = el('button', 'primary translator-reinstall', t('ui.maintenance.reinstall', undefined, 'Clean up and reinstall'));
  reinstall.disabled = !presentation.canReinstall;
  reinstall.addEventListener('click', () => confirmMaintenance(context, 'reinstall-translator'));
  actions.append(remove, reinstall);
  card.append(actions);
  panel.append(card);
}

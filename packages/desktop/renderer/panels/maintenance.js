import { el, setStatus } from '../dom.js';
import { t } from '../i18n.js';
import { mutationBlocked, state } from '../store.js';
import { comparisonRowGroups, comparisonValue, providerComparisonValue } from '../config-model.js';
import {
  canConfirmTranslatorMaintenance,
  captureTranslatorMaintenance,
  translatorMaintenancePresentation,
} from '../maintenance-model.js';

function comparisonText(row, target = false) {
  const presentation = comparisonValue(row, target);
  const fallbacks = { empty: '(empty)', unknownValue: 'Unknown', notInFile: 'Not in file · reference: {value}',
    secretConfigured: 'Configured · value hidden', secretMissing: 'Not configured', secretReference: 'Credential value is not compared' };
  const value = presentation.value === '' ? t('ui.configComparison.empty', undefined, '(empty)') : presentation.value;
  return presentation.key ? t(`ui.configComparison.${presentation.key}`, { value }, fallbacks[presentation.key]) : presentation.value;
}

function comparisonTable(rows) {
  const wrap = el('div', 'comparison-table-wrap');
  const table = el('table', 'comparison-table');
  const head = el('thead');
  const heading = el('tr');
  for (const [key, fallback] of [['optionColumn', 'Option'], ['currentColumn', 'Current option'],
    ['targetColumn', 'Registered schema default (reference)'], ['statusColumn', 'Reinstall behavior']]) {
    const cell = el('th', null, t(`ui.configComparison.${key}`, undefined, fallback));
    cell.scope = 'col'; heading.append(cell);
  }
  head.append(heading); table.append(head);
  const body = el('tbody');
  const statuses = { retained: 'Existing value retained', relocated: 'Mapping changed · manual review', 'new-default': 'New target option · reference',
    unsupported: 'Unavailable in target schema', unmapped: 'Mapping unconfirmed' };
  for (const row of rows) {
    const node = el('tr', 'comparison-row');
    node.dataset.optionId = row.id; node.dataset.status = row.status;
    const label = el('th', null, row.label || row.id); label.scope = 'row';
    if ([row.currentLocation, row.targetLocation].some((location) => location && (location.assumed || location.confidence !== 'verified'))) {
      label.append(el('span', 'pill warn', t('ui.config.assumed', undefined, 'assumed')));
    }
    const statusKey = row.status === 'new-default' ? row.introduced === false ? 'missingOption' : 'newDefault' : row.status;
    const statusText = statusKey === 'missingOption' ? 'Not in current file · default reference' : statuses[row.status] || row.status;
    node.append(label, el('td', 'comparison-current', comparisonText(row)), el('td', 'comparison-target', comparisonText(row, true)),
      el('td', 'comparison-status', t(`ui.configComparison.${statusKey}`, undefined, statusText)));
    body.append(node);
  }
  table.append(body); wrap.append(table);
  return wrap;
}

/** Read-only report bound to the shown cleanup preview. Reinstall preserves
 * bytes; target defaults describe our schema rather than a simulated migration. */
export function renderOptionComparison(report) {
  const card = el('section', 'maintenance-option-comparison');
  card.append(el('h4', null, t('ui.configComparison.title', undefined, 'Current options and replacement version')));
  if (!report?.available) {
    card.append(el('p', 'maintenance-help', report?.reasonKey ? t(report.reasonKey)
      : t('ui.configComparison.unavailable', undefined, 'Option comparison is unavailable. Existing settings are still preserved.')));
    return card;
  }
  card.append(el('p', 'comparison-summary', t('ui.configComparison.versions', {
    current: report.currentVersion?.version || t('ui.configComparison.unknownValue', undefined, 'Unknown'),
    target: report.targetVersion || t('ui.configComparison.unknownValue', undefined, 'Unknown'),
  }, 'Current {current} → registered replacement {target}')),
  el('p', 'maintenance-help', t('ui.configComparison.scope', undefined,
    'Reinstall keeps the existing settings file. The right column is a registered schema reference; plugin migration is not simulated.')));
  if (report.currentVersion?.ambiguous) card.append(el('p', 'maintenance-safety', t('ui.configComparison.ambiguousVersion', undefined,
    'Multiple translator versions were detected, so the current option mapping cannot be confirmed.')));
  if (report.currentVersion?.source === 'config-tag' || report.currentVersion?.confidence !== 'verified') {
    card.append(el('p', 'maintenance-safety comparison-version-hint', t('ui.configComparison.versionHint', undefined,
      'The current version is a hint rather than verified assembly evidence. Version-dependent mappings need review.')));
  }
  const currentFile = report.configFile?.path;
  const targetFile = report.targetConfigFile?.path || report.configFile?.targetPath;
  if (report.configPathChanged || report.configFile?.pathChanged) {
    card.append(el('p', 'maintenance-safety comparison-path-warning', t('ui.configComparison.pathChanged',
      { current: currentFile || '?', target: targetFile || '?' },
      'Settings location differs: {current} → {target}. Reinstall does not move the existing file automatically.')));
  }
  if (report.configFile?.exists === false) card.append(el('p', 'maintenance-help', t('ui.configComparison.configMissing', undefined,
    'The settings file has not been generated. Current values shown here are schema references.')));
  const groups = comparisonRowGroups(report);
  if (groups.main.length) card.append(comparisonTable(groups.main));
  const advanced = el('details', 'comparison-technical');
  advanced.append(el('summary', null, t('ui.configComparison.advanced', { count: groups.advanced.length }, 'More options and mapping details ({count})')));
  if (groups.advanced.length) advanced.append(comparisonTable(groups.advanced));
  for (const row of [...groups.main, ...groups.advanced]) {
    if (!row.currentLocation && !row.targetLocation) continue;
    const original = row.currentLocation ? `[${row.currentLocation.section}] ${row.currentLocation.key}` : '?';
    const target = row.targetLocation ? `[${row.targetLocation.section}] ${row.targetLocation.key}` : '?';
    const evidence = t('ui.configComparison.mappingEvidence', {
      current: row.currentLocation?.confidence || '?', target: row.targetLocation?.confidence || '?',
    }, 'mapping evidence: {current} → {target}');
    advanced.append(el('p', 'plan-sub', `${row.label || row.id}: ${original} → ${target} · ${evidence}`));
  }
  if (currentFile) advanced.append(el('p', 'plan-sub', t('ui.configComparison.sourceFile', { path: currentFile }, 'Current file: {path}')));
  if (targetFile) advanced.append(el('p', 'plan-sub', t('ui.configComparison.targetFile', { path: targetFile }, 'Target file: {path}')));
  if (report.coverage) advanced.append(el('p', 'plan-sub', t('ui.configComparison.coverage', {
    described: report.coverage.described, total: report.coverage.total, mapped: report.coverage.targetMapped,
  }, '{described}/{total} existing keys described; {mapped} target mappings known')));
  card.append(advanced);
  const providers = (Array.isArray(report.providers) ? report.providers : []).filter((provider) => provider.selected);
  if (providers.length) {
    const credentials = el('details', 'comparison-technical');
    credentials.append(el('summary', null, t('ui.configComparison.credentials', undefined, 'Credential settings kept')),
      el('p', 'maintenance-help', t('ui.configComparison.credentialsNote', undefined, 'Credential values stay hidden; only configured status is shown. Boolean and numeric options show their current value.')));
    for (const provider of providers) {
      credentials.append(el('strong', null, provider.label || provider.id));
      if (provider.roles?.length) credentials.append(el('p', 'plan-sub', provider.roles.map((role) =>
        t(`ui.configComparison.role.${role}`, undefined, role)).join(' · ')));
      if (provider.versionRequirement) {
        const condition = provider.versionRequirement;
        const match = (value) => t(`ui.configComparison.requirement.${value === true ? 'met' : value === false ? 'unmet' : 'unknown'}`);
        credentials.append(el('p', 'maintenance-help comparison-provider-requirement', t('ui.configComparison.providerRequirement', {
          min: condition.min || '—', max: condition.max || '—',
          current: match(provider.currentMeetsRequirement), target: match(provider.targetMeetsRequirement),
        }, 'Registered version requirement {min}…{max} · current: {current} · replacement: {target}')));
        if (condition.reason) credentials.append(el('p', 'maintenance-help', condition.reason));
        credentials.append(el('p', 'maintenance-help', t('ui.configComparison.requirementScope', undefined,
          'This checks registered version metadata, not API login or translation success.')));
      }
      for (const field of provider.fields ?? []) {
        const value = providerComparisonValue(field);
        credentials.append(el('p', 'plan-sub', `${field.label || field.key}: ${value !== undefined ? value : field.configured
          ? t('ui.configComparison.configured', undefined, 'Configured') : t('ui.configComparison.missing', undefined, 'Not configured')}`));
      }
    }
    card.append(credentials);
  }
  if (report.unknownKeys?.length) {
    const unknown = el('details', 'comparison-technical comparison-unknown');
    unknown.append(el('summary', null, t('ui.configComparison.unknownKeys', { count: report.unknownKeyCount ?? report.unknownKeys.length }, 'Other keys kept ({count})')),
      el('p', 'maintenance-help', t('ui.configComparison.unknownNote', undefined, 'Unrecognized settings are preserved. Their values are not displayed in this report.')));
    const list = el('ul');
    for (const key of report.unknownKeys) list.append(el('li', null, `[${key.section}] ${key.key}`));
    if (report.unknownKeysTruncated) unknown.append(el('p', 'maintenance-help', t('ui.configComparison.truncated', { count: report.unknownKeys.length }, 'Showing the first {count} names; all keys remain preserved.')));
    unknown.append(list); card.append(unknown);
  }
  return card;
}

export function openOptionComparisonDialog(report) {
  document.getElementById('translatorOptionsComparisonDialog')?.remove();
  const dialog = el('dialog', 'maintenance-confirm option-comparison-dialog');
  dialog.id = 'translatorOptionsComparisonDialog';
  const title = el('h2', null, t('ui.configComparison.reviewPrevious', undefined, 'Review pre-reinstall options'));
  title.id = 'translatorOptionsComparisonTitle'; dialog.setAttribute('aria-labelledby', title.id);
  const close = el('button', 'ghost', t('ui.operation.dismiss', undefined, 'Close'));
  close.addEventListener('click', () => dialog.close());
  dialog.append(title, renderOptionComparison(report), close);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal(); close.focus({ preventScroll: true }); dialog.scrollTop = 0;
}

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
  const optionComparison = context.translatorMaintenance?.optionComparison
    ? structuredClone(context.translatorMaintenance.optionComparison) : null;
  document.getElementById('translatorMaintenanceConfirm')?.remove();
  const dialog = el('dialog', 'maintenance-confirm');
  dialog.id = 'translatorMaintenanceConfirm';
  const heading = el('h2', null, kind === 'remove-translator'
    ? t('ui.maintenance.confirmRemove', undefined, 'Remove existing translator files?')
    : t('ui.maintenance.confirmReinstall', undefined, 'Clean up and reinstall the translator?'));
  heading.id = 'translatorMaintenanceConfirmTitle';
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(heading);
  if (kind === 'reinstall-translator') dialog.append(el('p', null,
    t('ui.maintenance.reinstallScope', { version: captured.targetVersion ?? '?' }, 'After cleanup, install the compatible registered translator build {version}. Existing settings are retained.')),
    renderOptionComparison(optionComparison));
  dialog.append(el('p', null, t('ui.maintenance.confirmScope', { count: captured.files.length }, 'Only these {count} recognized translator files will be backed up and removed.')));
  if (kind === 'reinstall-translator') {
    const candidates = el('details', 'maintenance-cleanup-files');
    candidates.append(el('summary', null, t('ui.maintenance.files', { count: captured.files.length }, '{count} cleanup candidate file(s)')), fileList(captured.files));
    dialog.append(candidates);
  } else dialog.append(fileList(captured.files));
  dialog.append(el('p', 'maintenance-safety', t('ui.maintenance.preserve', undefined, 'Game files, loaders, unrelated mods, fonts, translation settings and saved translations are kept. Unknown or unsafe files block automatic cleanup.')));
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
  cancel.focus({ preventScroll: true }); dialog.scrollTop = 0;
}

export function renderTranslatorMaintenance(panel, context) {
  const preview = context.translatorMaintenance;
  const presentation = translatorMaintenancePresentation(context, mutationBlocked());
  panel.append(el('h3', null, t('ui.maintenance.title', undefined, 'Existing Unity translator maintenance')));
  const card = el('section', 'translator-maintenance');
  card.append(el('p', null, t('ui.maintenance.description', undefined, 'Review recognized XUnity.AutoTranslator files before cleanup or replacement. No files are deleted merely because a game was scanned.')));
  const versions = (preview.currentVersions ?? []).join(', ');
  if (versions) card.append(el('p', 'plan-sub', t('ui.maintenance.versions', { versions, target: preview.targetVersion ?? '?' }, 'Detected: {versions} · Registered replacement: {target}')));
  if (preview.canReinstall || preview.optionComparison) card.append(renderOptionComparison(preview.optionComparison));
  if (context.lastOptionComparison) {
    const review = el('button', 'ghost last-option-comparison', t('ui.configComparison.reviewPrevious', undefined, 'Review pre-reinstall options'));
    review.addEventListener('click', () => openOptionComparisonDialog(context.lastOptionComparison));
    card.append(review);
  }
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

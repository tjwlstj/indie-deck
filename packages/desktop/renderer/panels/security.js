import { $, el, setStatus } from '../dom.js';
import { currentLocale, t } from '../i18n.js';
import { api, mutationBlocked } from '../store.js';
import {
  acceptSecurityRead, applySecuritySnapshot, beginSecurityRead, canCancelSecurityTask,
  createSecurityViewState, failSecurityRead, isSecurityBusy, normalizeSecurityResult, securityPresentation,
} from '../security-model.js';

const view = createSecurityViewState();
let bound = false;
let gameContext = null;
const reasons = new Set(['unsupported-platform', 'engine-missing', 'engine-untrusted', 'engine-unavailable', 'stale-signatures',
  'status-error', 'unsafe-target', 'target-changed', 'engine-changed', 'scan-limit', 'timed-out', 'cancelled', 'busy',
  'engine-attention', 'permission-denied', 'engine-error', 'output-limit']);

export function getSecuritySnapshot() { return view.snapshot ? structuredClone(view.snapshot) : null; }
export function securityRequestPending() { return isSecurityBusy(view.snapshot, view.action); }

function display() {
  return securityPresentation(view.snapshot, { mutationBlocked: mutationBlocked(), action: view.action,
    readPending: view.readPending, readError: view.readError });
}

function notify(previous) {
  const before = previous?.task, after = view.snapshot?.task;
  if (gameContext && after?.gameId === gameContext.profile.id && after.status !== 'running' && after.result) {
    gameContext = { ...gameContext, securityResult: after.result };
  }
  window.dispatchEvent(new CustomEvent('indiedeck:security-state', { detail: {
    snapshot: getSecuritySnapshot(), busy: securityRequestPending(),
    terminalChanged: Boolean(after && after.status !== 'running' && (before?.id !== after.id || before?.status !== after.status)),
  } }));
  renderSecuritySettings();
  renderLiveGameSecurity();
}

function accept(snapshot) {
  const previous = view.snapshot;
  if (applySecuritySnapshot(view, snapshot)) notify(previous);
}

export function bindSecurityEvents() {
  if (bound) return;
  bound = true;
  if (typeof api.security?.onStatus !== 'function') { view.readError = true; return; }
  api.security.onStatus(accept);
}

/** The normal boot/reload read does not start a scan or update. */
export async function refreshSecurityStatus(probe = false) {
  const token = beginSecurityRead(view);
  renderSecuritySettings();
  try {
    const method = probe ? api.security?.refresh : api.security?.current;
    if (typeof method !== 'function') throw new Error('unavailable');
    const snapshot = await method();
    const previous = view.snapshot;
    if (acceptSecurityRead(view, token, snapshot)) notify(previous);
  } catch {
    if (failSecurityRead(view, token)) notify(view.snapshot);
  }
  renderSecuritySettings();
}

function reasonText(reason) {
  return t(`ui.security.reason.${reasons.has(reason) ? reason : 'unknown'}`);
}

function dateText(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  try { return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
  catch { return date.toISOString(); }
}

function engineCard(engine) {
  const card = el('section', `security-engine ${engine?.state ?? 'loading'}`);
  card.setAttribute('role', 'status'); card.setAttribute('aria-live', 'polite');
  card.append(el('strong', null, t('ui.security.provider', undefined, 'Microsoft Defender')),
    el('p', 'security-engine-state', t(`ui.security.engine.${engine?.state ?? 'loading'}`)));
  if (engine?.signatureVersion) card.append(el('p', 'plan-sub', t('ui.security.signatureVersion', { version: engine.signatureVersion }, 'Security intelligence: {version}')));
  if (engine?.engineVersion) card.append(el('p', 'plan-sub', t('ui.security.engineVersion', { version: engine.engineVersion }, 'Engine: {version}')));
  if (engine?.signatureAgeDays !== undefined) card.append(el('p', 'plan-sub', t('ui.security.signatureAge', { days: Math.floor(engine.signatureAgeDays) }, 'Intelligence age: {days} day(s)')));
  if (engine?.realTimeProtectionEnabled === false) card.append(el('p', 'security-warning', t('ui.security.realTimeOff', undefined, 'Windows reports that real-time protection is off. Review Windows Security.')));
  if (engine?.reason) card.append(el('p', 'security-warning', reasonText(engine.reason)));
  return card;
}

function resultCard(value) {
  const result = normalizeSecurityResult(value);
  if (!result) return null;
  const card = el('section', `security-result ${result.verdict}`);
  card.dataset.verdict = result.verdict;
  if (result.fingerprint) card.dataset.scope = result.fingerprint.scope;
  card.append(el('strong', 'security-result-verdict', t(`ui.security.verdict.${result.verdict}`)));
  if (result.fingerprint) card.append(el('p', 'security-result-scope', t(`ui.security.scope.${result.fingerprint.scope}`)));
  card.append(el('p', 'security-help', t(result.verdict === 'clean' ? 'ui.security.cleanScope' : 'ui.security.resultScope')));
  if (result.reason) card.append(el('p', 'security-warning', reasonText(result.reason)));
  const completed = dateText(result.completedAt ?? result.checkedAt);
  if (completed) card.append(el('p', 'plan-sub', t('ui.security.completedAt', { time: completed }, 'Completed: {time}')));
  if (result.signatureVersion) card.append(el('p', 'plan-sub', t('ui.security.checkedSignature', { version: result.signatureVersion }, 'Intelligence used: {version}')));
  if (result.fingerprint) card.append(el('p', 'plan-sub', t('ui.security.targetScope', { count: result.fingerprint.files }, 'Target fingerprint: {count} file(s)')));
  return card;
}

function taskCard(task) {
  if (!task) return null;
  const card = el('section', `security-task ${task.status}`);
  card.dataset.taskId = task.id; card.dataset.taskStatus = task.status;
  card.setAttribute('role', 'status'); card.setAttribute('aria-live', 'polite');
  card.append(el('strong', null, t(`ui.security.kind.${task.kind}`)),
    el('p', 'security-task-status', t(`ui.security.task.${task.status}`)));
  if (task.status === 'running') {
    const progress = el('progress', 'security-progress');
    progress.setAttribute('aria-label', t(`ui.security.kind.${task.kind}`));
    card.append(progress, el('p', 'security-help', t('ui.security.indeterminate', undefined, 'The engine does not provide a reliable percentage. Waiting for its result…')));
    const cancel = el('button', 'ghost security-cancel', t('ui.security.cancel', undefined, 'Cancel scan task'));
    const capturedId = task.id;
    cancel.disabled = !canCancelSecurityTask(view.snapshot, capturedId, view.action);
    cancel.addEventListener('click', () => void cancelTask(capturedId));
    card.append(cancel);
  }
  if (task.result) card.append(resultCard(task.result));
  if (task.updateResult) {
    card.append(el('p', `security-update-result${task.updateResult.state === 'updated' ? '' : ' security-warning'}`,
      t(`ui.security.updateResult.${task.updateResult.state}`)));
    if (task.updateResult.reason) card.append(el('p', 'security-warning', reasonText(task.updateResult.reason)));
  } else if (task.error && !task.result) card.append(el('p', 'security-warning', t('ui.security.actionFailed')));
  return card;
}

async function cancelTask(capturedId) {
  if (!canCancelSecurityTask(view.snapshot, capturedId, view.action)) return;
  view.action = 'cancel'; notify(view.snapshot);
  try { accept(await api.security.cancel(capturedId)); }
  catch { setStatus(t('ui.security.cancelFailed'), 'err'); }
  finally { view.action = null; notify(view.snapshot); await refreshSecurityStatus(); }
}

async function runAction(kind, gameId) {
  const permission = display();
  if (!(kind === 'signature-update' ? permission.canUpdate : permission.canScan)) return;
  view.action = kind; notify(view.snapshot);
  try {
    const snapshot = kind === 'signature-update' ? await api.security.update() : await api.security.scanGame(gameId);
    accept(snapshot);
  } catch { setStatus(t('ui.security.actionFailed'), 'err'); }
  finally { view.action = null; notify(view.snapshot); await refreshSecurityStatus(); }
}

async function openHelp(action) {
  if (mutationBlocked() || !['windows-security', 'malware-zero'].includes(action)) return;
  try { await api.security.openHelp(action); }
  catch { setStatus(t('ui.security.helpFailed'), 'err'); }
}

export function renderSecuritySettings() {
  const body = $('securitySettingsBody');
  if (!body) return;
  body.replaceChildren();
  const card = el('section', 'security-settings-card');
  card.append(engineCard(view.snapshot?.engine));
  if (view.readError) card.append(el('p', 'security-warning security-read-error', t('ui.security.statusReadFailed')));
  card.append(el('p', 'security-help', t('ui.security.gateHelp')));
  const currentTask = taskCard(view.snapshot?.task);
  if (currentTask) card.append(currentTask);
  const actions = el('div', 'security-actions');
  const refresh = el('button', 'ghost security-refresh', t('ui.security.refresh', undefined, 'Refresh engine status'));
  refresh.disabled = !display().canRefresh;
  refresh.addEventListener('click', () => void refreshSecurityStatus(true));
  const update = el('button', 'ghost security-update', t('ui.security.update', undefined, 'Update security intelligence'));
  update.disabled = !display().canUpdate;
  update.addEventListener('click', () => void runAction('signature-update'));
  const windows = el('button', 'ghost security-help-windows', t('ui.security.openWindows', undefined, 'Open Windows Security'));
  windows.disabled = mutationBlocked() || !api.security?.openHelp;
  windows.addEventListener('click', () => void openHelp('windows-security'));
  const malwareZero = el('button', 'ghost security-help-mz', t('ui.security.openMalwareZero', undefined, 'Malware Zero official site'));
  malwareZero.disabled = mutationBlocked() || !api.security?.openHelp;
  malwareZero.addEventListener('click', () => void openHelp('malware-zero'));
  actions.append(refresh, update, windows, malwareZero); card.append(actions);
  card.append(el('p', 'security-help', t('ui.security.updateHelp')),
    el('p', 'security-help security-mz-note', t('ui.security.malwareZeroHelp')),
    el('p', 'security-help', t('ui.security.policyHelp')));
  body.append(card);
}

function fillGameSecurity(card, context) {
  card.replaceChildren();
  const gameId = context.profile.id, task = view.snapshot?.task;
  const relevantTask = task?.gameId === gameId ? taskCard(task) : null;
  if (relevantTask) card.append(relevantTask);
  else {
    const result = resultCard(context.securityResult);
    if (result) card.append(result);
    else card.append(el('p', 'security-help', t('ui.security.noGameScan', undefined, 'This game has no current completed security check.')));
    if (task?.status === 'running') card.append(el('p', 'security-warning', t('ui.security.otherTask', undefined, 'Another security task is running.')));
  }
  const scan = el('button', 'ghost game-security-scan', t('ui.security.scanGame', undefined, 'Scan this game folder'));
  scan.disabled = !display().canScan;
  scan.addEventListener('click', () => void runAction('scan-game', gameId));
  card.append(scan, el('p', 'security-help', t('ui.security.gameScope')));
  if (view.readError || view.snapshot?.engine?.state !== 'ready') card.append(el('p', 'security-warning', t('ui.security.needsEngine')));
}

function renderLiveGameSecurity() {
  const card = $('gameSecurityBody');
  if (!card || !gameContext || card.dataset.gameId !== gameContext.profile.id) return;
  fillGameSecurity(card, gameContext);
}

export function renderGameSecurity(panel, context) {
  gameContext = context;
  panel.append(el('h3', null, t('ui.security.gameTitle', undefined, 'Game security check')));
  const card = el('section', 'game-security');
  card.id = 'gameSecurityBody'; card.dataset.gameId = context.profile.id;
  fillGameSecurity(card, context); panel.append(card);
}

/** Local external-tool handoff. Opening MTool never means translation succeeded. */

import { $, el, setStatus } from '../dom.js';
import { t } from '../i18n.js';
import {
  acceptMToolStatusResponse,
  applyMToolStatus,
  beginMToolStatusRequest,
  failMToolStatusRequest,
  mtoolPresentation,
} from '../mtool-model.js';
import { mergePostMutationState } from '../state-model.js';
import { api, emit, mutationBlocked, state } from '../store.js';
import { resetConfigPanel } from './config.js';

function statusLabel(integration) {
  if (state.mtoolStatusLoading) {
    return el('span', 'pill info', t('ui.mtool.status.checking', undefined, 'Checking tool folder…'));
  }
  const presentation = mtoolPresentation(integration);
  const fallback = {
    ready: 'Ready to open', missing: 'Not found', disabled: 'Disconnected', invalid: 'Check tool folder',
  }[presentation.status];
  return el('span', `pill ${presentation.tone}`, t(presentation.statusKey, undefined, fallback));
}

function reasonText(integration) {
  if (!integration?.reasonKey && !integration?.reason) return '';
  return t(integration.reasonKey, undefined, integration.reason);
}

function actionButton(textKey, fallback, action, { primary = false, disabled = false, className = '' } = {}) {
  const button = el('button', `${primary ? 'primary' : 'ghost'} ${className}`.trim(), t(textKey, undefined, fallback));
  button.type = 'button';
  button.disabled = disabled;
  button.addEventListener('click', () => {
    if (button.disabled) return;
    void action().catch((err) => setStatus(err.message, 'err'));
  });
  return button;
}

async function handoff(action) {
  if (mutationBlocked() || state.mtoolStatusLoading) return;
  state.mtoolBusy = true;
  emit('operation');
  try {
    const result = await action();
    if (result?.opened) {
      setStatus(t('ui.mtool.opened', undefined, 'Requested MTool to open. Select the language and start translation in its window.'), 'ok');
    }
    return result;
  } catch (error) {
    // A move/removal after the last read must not leave a stale Ready button.
    // Keep the original handoff error visible even if this read also fails.
    try { await refreshMToolStatus(); } catch { /* The failed probe already closed the UI gate. */ }
    throw error;
  } finally {
    state.mtoolBusy = false;
    emit('all');
  }
}

async function updateConnection(action) {
  const result = await handoff(action);
  if (!result) return;
  state.config = result.config;
  applyMToolStatus(state, result.mtoolStatus);
  renderMToolSettings();
  emit('all');
  window.dispatchEvent(new CustomEvent('indiedeck:refresh-detail'));
}

/** Re-probe whenever settings opens, rather than trusting the boot snapshot. */
export async function refreshMToolStatus() {
  const token = beginMToolStatusRequest(state);
  emit('operation');
  try {
    const status = await api.mtool.status();
    if (!acceptMToolStatusResponse(state, token, status)) return false;
    emit('all');
    return true;
  } catch (error) {
    if (!failMToolStatusRequest(state, token)) return false;
    emit('all');
    throw error;
  }
}

function openSettings() {
  window.dispatchEvent(new CustomEvent('indiedeck:open-settings', { detail: { section: 'mtoolSettings' } }));
}

export function renderMToolSettings() {
  const body = $('mtoolSettingsBody');
  if (!body) return;
  body.replaceChildren();
  const integration = state.mtoolStatus;
  const blocked = mutationBlocked() || state.mtoolStatusLoading;
  const presentation = mtoolPresentation(integration, blocked);
  const head = el('div', 'mtool-head');
  head.append(statusLabel(integration));
  if (integration?.source) {
    head.append(el('span', 'mtool-source', t(`ui.mtool.source.${integration.source}`, undefined, integration.source)));
  }
  body.append(head);
  if (integration?.root) body.append(el('div', 'path mtool-path', integration.root));
  if (integration?.executable) body.append(el('div', 'path mtool-executable', integration.executable));
  const reason = reasonText(integration);
  if (reason) body.append(el('p', 'mtool-help', reason));

  body.append(el('p', 'mtool-help', t('ui.mtool.settingsHint', undefined, 'Choose an existing MTool package folder. IndieDeck does not download, copy or update MTool. Disconnecting keeps all MTool files.')));
  const actions = el('div', 'mtool-actions');
  actions.append(
    actionButton('ui.mtool.pick', 'Choose MTool folder', () => updateConnection(() => api.mtool.pick()), {
      primary: !presentation.canOpen, disabled: blocked, className: 'mtool-mutation mtool-pick',
    }),
    actionButton('ui.mtool.disconnect', 'Disconnect', () => updateConnection(() => api.mtool.clear()), {
      disabled: blocked || presentation.status === 'disabled', className: 'mtool-mutation mtool-disconnect',
    }),
    actionButton('ui.mtool.open', 'Open MTool only', () => handoff(() => api.mtool.open()), {
      disabled: !presentation.canOpen, className: 'mtool-mutation mtool-open',
    }),
    actionButton('ui.mtool.folder', 'MTool folder', () => api.mtool.openFolder(), {
      disabled: !presentation.canOpenFolder,
    }),
  );
  actions.querySelector('.mtool-pick').id = 'mtoolPick';
  actions.querySelector('.mtool-disconnect').id = 'mtoolClear';
  body.append(actions);
}

/** The card keeps game identity captured; post-refresh state merges by revision. */
export function renderMToolIntegration(panel, ctx) {
  const integration = ctx.mtoolIntegration;
  if (!integration?.supported) return;
  const gameId = ctx.profile.id;
  const presentation = mtoolPresentation(integration, mutationBlocked() || state.mtoolStatusLoading);
  panel.append(el('h3', null, t('ui.mtool.title', undefined, 'RPG Maker · local MTool')));
  const card = el('section', `mtool-integration ${presentation.status}`);
  const head = el('div', 'mtool-head');
  head.append(el('strong', null, t('ui.mtool.recommended', undefined, 'Use your local MTool')), statusLabel(integration));
  card.append(head);
  if (integration?.root) card.append(el('div', 'path mtool-path', integration.root));
  card.append(el('p', 'mtool-description', t('ui.mtool.description', undefined, 'Opens your existing MTool with this game’s executable. It does not install a second translator or start translation automatically.')));
  const reason = reasonText(integration);
  if (reason) card.append(el('p', 'mtool-help', reason));
  if (!presentation.canLocateGame) {
    card.append(el('p', 'mtool-block-reason', t('ui.mtool.gameUnavailable', undefined, 'The game executable is missing or its path is unsafe. Refresh the game folder.')));
  }

  const actions = el('div', 'mtool-actions');
  if (presentation.status === 'ready') {
    actions.append(
      actionButton('ui.mtool.launch', 'Open game in MTool', async () => {
        if (state.selected !== gameId) return;
        await handoff(() => api.mtool.launch(gameId));
      }, { primary: true, disabled: !presentation.canLaunch, className: 'mtool-launch' }),
      actionButton('ui.mtool.open', 'Open MTool only', () => handoff(() => api.mtool.open()), {
        disabled: !presentation.canOpen, className: 'mtool-open',
      }),
    );
  } else {
    actions.append(actionButton('ui.mtool.configure', 'Connect MTool in settings', async () => openSettings()));
  }
  actions.append(
    actionButton('ui.mtool.gameFile', 'Locate game executable', () => api.mtool.selectGameFile(gameId), {
      disabled: !presentation.canLocateGame,
    }),
    actionButton('ui.mtool.folder', 'MTool folder', () => api.mtool.openFolder(), {
      disabled: !presentation.canOpenFolder,
    }),
    actionButton('ui.mtool.refresh', 'Refresh after applying', async () => {
      if (mutationBlocked()) return;
      const postState = await handoff(() => api.game.refresh(gameId));
      if (!postState) return;
      const merged = mergePostMutationState(state, postState);
      if (state.selected === gameId && (merged.detail || merged.translatorConfig)) {
        resetConfigPanel();
        setStatus(t('ui.mtool.refreshed', undefined, 'Game files rescanned. This does not verify translation worked.'), 'ok');
      }
      emit('all');
    }, { disabled: mutationBlocked() || state.mtoolStatusLoading, className: 'mtool-refresh' }),
  );
  card.append(actions);

  const steps = el('ol', 'mtool-steps');
  steps.append(
    el('li', null, t('ui.mtool.stepOpen', undefined, 'Open the game in MTool. If it is not selected automatically, drag the game executable into MTool.')),
    el('li', null, t('ui.mtool.stepApply', undefined, 'Select the language and press Start Translation in MTool. Its game detection and translation result must be checked there.')),
    el('li', null, t('ui.mtool.stepRefresh', undefined, 'After MTool finishes, refresh here to read the latest files.')),
  );
  card.append(
    steps,
    el('p', 'mtool-help', t('ui.mtool.externalChanges', undefined, 'MTool may change game files outside IndieDeck’s install records. Back up the game first; IndieDeck’s uninstall action cannot undo those changes.')),
    el('p', 'mtool-safety', t('ui.mtool.concurrentWarning', undefined, 'While MTool is working, do not run translator or mod installs for the same game in IndieDeck. Finish the external task and refresh before continuing.')),
    el('p', 'mtool-help', t('ui.mtool.runtimeCaveat', undefined, 'This is a local-tool handoff, not verified translation. MTool runtime behavior has not been tested from this launcher.')),
  );
  const docs = el('a', 'mtool-docs', t('ui.mtool.docs', undefined, 'MTool usage guide'));
  docs.href = '#';
  docs.addEventListener('click', (event) => {
    event.preventDefault();
    void api.open.url(integration.docsUrl).catch((err) => setStatus(err.message, 'err'));
  });
  card.append(docs);
  panel.append(card);
}

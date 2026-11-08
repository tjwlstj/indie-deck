import { el } from '../dom.js';
import { t } from '../i18n.js';
import { api, state } from '../store.js';

let bound = false;

function fill(card, context) {
  card.replaceChildren();
  card.append(el('p', 'plan-sub', t('ui.diagnostics.intro', undefined,
    'Observes games started by this launcher in the current session. Exit codes alone do not establish a crash or cause.')));
  if (!context.profile.executable) {
    card.append(el('p', 'security-warning', t('ui.diagnostics.noExe', undefined, 'No executable was identified.')),
      el('p', 'plan-sub', t('ui.diagnostics.noExeAdvice', undefined, 'Check the registered folder and the official launcher.')));
  }
  const result = context.launchDiagnostic;
  if (result?.kind === 'spawn-failed') {
    card.append(el('p', 'security-warning', t('ui.diagnostics.spawnFailed', undefined, 'The game process could not start.')),
      el('p', 'plan-sub', t('ui.diagnostics.spawnAdvice', undefined, 'Check the executable, permissions and the official launcher; review quarantine in Windows Security.')));
  } else if (result?.kind === 'nonzero-exit' && Number.isSafeInteger(result.code)) {
    card.append(el('p', 'security-warning', t('ui.diagnostics.nonzero', { code: result.code }, 'The launched process exited with code {code}.')),
      el('p', 'plan-sub', t('ui.diagnostics.nonzeroAdvice', undefined, 'Check the game’s own logs and run its official integrity check or repair tool.')));
  } else card.append(el('p', 'plan-sub', t('ui.diagnostics.noRecord', undefined, 'No launch problem recorded for the latest launch in this session.')));
}

function bind() {
  if (bound || !api.game?.onLaunchDiagnostic) return;
  bound = true;
  api.game.onLaunchDiagnostic((event) => {
    if (!event || typeof event.gameId !== 'string' || state.detail?.profile?.id !== event.gameId) return;
    const value = event.result;
    if (value !== null && !(value?.kind === 'spawn-failed' || value?.kind === 'nonzero-exit' && Number.isSafeInteger(value.code))) return;
    state.detail.launchDiagnostic = value;
    const card = document.getElementById('launchDiagnosticBody');
    if (card?.dataset.gameId === event.gameId) fill(card, state.detail);
  });
}

export function renderDiagnostics(panel, context) {
  bind();
  panel.append(el('h3', null, t('ui.diagnostics.title', undefined, 'Game launch diagnostics')));
  const card = el('section', 'game-diagnostics');
  card.id = 'launchDiagnosticBody'; card.dataset.gameId = context.profile.id;
  fill(card, context); panel.append(card);
}

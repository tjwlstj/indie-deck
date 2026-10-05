/**
 * The right-hand detail panel.
 *
 * It is assembled from a list of sections rather than one long function, so a
 * new panel is one entry in `SECTIONS` in `index.js` plus a render function
 * here - no surgery on a 300-line renderer.
 */

import { el, setStatus, severityMark, severityTone } from '../dom.js';
import { retranslate, t } from '../i18n.js';
import { api, mutationBlocked, state } from '../store.js';
import { fontChoiceKey, selectedFontPlan } from '../font-options.js';

// Opaque plan ids change on every fresh detail read. Keep this presentation
// choice by game/build identity instead, so progress renders do not reset it.
const fontChoices = new Map();

function operationText(operation) {
  if (operation.descriptionKey) return t(operation.descriptionKey, operation.descriptionParams, operation.description ?? operation.phase);
  return t(`ui.operation.phase.${operation.phase}`, operation.descriptionParams, operation.description ?? operation.phase);
}

function terminalText(operation) {
  const outcome = operation.outcome;
  if (!outcome) return operationText(operation);
  if (outcome.status === 'failed' && outcome.mutationStatus === 'committed') {
    return t(
      'ui.operation.failedCommitted',
      undefined,
      'Changes were applied, but the install record or final step failed. Review the error and current game state.',
    );
  }
  if (outcome.status === 'needs-user-action') {
    return t('ui.operation.needsAction', undefined, 'Automatic steps finished — more action is required.');
  }
  if (outcome.status === 'success') {
    if (outcome.refreshStatus === 'failed') {
      return t('ui.operation.refreshFailed', undefined, 'The file operation finished, but the latest state could not be loaded.');
    }
    return operation.kind === 'uninstall'
      ? t('ui.operation.removeComplete', undefined, 'Removal complete')
      : operation.kind === 'install-font'
        ? t('ui.operation.fontComplete', undefined, 'Recommended font setup complete')
        : t('ui.operation.installComplete', undefined, 'Installation complete');
  }
  if (outcome.mutationStatus === 'rolled-back' && outcome.rollbackStatus === 'not-run') {
    return t('ui.operation.stoppedBeforeChanges', undefined, 'The task stopped before any game files were changed.');
  }
  if (outcome.rollbackStatus === 'complete') {
    return t('ui.operation.failedRolledBack', undefined, 'The task failed. Changes were rolled back.');
  }
  return t('ui.operation.failedRollbackPartial', undefined, 'The task failed and some changes could not be restored.');
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** State-derived card: it survives detail re-renders, view switches and reload. */
export function operationCard(operation) {
  const outcome = operation.outcome;
  const tone = !outcome
    ? 'active'
    : outcome.status === 'failed'
      ? outcome.rollbackStatus === 'complete' ? 'warn' : 'err'
      : outcome.status === 'needs-user-action' || outcome.refreshStatus === 'failed'
        ? 'warn'
        : 'ok';
  const card = el('section', `operation-card ${tone}`);
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');

  const head = el('div', 'operation-head');
  head.append(
    el(
      'strong',
      null,
      operation.kind === 'uninstall'
        ? t('ui.operation.removing', undefined, 'Removing translator')
        : operation.kind === 'install-font'
          ? t('ui.operation.installingFont', undefined, 'Installing recommended font')
          : t('ui.operation.installing', undefined, 'Installing translator'),
    ),
    el('span', 'operation-phase', terminalText(operation)),
  );
  card.append(head);

  if (!outcome) {
    const bar = document.createElement('progress');
    bar.className = 'operation-progress';
    bar.max = 100;
    if (Number(operation.total) > 0) {
      bar.value = Math.max(0, Math.min(100, (Number(operation.received ?? 0) / Number(operation.total)) * 100));
    } else {
      bar.removeAttribute('value');
    }
    bar.setAttribute('aria-label', operationText(operation));
    card.append(bar);

    const meta = [];
    if (Number(operation.stepCount) > 0) {
      meta.push(
        t(
          'ui.operation.step',
          {
            current: Math.max(1, Math.min(Number(operation.stepIndex ?? 1), Number(operation.stepCount))),
            total: operation.stepCount,
          },
          'Step {current}/{total}',
        ),
      );
    }
    if (Number(operation.total) > 0) {
      meta.push(`${formatBytes(operation.received)} / ${formatBytes(operation.total)}`);
    } else if (operation.phase === 'download') {
      meta.push(t('ui.operation.unknownSize', undefined, 'download size unknown'));
    }
    if (operation.fromCache) meta.push(t('ui.operation.fromCache', undefined, 'from cache'));
    if (meta.length > 0) card.append(el('div', 'operation-meta', meta.join(' · ')));
    card.append(el('div', 'operation-folder-note', t('ui.operation.folderNote', undefined, 'Folder view stays available; avoid editing files until this task finishes.')));
  }

  const pending = [...(outcome?.result?.pendingUserActions ?? [])];
  if (Array.isArray(outcome?.result)) {
    const kept = outcome.result.flatMap((entry) => entry?.keptModified ?? []);
    const missing = outcome.result.flatMap((entry) => entry?.missing ?? []);
    if (kept.length > 0) {
      pending.push(
        t(
          'ui.operation.keptModified',
          { count: kept.length },
          '{count} hand-edited file(s) were kept and need review.',
        ),
      );
    }
    if (missing.length > 0) {
      pending.push(
        t('ui.operation.missingFiles', { count: missing.length }, '{count} managed file(s) were already missing.'),
      );
    }
  }
  if (pending.length > 0) {
    const list = el('ul', 'operation-actions-needed');
    for (const action of pending) list.append(el('li', null, action));
    card.append(list);
  }

  if (outcome?.error) card.append(el('div', 'operation-error', outcome.error));
  if (outcome?.refreshError) card.append(el('div', 'operation-error', outcome.refreshError));
  if ((outcome?.rollbackFailures ?? []).length > 0) {
    const list = el('ul', 'operation-errors');
    for (const failure of outcome.rollbackFailures) list.append(el('li', null, `${failure.path}: ${failure.error}`));
    card.append(list);
  }

  if ((operation.log ?? []).length > 0) {
    const details = document.createElement('details');
    const summary = el('summary', null, t('ui.operation.showLog', undefined, 'Task log'));
    const log = el('pre', 'operation-log');
    log.textContent = operation.log.join('\n');
    details.append(summary, log);
    card.append(details);
  }

  if (outcome) {
    const actions = el('div', 'operation-terminal-actions');
    if (outcome.refreshStatus === 'failed') {
      const retry = el(
        'button',
        'ghost',
        operation.refreshing
          ? t('ui.operation.refreshingState', undefined, 'Refreshing game state…')
          : t('ui.operation.refreshState', undefined, 'Refresh state'),
      );
      retry.disabled = Boolean(operation.refreshing);
      retry.addEventListener('click', () => window.dispatchEvent(new CustomEvent('indiedeck:refresh-operation-state')));
      actions.append(retry);
    }
    const dismiss = el('button', 'ghost', t('ui.operation.dismiss', undefined, 'Dismiss'));
    dismiss.disabled = Boolean(operation.refreshing);
    dismiss.addEventListener('click', () => window.dispatchEvent(new CustomEvent('indiedeck:dismiss-operation')));
    actions.append(dismiss);
    card.append(actions);
  }

  return card;
}

/* --------------------------------------------------------------- header */

/**
 * Title, path and the two safe frequent actions live in a position:sticky
 * wrapper, so Play / Open folder stay visible at any scroll depth (§9). The
 * uninstall action is deliberately NOT here: the fixed bar carries only safe,
 * frequently used controls.
 */
export function renderHeader(panel, ctx) {
  const { profile } = ctx;

  const sticky = el('div', 'detail-sticky');
  const inner = el('div', 'detail-sticky-inner');

  inner.append(el('h1', null, profile.title && profile.title !== profile.name ? profile.title : profile.name));
  inner.append(el('div', 'path', profile.path));

  const actions = el('div', 'actions');
  if (profile.executable) {
    const play = el('button', 'primary', `▶  ${t('ui.detail.play', undefined, 'Play')}`);
    play.disabled = mutationBlocked();
    if (mutationBlocked()) {
      // A disabled button cannot take focus or show its own title; give screen
      // readers an adjacent explanation instead (§9.2).
      play.setAttribute('aria-disabled', 'true');
      actions.append(
        Object.assign(el('span', 'plan-sub', t('ui.detail.playBlocked', undefined, 'finish the running task first')), {
          id: 'playBlockedNote',
        }),
      );
      play.setAttribute('aria-describedby', 'playBlockedNote');
    }
    play.addEventListener('click', async () => {
      if (mutationBlocked()) return;
      try {
        await api.game.launch(profile.id);
      } catch (err) {
        setStatus(err.message, 'err');
      }
    });
    actions.append(play);
  }

  const openFolder = el('button', 'ghost', t('ui.detail.openFolder', undefined, 'Open folder'));
  openFolder.addEventListener('click', async () => {
    try {
      await api.game.openFolder(profile.id);
    } catch (err) {
      setStatus(err.message, 'err');
    }
  });
  actions.append(openFolder);

  inner.append(actions);
  if (state.operation?.gameId === profile.id) inner.append(operationCard(state.operation));
  sticky.append(inner);
  panel.append(sticky);
}

/* ---------------------------------------------------------------- facts */

export function renderFacts(panel, ctx) {
  const { profile } = ctx;
  const facts = el('dl', 'facts');
  const add = (label, value) => {
    if (!value) return;
    facts.append(el('dt', null, label), el('dd', null, value));
  };

  add(
    t('ui.detail.engine', undefined, 'Engine'),
    t('ui.detail.engineValue', { name: profile.engineName, confidence: profile.confidence }, '{name} ({confidence}% confidence)'),
  );

  if (profile.unity) {
    add(t('ui.detail.backend', undefined, 'Backend'), profile.unity.backend);
    add(
      t('ui.detail.unity', undefined, 'Unity'),
      `${profile.unity.version ?? t('ui.detail.unknownVersion', undefined, 'unknown version')}${profile.unity.versionSource ? `  · ${profile.unity.versionSource}` : ''}`,
    );
    const yes = t('ui.detail.yes', undefined, 'yes');
    const no = t('ui.detail.no', undefined, 'no');
    const traits = [];
    if (profile.unity.usesTextMeshPro !== undefined) {
      traits.push(t('ui.detail.traitTmp', { value: profile.unity.usesTextMeshPro ? yes : no }, 'TextMeshPro: {value}'));
    }
    if (profile.unity.usesNewInputSystem !== undefined) {
      traits.push(
        t('ui.detail.traitInput', { value: profile.unity.usesNewInputSystem ? yes : no }, 'new Input System: {value}'),
      );
    }
    add(t('ui.detail.traits', undefined, 'Traits'), traits.join('  ·  '));
  } else if (profile.engineVersion) {
    add(t('ui.detail.version', undefined, 'Version'), profile.engineVersion);
  }

  add(
    t('ui.detail.executable', undefined, 'Executable'),
    profile.executable ? `${profile.executable}  (${profile.arch})` : undefined,
  );
  add(
    t('ui.detail.loaders', undefined, 'Loaders'),
    profile.installedLoaders.map((l) => `${l.loaderId}${l.version ? ` ${l.version}` : ''}`).join(', '),
  );
  add(
    t('ui.detail.translators', undefined, 'Translators'),
    profile.installedTranslators.map((x) => `${x.translatorId}${x.version ? ` ${x.version}` : ''}`).join(', '),
  );
  add(t('ui.detail.fontBundles', undefined, 'Font bundles'), profile.installedFontBundles.join(', '));

  panel.append(facts);
}

/* ---------------------------------------------------------------- audit */

export function renderAudit(panel, ctx) {
  panel.append(el('h3', null, t('ui.detail.needsAttention', undefined, 'Needs attention')));
  for (const issue of ctx.audit.issues) {
    const row = el('div', `issue ${issue.severity}`);
    const body = el('div');
    body.append(document.createTextNode(retranslate(issue)));
    const fix = issue.fixKey ? t(issue.fixKey, issue.fixParams, issue.fix) : issue.fix;
    if (fix) body.append(el('span', 'fix', fix));
    row.append(body);
    panel.append(row);
  }
}

/* ---------------------------------------------------------------- plans */

function fontRangeText(range) {
  if (!range) return '';
  const min = range.min ?? '…';
  const max = range.max ?? '…';
  return t('ui.font.unityRange', { min, max }, 'Unity {min}–{max}');
}

/** An evidence-labelled recommendation, not a promise of runtime rendering. */
export function renderFontRecommendation(panel, ctx, _refresh, onInstall) {
  const recommendation = ctx.fontRecommendation;
  if (!recommendation || ctx.profile.engineId !== 'unity' ||
      ![...ctx.plans, ...ctx.profile.installedTranslators].some((entry) => entry.translatorId === 'xunity-autotranslator')) return;
  panel.append(el('h3', null, t('ui.font.title', undefined, 'Recommended TMP font')));
  const card = el('section', `font-recommendation ${recommendation.status}`);
  const { bundle } = recommendation;

  if (bundle) {
    const head = el('div', 'font-head');
    head.append(el('strong', 'font-file', bundle.file));
    const inferred = bundle.confidence !== 'verified';
    head.append(
      el(
        'span',
        `pill ${inferred ? 'warn' : 'ok'}`,
        inferred
          ? t('ui.font.inferred', undefined, 'Community / inferred range')
          : t('ui.font.registeredRange', undefined, 'Registered compatibility range'),
      ),
    );
    card.append(head);
    const range = fontRangeText(bundle.unityRange);
    if (range) card.append(el('div', 'plan-sub', range));
  }

  card.append(
    el(
      'p',
      'font-description',
      recommendation.reasonKey
        ? t(recommendation.reasonKey, recommendation.reasonParams, recommendation.reason)
        : recommendation.reason,
    ),
  );

  if (bundle) {
    card.append(
      el('p', 'font-help', t('ui.font.fallbackOnly', undefined, 'Uses TMP fallback only: the game keeps its original font and uses this bundle for missing glyphs.')),
      el('p', 'font-help', t('ui.font.runtimeCaveat', undefined, 'Chosen from detected Unity version and registered ranges. Font rendering in this game has not been tested.')),
    );
    if (recommendation.alreadyPresent) {
      card.append(
        el(
          'div',
          `font-state ${recommendation.configured ? 'configured' : ''}`,
          recommendation.configured
            ? t('ui.font.configured', undefined, 'Font file present · TMP fallback linked')
            : t('ui.font.presentNotConfigured', undefined, 'Font file present · TMP fallback is not linked'),
        ),
      );
    }
  }

  const actions = el('div', 'font-actions');
  if (recommendation.sourceUrl) {
    const source = el('a', null, t('ui.font.source', undefined, 'Font bundle source'));
    source.href = '#';
    source.addEventListener('click', (event) => {
      event.preventDefault();
      void api.open.url(recommendation.sourceUrl).catch((err) => setStatus(err.message, 'err'));
    });
    actions.append(source);
  }
  if (ctx.fontPlan) {
    const fontPlan = ctx.fontPlan;
    const install = el(
      'button',
      'primary install-font',
      recommendation.alreadyPresent
        ? t('ui.font.linkFallback', undefined, 'Link recommended TMP fallback')
        : t('ui.font.install', undefined, 'Add recommended font'),
    );
    const blockReason = fontPlan.installBlockReason ?? recommendation.blockReason;
    install.disabled = mutationBlocked() || !recommendation.installable || Boolean(blockReason);
    install.addEventListener('click', () => {
      if (mutationBlocked() || !recommendation.installable || blockReason) return;
      onInstall(ctx.profile.id, fontPlan);
    });
    actions.append(install);
    if (blockReason) card.append(el('p', 'font-block-reason', blockReason));
    card.append(el('p', 'font-help', t('ui.font.standalone', undefined, 'Adds only the recommended font and fallback setting; the installed translator is not reinstalled.')));
  } else if (recommendation.status === 'recommended' && !ctx.profile.installedTranslators.length) {
    card.append(el('p', 'font-help', t('ui.font.withTranslator', undefined, 'Choose “Install recommended TMP font too” in a translator option below.')));
  } else if (recommendation.blockReason) {
    card.append(
      el(
        'p',
        'font-block-reason',
        recommendation.blockReasonKey
          ? t(recommendation.blockReasonKey, undefined, recommendation.blockReason)
          : recommendation.blockReason,
      ),
    );
  }
  if (actions.childNodes.length > 0) card.append(actions);
  panel.append(card);
}

function finding(node, item) {
  const row = el('div', `finding ${item.severity}`);
  row.append(el('span', 'icon', severityMark(item.severity)));

  const body = el('span');
  body.append(document.createTextNode(retranslate(item)));
  for (const source of item.sources ?? []) {
    body.append(document.createTextNode(' '));
    const link = el('a', null, 'source');
    link.href = '#';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      void api.open.url(source);
    });
    body.append(link);
  }
  body.append(el('span', 'plan-sub', ` [${item.confidence}]`));
  row.append(body);
  node.append(row);
}

function planCard(plan, gameId, onInstall) {
  const card = el('div', `plan${plan.viable ? '' : ' blocked'}`);
  const head = el('div', 'plan-head');
  head.append(el('span', 'plan-title', `${plan.translatorName} ${plan.version}`));
  head.append(el('span', 'plan-sub', plan.variantName));

  const choiceKey = fontChoiceKey(gameId, plan);
  let includeFont = fontChoices.get(choiceKey) ?? true;
  let selected = selectedFontPlan(plan, includeFont);
  let install;
  const reasonId = `install-block-${String(plan.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const reason = el('span', 'plan-sub install-block-reason');
  reason.id = reasonId;
  const updateSelection = () => {
    selected = selectedFontPlan(plan, includeFont);
    if (install) {
      install.disabled = mutationBlocked() || Boolean(selected.installBlockReason);
      install.setAttribute('aria-describedby', reasonId);
    }
    reason.textContent = selected.installBlockReason ?? '';
    reason.hidden = !selected.installBlockReason;
  };

  if (plan.viable) {
    install = el('button', 'primary install', t('ui.plan.install', undefined, 'Install'));
    install.addEventListener('click', () => {
      if (mutationBlocked() || selected.installBlockReason) return;
      onInstall(selected);
    });
    head.append(install);
  } else {
    head.append(el('span', 'pill err install', t('ui.plan.blocked', undefined, 'blocked')));
  }
  head.append(reason);
  updateSelection();
  card.append(head);

  const details = [];
  if (plan.loader) {
    let line = t('ui.plan.viaLoader', { loader: plan.loader.name, version: plan.loader.version }, 'via {loader} {version}');
    if (plan.loader.alreadyInstalled) line += ` (${t('ui.plan.alreadyInstalled', undefined, 'already installed')})`;
    if (plan.loader.channel !== 'stable') line += ` · ${plan.loader.channel}`;
    details.push(line);
  } else {
    details.push(t('ui.plan.noLoaderNeeded', undefined, 'no loader needed'));
  }
  card.append(el('div', 'plan-sub', details.join('  ·  ')));

  if (plan.fontBundle) {
    const label = el('label', 'font-choice');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'include-font';
    checkbox.checked = includeFont;
    checkbox.disabled = mutationBlocked() || !plan.viable || !plan.withoutFontPlanId;
    checkbox.addEventListener('change', () => {
      if (mutationBlocked()) {
        checkbox.checked = includeFont;
        return;
      }
      includeFont = checkbox.checked;
      fontChoices.set(choiceKey, includeFont);
      updateSelection();
    });
    label.append(checkbox, el('span', null, t('ui.font.include', undefined, 'Install recommended TMP font too')));
    const help = el(
      'span',
      'font-choice-help',
      t('ui.font.choiceHelp', { file: plan.fontBundle.file }, '{file} · TMP fallback; original game font stays unchanged'),
    );
    const helpId = `font-choice-${String(plan.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    help.id = helpId;
    checkbox.setAttribute('aria-describedby', helpId);
    card.append(label, help);
  }

  for (const item of plan.findings) finding(card, item);
  return card;
}

export function renderPlans(panel, ctx, refresh, onInstall, onUninstall) {
  panel.append(el('h3', null, t('ui.detail.translatorOptions', undefined, 'Translator options')));
  if (ctx.plans.length === 0) {
    panel.append(el('div', 'plan-sub', t('ui.detail.noTranslator', undefined, 'No translator in the registry targets this engine.')));
  } else {
    for (const plan of ctx.plans) {
      const gameId = ctx.profile.id;
      panel.append(planCard(plan, gameId, (selectedPlan) => onInstall(gameId, selectedPlan)));
    }
  }

  // Maintenance actions stay out of the sticky bar (§9.1): removal touches
  // every managed file, so it lives with the translator plans it undoes.
  if (ctx.receipts?.length > 0) {
    const remove = el('button', 'ghost uninstall', t('ui.detail.uninstall', undefined, 'Uninstall IndieDeck changes'));
    remove.disabled = mutationBlocked();
    remove.addEventListener('click', () => onUninstall(ctx.profile.id));
    panel.append(remove);
  }
}

/* ----------------------------------------------------------------- mods */

export function renderMods(panel, ctx, refresh) {
  const { profile, hosts, mods } = ctx;
  panel.append(
    el(
      'h3',
      null,
      hosts.length > 0
        ? t('ui.detail.modsWithHosts', { hosts: hosts.map((h) => h.dir).join(', ') }, 'Mods · {hosts}')
        : t('ui.detail.mods', undefined, 'Mods'),
    ),
  );

  if (hosts.length === 0) {
    panel.append(el('div', 'plan-sub', t('ui.detail.noModHost', undefined, 'No mod host yet — install a loader above first.')));
    return;
  }

  const addMod = el('button', 'ghost', `+  ${t('ui.detail.addMod', undefined, 'Add mod from file')}`);
  addMod.disabled = mutationBlocked();
  addMod.addEventListener('click', async () => {
    if (mutationBlocked()) return;
    try {
      const updated = await api.mods.add(profile.id);
      if (updated) {
        ctx.mods = updated;
        await refresh({ keepScroll: true });
      }
    } catch (err) {
      setStatus(err.message, 'err');
    }
  });
  panel.append(addMod);

  if (mods.length === 0) panel.append(el('div', 'plan-sub', t('ui.detail.noMods', undefined, 'Nothing installed here yet.')));

  for (const mod of mods) {
    const row = el('div', 'mod');
    const toggle = el('button', `toggle${mod.enabled ? ' on' : ''}`);
    toggle.disabled = mutationBlocked();
    toggle.title = mod.enabled ? t('ui.plan.blocked', undefined, 'blocked') : '';
    toggle.addEventListener('click', async () => {
      try {
        if (mutationBlocked()) return;
        ctx.mods = await api.mods.toggle(profile.id, mod.id, !mod.enabled);
        await refresh({ keepScroll: true });
      } catch (err) {
        setStatus(err.message, 'err');
      }
    });
    row.append(toggle, el('span', null, mod.name), el('span', 'host', mod.loaderId));
    panel.append(row);
  }
}

export { severityTone };

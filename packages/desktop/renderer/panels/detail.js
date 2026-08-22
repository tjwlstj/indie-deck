/**
 * The right-hand detail panel.
 *
 * It is assembled from a list of sections rather than one long function, so a
 * new panel is one entry in `SECTIONS` in `index.js` plus a render function
 * here - no surgery on a 300-line renderer.
 */

import { el, setStatus, severityMark, severityTone } from '../dom.js';
import { retranslate, t } from '../i18n.js';
import { api, state } from '../store.js';

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
    play.disabled = state.busy;
    if (state.busy) {
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
      try {
        await api.game.launch(profile.id);
      } catch (err) {
        setStatus(err.message, 'err');
      }
    });
    actions.append(play);
  }

  const openFolder = el('button', 'ghost', t('ui.detail.openFolder', undefined, 'Open folder'));
  openFolder.addEventListener('click', () => api.game.openFolder(profile.id));
  actions.append(openFolder);

  inner.append(actions);
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

function planCard(plan, onInstall) {
  const card = el('div', `plan${plan.viable ? '' : ' blocked'}`);
  const head = el('div', 'plan-head');
  head.append(el('span', 'plan-title', `${plan.translatorName} ${plan.version}`));
  head.append(el('span', 'plan-sub', plan.variantName));

  if (plan.viable) {
    const install = el('button', 'primary install', t('ui.plan.install', undefined, 'Install'));
    install.disabled = state.busy;
    install.addEventListener('click', () => onInstall(plan));
    head.append(install);
  } else {
    head.append(el('span', 'pill err install', t('ui.plan.blocked', undefined, 'blocked')));
  }
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
  if (plan.fontBundle) details.push(t('ui.plan.font', { file: plan.fontBundle.file }, 'font {file}'));
  card.append(el('div', 'plan-sub', details.join('  ·  ')));

  for (const item of plan.findings) finding(card, item);
  return card;
}

export function renderPlans(panel, ctx, refresh, onInstall) {
  panel.append(el('h3', null, t('ui.detail.translatorOptions', undefined, 'Translator options')));
  if (ctx.plans.length === 0) {
    panel.append(el('div', 'plan-sub', t('ui.detail.noTranslator', undefined, 'No translator in the registry targets this engine.')));
  } else {
    for (const plan of ctx.plans) panel.append(planCard(plan, onInstall));
  }

  // Maintenance actions stay out of the sticky bar (§9.1): removal touches
  // every managed file, so it lives with the translator plans it undoes.
  if (ctx.receipts?.length > 0) {
    const remove = el('button', 'ghost uninstall', t('ui.detail.uninstall', undefined, 'Uninstall IndieDeck changes'));
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      setStatus(t('ui.status.removing', undefined, 'Removing…'));
      try {
        const results = await api.game.uninstall(ctx.profile.id);
        const kept = results.flatMap((r) => r.keptModified ?? []);
        setStatus(
          kept.length > 0
            ? t('ui.status.removedKept', { count: kept.length }, 'Removed. {count} hand-edited file(s) were left alone.')
            : t('ui.status.removed', undefined, 'Removed. Folder restored to what it was.'),
          'ok',
        );
        await refresh();
      } catch (err) {
        setStatus(err.message, 'err');
        remove.disabled = false;
      }
    });
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
  addMod.addEventListener('click', async () => {
    const updated = await api.mods.add(profile.id);
    if (updated) {
      ctx.mods = updated;
      refresh({ keepScroll: true });
    }
  });
  panel.append(addMod);

  if (mods.length === 0) panel.append(el('div', 'plan-sub', t('ui.detail.noMods', undefined, 'Nothing installed here yet.')));

  for (const mod of mods) {
    const row = el('div', 'mod');
    const toggle = el('button', `toggle${mod.enabled ? ' on' : ''}`);
    toggle.title = mod.enabled ? t('ui.plan.blocked', undefined, 'blocked') : '';
    toggle.addEventListener('click', async () => {
      try {
        ctx.mods = await api.mods.toggle(profile.id, mod.id, !mod.enabled);
        refresh({ keepScroll: true });
      } catch (err) {
        setStatus(err.message, 'err');
      }
    });
    row.append(toggle, el('span', null, mod.name), el('span', 'host', mod.loaderId));
    panel.append(row);
  }
}

export { severityTone };

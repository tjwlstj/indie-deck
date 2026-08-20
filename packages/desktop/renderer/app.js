/**
 * Renderer. No framework and no build step: the whole UI is a few hundred lines
 * of DOM over the IPC bridge that preload.cjs exposes as window.indiedeck.
 * Everything that decides anything lives in @indiedeck/core, on the other side.
 */

const api = window.indiedeck;

const state = {
  games: [],
  audits: new Map(),
  stats: null,
  config: null,
  registry: null,
  engineFilter: 'all',
  statusFilter: 'all',
  query: '',
  selected: null,
  detail: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(message, tone) {
  const node = $('status');
  node.textContent = message;
  node.style.color = tone === 'err' ? 'var(--err)' : tone === 'ok' ? 'var(--ok)' : '';
}

function resolveOptions() {
  return {
    targetLanguage: $('targetLanguage').value,
    sourceLanguage: $('sourceLanguage').value,
    endpoint: $('endpoint').value,
  };
}

/* ----------------------------------------------------------------- filters */

function visibleGames() {
  const query = state.query.trim().toLowerCase();
  return state.games.filter((game) => {
    if (state.engineFilter !== 'all' && game.engineId !== state.engineFilter) return false;

    if (state.statusFilter === 'untranslated' && game.installedTranslators.length > 0) return false;
    if (state.statusFilter === 'translated' && game.installedTranslators.length === 0) return false;
    if (state.statusFilter === 'issues' && !state.audits.has(game.path.toLowerCase())) return false;

    if (query) {
      const haystack = `${game.name} ${game.title ?? ''} ${game.engineName}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function renderSidebar() {
  const list = $('engineFilters');
  list.replaceChildren();

  const rows = [{ id: 'all', name: 'All engines', count: state.games.length }];
  for (const entry of state.stats?.byEngine ?? []) {
    rows.push({ id: entry.engineId, name: entry.engineName, count: entry.count });
  }

  for (const row of rows) {
    const li = el('li');
    const button = el('button');
    button.classList.toggle('active', state.engineFilter === row.id);
    button.append(el('span', null, row.name), el('span', 'count', String(row.count)));
    button.addEventListener('click', () => {
      state.engineFilter = row.id;
      render();
    });
    li.append(button);
    list.append(li);
  }

  for (const button of document.querySelectorAll('#statusFilters button')) {
    button.classList.toggle('active', button.dataset.status === state.statusFilter);
    button.onclick = () => {
      state.statusFilter = button.dataset.status;
      render();
    };
  }
  $('issueCount').textContent = String(state.audits.size);

  const roots = $('rootList');
  roots.replaceChildren();
  for (const root of state.config?.roots ?? []) {
    const li = el('li');
    li.append(el('span', 'path', root));
    const remove = el('button', null, '×');
    remove.title = `Stop scanning ${root}`;
    remove.addEventListener('click', async () => {
      state.config = await api.roots.remove(root);
      render();
    });
    li.append(remove);
    roots.append(li);
  }
}

function healthDot(game) {
  const audit = state.audits.get(game.path.toLowerCase());
  if (!audit) return game.installedTranslators.length > 0 ? 'ok' : 'none';
  return audit.issues.some((i) => i.severity === 'warn' || i.severity === 'block') ? 'warn' : 'ok';
}

function renderGameList() {
  const container = $('gameList');
  container.replaceChildren();
  const games = visibleGames();

  for (const game of games) {
    const row = el('div', 'game');
    row.classList.toggle('selected', state.selected === game.path);

    row.append(el('div', 'name', game.title && game.title !== game.name ? `${game.name} — ${game.title}` : game.name));
    row.append(el('span', `dot ${healthDot(game)}`));

    const meta = el('div', 'meta');
    meta.append(el('span', `badge engine-${game.engineId}`, game.engineName));
    const runtime = [
      game.unity?.backend && game.unity.backend !== 'unknown' ? game.unity.backend : '',
      game.unity?.version ?? game.engineVersion ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    if (runtime) meta.append(el('span', null, runtime));
    if (game.arch !== 'unknown') meta.append(el('span', null, game.arch));
    for (const translator of game.installedTranslators) {
      meta.append(
        el('span', 'pill ok', `${translator.translatorId.replace('xunity-autotranslator', 'XUAT')}${translator.version ? ` ${translator.version}` : ''}`),
      );
    }
    row.append(meta);

    row.addEventListener('click', () => selectGame(game.path));
    container.append(row);
  }

  $('counts').textContent = `${games.length} of ${state.games.length} games`;
}

/* ------------------------------------------------------------------ detail */

function finding(node, item) {
  const row = el('div', `finding ${item.severity}`);
  row.append(el('span', 'icon', item.severity === 'block' ? '×' : item.severity === 'warn' ? '!' : '•'));
  const body = el('span');
  body.append(document.createTextNode(item.message));
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

function renderPlan(plan) {
  const card = el('div', `plan${plan.viable ? '' : ' blocked'}`);
  const head = el('div', 'plan-head');
  head.append(el('span', 'plan-title', `${plan.translatorName} ${plan.version}`));
  head.append(el('span', 'plan-sub', plan.variantName));

  if (plan.viable) {
    const install = el('button', 'primary install', 'Install');
    install.disabled = state.busy;
    install.addEventListener('click', () => installPlan(plan));
    head.append(install);
  } else {
    head.append(el('span', 'pill err install', 'blocked'));
  }
  card.append(head);

  const details = [];
  if (plan.loader) {
    details.push(
      `via ${plan.loader.name} ${plan.loader.version}${plan.loader.alreadyInstalled ? ' (already installed)' : ''}${plan.loader.channel !== 'stable' ? ` · ${plan.loader.channel}` : ''}`,
    );
  }
  if (plan.fontBundle) details.push(`font ${plan.fontBundle.file}`);
  if (details.length > 0) card.append(el('div', 'plan-sub', details.join('  ·  ')));

  for (const item of plan.findings) finding(card, item);
  return card;
}

function renderDetail() {
  const panel = $('detail');
  panel.replaceChildren();

  if (!state.detail) {
    const empty = el('div', 'empty');
    empty.append(el('p', 'empty-title', 'Pick a game'));
    empty.append(
      el('p', null, 'IndieDeck reads its engine, backend and version, then works out which translator build actually fits it.'),
    );
    panel.append(empty);
    return;
  }

  const { profile, plans, audit, mods, hosts, receipts } = state.detail;

  panel.append(el('h1', null, profile.title && profile.title !== profile.name ? profile.title : profile.name));
  panel.append(el('div', 'path', profile.path));

  const actions = el('div', 'actions');
  if (profile.executable) {
    const play = el('button', 'primary', '▶  Play');
    play.addEventListener('click', () => api.game.launch(profile.path, profile.executable));
    actions.append(play);
  }
  const openFolder = el('button', 'ghost', 'Open folder');
  openFolder.addEventListener('click', () => api.open.folder(profile.path));
  actions.append(openFolder);

  if (receipts.length > 0) {
    const remove = el('button', 'ghost', 'Uninstall IndieDeck changes');
    remove.addEventListener('click', async () => {
      setStatus('Removing…');
      await api.game.uninstall(profile.path);
      setStatus('Removed. Folder restored to what it was.', 'ok');
      await selectGame(profile.path, true);
    });
    actions.append(remove);
  }
  panel.append(actions);

  const facts = el('dl', 'facts');
  const addFact = (label, value) => {
    if (!value) return;
    facts.append(el('dt', null, label), el('dd', null, value));
  };
  addFact('Engine', `${profile.engineName}  (${profile.confidence}% confidence)`);
  if (profile.unity) {
    addFact('Backend', profile.unity.backend);
    addFact('Unity', `${profile.unity.version ?? 'unknown'}${profile.unity.versionSource ? `  · ${profile.unity.versionSource}` : ''}`);
    const traits = [];
    if (profile.unity.usesTextMeshPro !== undefined) traits.push(`TextMeshPro: ${profile.unity.usesTextMeshPro ? 'yes' : 'no'}`);
    if (profile.unity.usesNewInputSystem !== undefined) traits.push(`new Input System: ${profile.unity.usesNewInputSystem ? 'yes' : 'no'}`);
    addFact('Traits', traits.join('  ·  '));
  } else if (profile.engineVersion) {
    addFact('Version', profile.engineVersion);
  }
  addFact('Executable', profile.executable ? `${profile.executable}  (${profile.arch})` : undefined);
  addFact('Loaders', profile.installedLoaders.map((l) => `${l.loaderId}${l.version ? ` ${l.version}` : ''}`).join(', '));
  addFact(
    'Translators',
    profile.installedTranslators.map((t) => `${t.translatorId}${t.version ? ` ${t.version}` : ''}`).join(', '),
  );
  addFact('Font bundles', profile.installedFontBundles.join(', '));
  panel.append(facts);

  if (audit.issues.length > 0) {
    panel.append(el('h3', null, 'Needs attention'));
    for (const issue of audit.issues) {
      const row = el('div', `issue ${issue.severity}`);
      const body = el('div');
      body.append(document.createTextNode(issue.message));
      if (issue.fix) body.append(el('span', 'fix', issue.fix));
      row.append(body);
      panel.append(row);
    }
  }

  panel.append(el('h3', null, 'Translator options'));
  if (plans.length === 0) {
    panel.append(el('div', 'plan-sub', 'No translator in the registry targets this engine.'));
  }
  for (const plan of plans) panel.append(renderPlan(plan));

  panel.append(el('h3', null, `Mods${hosts.length > 0 ? ` · ${hosts.map((h) => h.dir).join(', ')}` : ''}`));
  if (hosts.length === 0) {
    panel.append(el('div', 'plan-sub', 'No mod host yet — install a loader above first.'));
  } else {
    const addMod = el('button', 'ghost', '+  Add mod from file');
    addMod.addEventListener('click', async () => {
      const updated = await api.mods.add(profile.path);
      if (updated) {
        state.detail.mods = updated;
        renderDetail();
      }
    });
    panel.append(addMod);

    if (mods.length === 0) panel.append(el('div', 'plan-sub', 'Nothing installed here yet.'));
    for (const mod of mods) {
      const row = el('div', 'mod');
      const toggle = el('button', `toggle${mod.enabled ? ' on' : ''}`);
      toggle.title = mod.enabled ? 'Disable' : 'Enable';
      toggle.addEventListener('click', async () => {
        try {
          state.detail.mods = await api.mods.toggle(profile.path, mod.id, !mod.enabled);
          renderDetail();
        } catch (err) {
          setStatus(err.message, 'err');
        }
      });
      row.append(toggle, el('span', null, mod.name), el('span', 'host', mod.loaderId));
      panel.append(row);
    }
  }

  const log = el('div', 'log');
  log.id = 'installLog';
  log.hidden = true;
  panel.append(log);
}

/* ----------------------------------------------------------------- actions */

async function selectGame(gamePath, keepScroll) {
  state.selected = gamePath;
  if (!keepScroll) $('detail').scrollTop = 0;
  renderGameList();
  setStatus('Reading game folder…');
  try {
    state.detail = await api.game.detail(gamePath, resolveOptions());
    setStatus('Ready');
  } catch (err) {
    state.detail = null;
    setStatus(err.message, 'err');
  }
  renderDetail();
}

async function installPlan(plan) {
  state.busy = true;
  renderDetail();
  const log = $('installLog');
  log.hidden = false;
  log.textContent = '';

  const offLog = api.on.installProgress((line) => {
    log.textContent += `${line}\n`;
    log.scrollTop = log.scrollHeight;
  });
  const offBytes = api.on.installBytes(({ received, total }) => {
    if (total > 0) setStatus(`Downloading… ${Math.round((received / total) * 100)}%`);
  });

  try {
    setStatus(`Installing ${plan.translatorName} ${plan.version}…`);
    const result = await api.game.install(plan, {});
    for (const step of result.performed) log.textContent += `${step.status === 'done' ? '✓' : '·'} ${step.step.description}\n`;
    for (const action of result.pendingUserActions) log.textContent += `! ${action}\n`;
    setStatus(`Installed — ${result.filesWritten.length} files written`, 'ok');
    await refreshLibraryView(false);
    await selectGame(plan.gamePath, true);
    $('installLog').hidden = false;
  } catch (err) {
    setStatus(err.message, 'err');
    log.textContent += `× ${err.message}\n`;
  } finally {
    offLog();
    offBytes();
    state.busy = false;
  }
}

async function refreshLibraryView(rescan) {
  const scanButton = $('scan');
  scanButton.disabled = true;
  let offProgress = () => {};
  try {
    if (rescan) {
      setStatus('Scanning…');
      offProgress = api.on.scanProgress((current) => setStatus(`Scanning ${current}`));
    }
    const payload = rescan ? await api.library.scan({}) : await api.library.load();
    applyPayload(payload);
    setStatus(payload.index.games.length === 0 ? 'No games yet — add a folder and scan.' : 'Ready', 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    offProgress();
    scanButton.disabled = false;
    render();
  }
}

function applyPayload(payload) {
  state.games = payload.index.games;
  state.stats = payload.stats;
  state.audits = new Map(payload.audits.map((audit) => [audit.path.toLowerCase(), audit]));
}

function render() {
  renderSidebar();
  renderGameList();
  renderDetail();
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  state.registry = await api.registry();
  state.config = await api.config.get();

  const endpoints = state.registry.translators.find((t) => t.id === 'xunity-autotranslator')?.endpoints ?? [];
  const select = $('endpoint');
  for (const endpoint of endpoints) {
    const option = el('option', null, endpoint.needsKey ? `${endpoint.id} (key)` : endpoint.id);
    option.value = endpoint.id;
    select.append(option);
  }

  $('targetLanguage').value = state.config.defaults.targetLanguage;
  $('sourceLanguage').value = state.config.defaults.sourceLanguage;
  select.value = state.config.defaults.endpoint;

  const persist = async () => {
    state.config.defaults = {
      targetLanguage: $('targetLanguage').value,
      sourceLanguage: $('sourceLanguage').value,
      endpoint: $('endpoint').value,
    };
    state.config = await api.config.set(state.config);
    if (state.selected) await selectGame(state.selected, true);
  };
  $('targetLanguage').addEventListener('change', persist);
  $('sourceLanguage').addEventListener('change', persist);
  select.addEventListener('change', persist);

  $('search').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderGameList();
  });

  $('scan').addEventListener('click', () => refreshLibraryView(true));
  $('addRoot').addEventListener('click', async () => {
    const picked = await api.roots.pick();
    if (!picked) return;
    state.config = await api.config.get();
    await refreshLibraryView(true);
  });

  await refreshLibraryView(false);
}

boot().catch((err) => setStatus(err.message, 'err'));

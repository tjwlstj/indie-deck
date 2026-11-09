import { $, el, setStatus } from '../dom.js';
import { currentLocale, t } from '../i18n.js';
import { api, emit, mutationBlocked, state } from '../store.js';
import {
  acceptStoreConnectionsRead, applyStoreConnectionsMutation, beginStoreConnectionsRead,
  failStoreConnectionsRead, storeCandidatePresentation, storeHandoffMessageKey, storeLinksForGame,
} from '../store-model.js';

function message(error) {
  const value = typeof error === 'string' ? error : error?.message;
  return value?.startsWith('ui.stores.') ? t(value) : value || t('ui.stores.error.unavailable');
}

function products() { return state.storeConnections?.products ?? []; }
function games() { return state.storeConnections?.games ?? []; }
function providers() { return state.storeConnections?.providers ?? []; }
function providerName(id) { return providers().find((provider) => provider.id === id)?.name || id; }
function links() { return state.storeConnections?.snapshot?.links ?? []; }
function writeBlocked() { return mutationBlocked() || Boolean(state.storeReadError) || state.storeReadPending; }
function defaultStoreTarget() {
  return games().some((game) => game.id === state.storeTargetGameId) ? `game:${state.storeTargetGameId}` : '';
}

export async function refreshStoreConnections() {
  const token = beginStoreConnectionsRead(state);
  renderStoreSettings();
  try {
    if (!api.stores?.list) throw new Error('ui.stores.error.unavailable');
    const payload = await api.stores.list();
    if (!acceptStoreConnectionsRead(state, token, payload) && token === state.storeRequestToken && state.storeReadError) {
      setStatus(message(state.storeReadError), 'err');
    }
  } catch (error) {
    if (failStoreConnectionsRead(state, token, error)) setStatus(message(error), 'err');
  }
  renderStoreSettings();
  emit('all');
}

async function performStoreAction(work) {
  if (mutationBlocked()) return;
  state.storeBusy = true;
  emit('all');
  try { await work(); }
  catch (error) { setStatus(message(error), 'err'); }
  finally { state.storeBusy = false; emit('all'); }
}

async function openStore(provider, action, linkId) {
  if (linkId && (state.storeReadError || state.storeReadPending)) return;
  await performStoreAction(async () => {
    const result = await api.stores.open(provider, action, linkId);
    const key = storeHandoffMessageKey(result);
    setStatus(t(key), key.includes('.error.') ? 'err' : 'ok');
  });
}

async function pickStoreLink() {
  if (writeBlocked()) return;
  await performStoreAction(async () => {
    const result = await api.stores.pick();
    if (!applyStoreConnectionsMutation(state, result)) throw new Error(state.storeReadError);
    if (result.candidate) {
      state.storeCandidate = result.candidate;
      state.storeProductId = defaultStoreTarget();
      state.storeCandidateTitle = result.candidate.title || '';
      setStatus(t('ui.stores.reviewCandidate'));
    }
  });
}

async function importStoreLink(file) {
  if (writeBlocked()) return;
  const text = state.storeImportText || '';
  if (!file && (!text.trim() || new TextEncoder().encode(text).length > 8192)) {
    setStatus(t('ui.stores.error.importInput'), 'err'); return;
  }
  await performStoreAction(async () => {
    const result = file ? await api.stores.importFile(file) : await api.stores.preview(text);
    if (!applyStoreConnectionsMutation(state, result)) throw new Error(state.storeReadError);
    if (result.candidate) {
      state.storeCandidate = result.candidate;
      state.storeCandidateTitle = result.candidate.title || '';
      state.storeProductId = defaultStoreTarget();
      state.storeImportText = '';
      setStatus(t('ui.stores.reviewCandidate'));
    }
  });
}

async function saveStoreLink(candidate) {
  if (state.storeCandidate?.id !== candidate.id ||
      !storeCandidatePresentation(candidate, products(), state.storeProductId, mutationBlocked(), state.storeReadError || state.storeReadPending, games()).canSave) return;
  const gameId = state.storeProductId?.startsWith('game:') ? state.storeProductId.slice(5) : undefined;
  const managedProductId = gameId ? undefined : state.storeProductId || undefined;
  const title = state.storeCandidateTitle?.trim() || undefined;
  await performStoreAction(async () => {
    const result = await api.stores.save(candidate.id, managedProductId, gameId, title);
    if (!applyStoreConnectionsMutation(state, result)) throw new Error(state.storeReadError);
    state.storeCandidate = null;
    state.storeProductId = '';
    state.storeCandidateTitle = '';
    state.storeTargetGameId = null;
    setStatus(t('ui.stores.saved'), 'ok');
  });
}

async function removeStoreLink(linkId) {
  if (writeBlocked() || !links().some((link) => link.id === linkId)) return;
  await performStoreAction(async () => {
    const result = await api.stores.remove(linkId);
    if (!applyStoreConnectionsMutation(state, result)) throw new Error(state.storeReadError);
    setStatus(t('ui.stores.removed'), 'ok');
  });
}

function actionLabel(action) {
  return t(action.labelKey || `ui.stores.action.${action.id}`, undefined, action.id);
}

function appendStoreActions(container, provider, actions, linkId) {
  const row = el('div', 'store-actions');
  for (const action of Array.isArray(actions) ? actions : []) {
    const button = el('button', 'ghost store-open', actionLabel(action));
    button.dataset.provider = provider;
    button.dataset.action = action.id;
    if (linkId) button.dataset.linkId = linkId;
    button.disabled = mutationBlocked() || Boolean(linkId && (state.storeReadError || state.storeReadPending));
    button.addEventListener('click', () => void openStore(provider, action.id, linkId));
    row.append(button);
  }
  container.append(row);
}

function renderCandidate(body) {
  const candidate = state.storeCandidate;
  if (!candidate) return;
  const card = el('section', 'store-candidate');
  card.append(el('strong', null, candidate.title || t('ui.stores.untitled')),
    el('p', 'plan-sub', `${providerName(candidate.provider)} · ${candidate.productId}`),
    el('p', 'store-url', candidate.url),
    el('p', 'store-help', t('ui.stores.metadataOnly')));
  const titleLabel = el('label', 'store-product-label');
  const titleInput = el('input');
  titleInput.id = 'storeLinkTitle'; titleInput.type = 'text'; titleInput.maxLength = 240;
  titleInput.value = state.storeCandidateTitle ?? candidate.title ?? '';
  titleInput.disabled = writeBlocked();
  titleInput.addEventListener('input', () => { state.storeCandidateTitle = titleInput.value; });
  titleLabel.append(el('span', null, t('ui.stores.editableTitle')), titleInput);
  card.append(titleLabel);
  const label = el('label', 'store-product-label');
  const select = el('select');
  select.id = 'storeLinkProduct';
  const unlinked = el('option', null, t('ui.stores.noTarget'));
  unlinked.value = '';
  select.append(unlinked);
  const installed = el('optgroup'); installed.label = t('ui.stores.installedGames');
  for (const game of games()) {
    const option = el('option', null, `${game.title || game.name || game.id} — ${game.path || game.id}`);
    option.value = `game:${game.id}`; installed.append(option);
  }
  if (games().length) select.append(installed);
  const managed = el('optgroup'); managed.label = t('ui.stores.managedProducts');
  for (const product of products()) {
    const option = el('option', null, product.title);
    option.value = product.id;
    managed.append(option);
  }
  if (products().length) select.append(managed);
  select.value = state.storeProductId;
  select.disabled = writeBlocked();
  select.addEventListener('change', () => { state.storeProductId = select.value; renderStoreSettings(); });
  label.append(el('span', null, t('ui.stores.linkTarget')), select);
  card.append(label, el('p', 'store-help', t('ui.stores.ownerUnchanged')));
  const actions = el('div', 'store-actions');
  const save = el('button', 'primary store-save', t('ui.stores.save'));
  save.disabled = !storeCandidatePresentation(candidate, products(), state.storeProductId, mutationBlocked(), state.storeReadError || state.storeReadPending, games()).canSave;
  save.addEventListener('click', () => void saveStoreLink(candidate));
  const cancel = el('button', 'ghost store-cancel', t('ui.stores.cancel'));
  cancel.disabled = mutationBlocked();
  cancel.addEventListener('click', () => { state.storeCandidate = null; state.storeProductId = ''; state.storeCandidateTitle = ''; state.storeTargetGameId = null; renderStoreSettings(); });
  actions.append(save, cancel);
  card.append(actions);
  body.append(card);
}

/** Saved metadata is a reference to this managed product, never title matching
 * or a second install/launch authority. All actions use the same fixed IPC. */
export function renderGameStoreLinks(panel, profile) {
  const connected = storeLinksForGame(state.archiveCatalog, state.archiveRecords,
    state.storeConnections?.snapshot, profile?.id);
  const card = el('section', 'detail-stores store-game-card');
  card.append(el('h3', null, t('ui.stores.gameTitle')),
    el('p', 'store-help', t('ui.stores.gameDescription')));
  const connect = el('button', 'ghost store-connect-game', t('ui.stores.connectThisGame'));
  connect.disabled = mutationBlocked();
  connect.addEventListener('click', () => {
    if (mutationBlocked() || !profile?.id) return;
    state.storeTargetGameId = profile.id; state.storeProductId = `game:${profile.id}`;
    window.dispatchEvent(new CustomEvent('indiedeck:open-settings', { detail: { section: 'storeSettings' } }));
  });
  card.append(connect);
  if (state.storeReadError) {
    const error = el('p', 'store-error', message(state.storeReadError));
    error.setAttribute('role', 'alert');
    card.append(error);
  }
  for (const link of connected) {
    const item = el('div', 'store-game-link');
    item.append(el('strong', null, link.title || t('ui.stores.untitled')),
      el('p', 'plan-sub', providerName(link.provider)));
    appendStoreActions(item, link.provider, link.actions, link.id);
    card.append(item);
  }
  panel.append(card);
}

export function renderStoreSettings() {
  const body = $('storeSettingsBody');
  if (!body) return;
  body.replaceChildren();
  body.append(el('p', 'settings-hint', t('ui.stores.description')),
    el('p', 'store-help', t('ui.stores.externalLogin')));
  const header = el('div', 'store-actions');
  const refresh = el('button', 'ghost store-refresh', t('ui.stores.refresh'));
  refresh.disabled = mutationBlocked() || state.storeReadPending;
  refresh.addEventListener('click', () => void refreshStoreConnections());
  header.append(el('span', 'pill store-unverified', t('ui.stores.authUnverified')), refresh);
  body.append(header);
  if (state.storeReadError) {
    const error = el('p', 'store-error', message(state.storeReadError));
    error.setAttribute('role', 'alert');
    body.append(error);
  }
  if (!state.storeConnectionsLoaded) body.append(el('p', 'store-help', t('ui.stores.loading')));
  const grid = el('div', 'store-providers');
  for (const provider of providers()) {
    const card = el('section', 'store-provider');
    card.dataset.provider = provider.id;
    card.append(el('strong', null, provider.name), el('p', 'store-help', t('ui.stores.providerHandoff')));
    appendStoreActions(card, provider.id, provider.actions);
    grid.append(card);
  }
  body.append(grid);
  const companion = el('section', 'store-companion');
  companion.append(el('h3', null, t('ui.stores.companionTitle')),
    el('p', 'store-help', t('ui.stores.companionDescription')));
  const steps = el('ol', 'store-steps');
  for (const key of ['extensionStep', 'exportStep', 'importStep']) steps.append(el('li', null, t(`ui.stores.${key}`)));
  companion.append(steps);
  // The exporter opens the version directory, which is not itself an
  // extension: each browser must select the correct child explicitly.
  const korean = currentLocale().toLowerCase().startsWith('ko');
  const guide = el('details', 'store-extension-guide');
  guide.open = true;
  guide.append(el('summary', null, t('ui.stores.installGuideTitle', undefined,
    korean ? '브라우저별 설치 방법' : 'Installation by browser')));
  const instructions = el('ul', 'store-steps');
  const guideRows = [
    ['chrome', korean
      ? 'Chrome: chrome://extensions → 개발자 모드 → 압축해제된 확장 프로그램 로드 → 열린 폴더 안의 chromium 폴더 선택.'
      : 'Chrome: chrome://extensions → Developer mode → Load unpacked → choose the chromium folder inside the opened folder.'],
    ['edge', korean
      ? 'Edge: edge://extensions → 개발자 모드 → 압축 풀린 항목 로드 → 열린 폴더 안의 chromium 폴더 선택.'
      : 'Edge: edge://extensions → Developer mode → Load unpacked → choose the chromium folder inside the opened folder.'],
    ['whale', korean
      ? 'Whale: whale://extensions → 개발자 모드 → 압축해제된 확장앱 로드 → 열린 폴더 안의 chromium 폴더 선택.'
      : 'Whale: whale://extensions → Developer mode → load the unpacked extension → choose the chromium folder inside the opened folder.'],
    ['firefox', korean
      ? 'Firefox 140 이상: about:debugging → 이 Firefox → 임시 부가 기능 로드 → 열린 폴더 안의 firefox/manifest.json 선택. 브라우저를 다시 시작하면 다시 불러와야 해요.'
      : 'Firefox 140 or newer: about:debugging → This Firefox → Load Temporary Add-on → select firefox/manifest.json inside the opened folder. Reload it after restarting Firefox.'],
  ];
  for (const [browser, fallback] of guideRows) {
    instructions.append(el('li', null, t(`ui.stores.installGuide.${browser}`, undefined, fallback)));
  }
  guide.append(instructions);
  companion.append(guide);
  const companionActions = el('div', 'store-actions');
  const openCompanion = el('button', 'ghost store-companion-open', t('ui.stores.openCompanion'));
  openCompanion.disabled = mutationBlocked();
  openCompanion.addEventListener('click', () => void performStoreAction(async () => {
    await api.stores.openCompanion();
    setStatus(t('ui.stores.companionOpened'), 'ok');
  }));
  const pick = el('button', 'ghost store-pick', t('ui.stores.pick'));
  pick.disabled = writeBlocked() || !state.storeConnectionsLoaded;
  pick.addEventListener('click', () => void pickStoreLink());
  companionActions.append(openCompanion, pick);
  companion.append(companionActions);
  body.append(companion);
  const importer = el('section', 'store-import');
  importer.append(el('h3', null, t('ui.stores.pasteTitle')), el('p', 'store-help', t('ui.stores.pasteHelp')));
  const inputLabel = el('label', 'store-product-label'), input = el('textarea');
  input.id = 'storeLinkInput'; input.rows = 3; input.maxLength = 8192;
  input.value = state.storeImportText || ''; input.disabled = writeBlocked();
  input.addEventListener('input', () => { state.storeImportText = input.value; });
  inputLabel.append(el('span', null, t('ui.stores.pasteLabel')), input); importer.append(inputLabel);
  const preview = el('button', 'ghost store-preview', t('ui.stores.preview'));
  preview.disabled = writeBlocked() || !api.stores?.preview;
  preview.addEventListener('click', () => void importStoreLink());
  importer.append(preview);
  importer.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (writeBlocked()) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    importer.dataset.dragOver = 'true';
  });
  importer.addEventListener('dragleave', () => { delete importer.dataset.dragOver; });
  importer.addEventListener('drop', (event) => {
    event.preventDefault(); event.stopPropagation(); delete importer.dataset.dragOver;
    if (writeBlocked()) return;
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length !== 1 || !/\.json$/i.test(files[0].name) || files[0].size > 8192 || !api.stores?.importFile) {
      setStatus(t('ui.stores.error.importInput'), 'err'); return;
    }
    void importStoreLink(files[0]);
  });
  body.append(importer);
  renderCandidate(body);
  body.append(el('h3', null, t('ui.stores.savedLinks')));
  if (!links().length) body.append(el('p', 'store-help', t('ui.stores.empty')));
  for (const link of links()) {
    const card = el('section', 'store-link');
    card.dataset.linkId = link.id;
    card.append(el('strong', null, link.title || t('ui.stores.untitled')),
      el('p', 'plan-sub', `${providerName(link.provider)} · ${link.productId}`),
      el('p', 'store-url', link.url));
    const product = products().find((entry) => entry.id === link.managedProductId);
    if (product) card.append(el('p', 'store-help', t('ui.stores.linkedProduct', { title: product.title })));
    const game = games().find((entry) => entry.id === link.gameId);
    if (game) card.append(el('p', 'store-help', t('ui.stores.selectedGame', { title: `${game.title || game.name} — ${game.path || game.id}` })));
    card.append(el('span', 'pill store-unverified', t('ui.stores.authUnverified')));
    appendStoreActions(card, link.provider, link.actions, link.id);
    const remove = el('button', 'ghost store-remove', t('ui.stores.remove'));
    remove.disabled = writeBlocked();
    remove.addEventListener('click', () => void removeStoreLink(link.id));
    card.append(remove);
    body.append(card);
  }
}

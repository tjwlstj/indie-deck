import { $, el, setStatus } from '../dom.js';
import { currentLocale, t } from '../i18n.js';
import { api, emit, mutationBlocked, state } from '../store.js';
import { normaliseThumbnail } from '../thumbnail-model.js';
import { acceptSelectedThumbnail } from '../thumbnail.js';
import { bindThumbnailPreview, releaseThumbnailPreviews } from '../thumbnail-preview.js';
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

function artworkText(key, ko, en) {
  return t(`ui.stores.artwork.${key}`, undefined, currentLocale().startsWith('ko') ? ko : en);
}

function clearArtworkPreview() {
  state.storeArtworkRequestToken += 1;
  state.storeArtworkPreview = null;
  state.storeArtworkAction = null;
}

function artworkError(error) {
  const fallback = artworkText('error.failed', '이미지를 처리하지 못했어요. 다시 미리보기를 확인해 주세요.', 'Could not process this image. Preview it again and retry.');
  const key = typeof error === 'string' ? error : error?.message;
  return typeof key === 'string' && /^ui\.stores\.artwork\.[a-zA-Z.]+$/.test(key) ? t(key, undefined, fallback) : fallback;
}

function artworkRequestCurrent(token, candidateId) {
  return token === state.storeArtworkRequestToken && state.storeCandidate?.id === candidateId;
}

function installedArtworkTarget() {
  const target = state.storeProductId;
  if (typeof target !== 'string' || !target.startsWith('game:')) return null;
  const id = target.slice(5);
  return games().some((game) => game.id === id) ? id : null;
}

function candidateArtworkPreview(candidate) {
  const preview = state.storeArtworkPreview;
  const thumbnail = normaliseThumbnail(preview?.thumbnail);
  return preview?.candidateId === candidate.id && typeof preview.previewId === 'string' &&
    preview.previewId.length > 0 && preview.previewId.length <= 128 && thumbnail?.source === 'manual'
    ? { ...preview, thumbnail } : null;
}

async function previewStoreArtwork(candidate) {
  if (writeBlocked() || state.storeCandidate?.id !== candidate.id || !candidate.artwork?.url) return;
  clearArtworkPreview();
  const token = state.storeArtworkRequestToken;
  state.storeArtworkAction = 'preview';
  await performStoreAction(async () => {
    try {
      if (typeof api.stores?.previewArtwork !== 'function') throw new Error('ui.stores.artwork.unavailable');
      const result = await api.stores.previewArtwork(candidate.id);
      if (!artworkRequestCurrent(token, candidate.id)) return;
      const thumbnail = normaliseThumbnail(result?.thumbnail);
      if (result?.candidateId !== candidate.id || typeof result.previewId !== 'string' || !result.previewId ||
          result.previewId.length > 128 || thumbnail?.source !== 'manual') throw new Error('ui.stores.artwork.invalid');
      // Preview bytes belong to the candidate, so choosing a target afterwards
      // does not refetch the image or grant permission to apply it.
      state.storeArtworkPreview = { candidateId: candidate.id, previewId: result.previewId, thumbnail };
      setStatus(artworkText('previewReady', '미리보기를 확인한 뒤 설치된 게임에 적용해 주세요.', 'Review the preview, then apply it to an installed game.'));
    } catch (error) {
      if (artworkRequestCurrent(token, candidate.id)) setStatus(artworkError(error), 'err');
    } finally {
      if (token === state.storeArtworkRequestToken) state.storeArtworkAction = null;
    }
  });
}

async function applyStoreArtwork(candidate) {
  const preview = candidateArtworkPreview(candidate);
  const gameId = installedArtworkTarget();
  if (writeBlocked() || state.storeCandidate?.id !== candidate.id || !preview || !gameId) return;
  const token = ++state.storeArtworkRequestToken;
  state.storeArtworkAction = 'apply';
  await performStoreAction(async () => {
    try {
      if (typeof api.stores?.applyArtwork !== 'function') throw new Error('ui.stores.artwork.unavailable');
      const result = await api.stores.applyArtwork(candidate.id, preview.previewId, gameId);
      const thumbnail = normaliseThumbnail(result?.thumbnail);
      if (result?.gameId !== gameId || thumbnail?.source !== 'manual') throw new Error('ui.stores.artwork.invalid');
      // Main has already saved this captured game's cover. Prime that game's
      // cache even if the selection changed while IPC was pending.
      acceptSelectedThumbnail(gameId, thumbnail);
      if (artworkRequestCurrent(token, candidate.id) && installedArtworkTarget() === gameId) {
        setStatus(artworkText('applied', '게임 표지에 적용했어요. 상품 연결은 별도로 저장해 주세요.', 'Game cover applied. Save the product connection separately.'), 'ok');
      }
    } catch (error) {
      if (artworkRequestCurrent(token, candidate.id) && installedArtworkTarget() === gameId) setStatus(artworkError(error), 'err');
    } finally {
      if (token === state.storeArtworkRequestToken) state.storeArtworkAction = null;
    }
  });
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
      clearArtworkPreview();
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
      clearArtworkPreview();
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
    clearArtworkPreview();
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

function renderCandidateArtwork(card, candidate) {
  if (typeof candidate.artwork?.url !== 'string' || !candidate.artwork.url) return;
  const section = el('section', 'store-artwork');
  section.append(el('h4', null, artworkText('title', '상품 이미지 선택 적용', 'Optional product artwork')),
    el('p', 'store-help', artworkText('source', '이미지 출처', 'Image source')),
    el('p', 'store-url store-artwork-source', candidate.artwork.url),
    el('p', 'store-help', artworkText('replaceHint', '적용하면 런처의 표지 사본만 교체해요. 게임 폴더의 파일은 변경하지 않아요.', 'Applying replaces only the launcher cover copy. Files in the game folder stay unchanged.')));
  const preview = candidateArtworkPreview(candidate);
  if (preview) {
    const image = el('img', 'store-artwork-image');
    image.alt = artworkText('previewAlt', '가져온 상품 이미지 미리보기', 'Imported product artwork preview');
    image.src = preview.thumbnail.dataUrl;
    section.append(image);
    const enlarge = el('button', 'ghost store-artwork-enlarge', t('ui.thumbnail.preview', undefined, 'Image preview'));
    bindThumbnailPreview(image, { getThumbnail: async () => preview.thumbnail, label: image.alt,
      mode: () => state.libraryPreferences.previewMode, toggleButton: enlarge });
    enlarge.type = 'button';
    section.append(enlarge);
  }
  const actions = el('div', 'store-actions');
  const previewButton = el('button', 'ghost store-artwork-preview', state.storeArtworkAction === 'preview'
    ? artworkText('previewing', '이미지 확인 중…', 'Checking image…')
    : artworkText('preview', '이미지 미리보기', 'Preview image'));
  previewButton.disabled = writeBlocked();
  previewButton.addEventListener('click', () => void previewStoreArtwork(candidate));
  const apply = el('button', 'ghost store-artwork-apply', state.storeArtworkAction === 'apply'
    ? artworkText('applying', '표지 적용 중…', 'Applying cover…')
    : artworkText('apply', '선택한 게임 표지로 적용', 'Apply as selected game cover'));
  apply.disabled = writeBlocked() || !preview || !installedArtworkTarget();
  apply.addEventListener('click', () => void applyStoreArtwork(candidate));
  actions.append(previewButton, apply);
  section.append(actions);
  if (!installedArtworkTarget()) section.append(el('p', 'store-help',
    artworkText('chooseGame', '표지를 적용하려면 위에서 설치된 게임을 선택해 주세요.', 'Choose an installed game above to apply its cover.')));
  card.append(section);
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
  renderCandidateArtwork(card, candidate);
  const actions = el('div', 'store-actions');
  const save = el('button', 'primary store-save', t('ui.stores.save'));
  save.disabled = !storeCandidatePresentation(candidate, products(), state.storeProductId, mutationBlocked(), state.storeReadError || state.storeReadPending, games()).canSave;
  save.addEventListener('click', () => void saveStoreLink(candidate));
  const cancel = el('button', 'ghost store-cancel', t('ui.stores.cancel'));
  cancel.disabled = mutationBlocked();
  cancel.addEventListener('click', () => { clearArtworkPreview(); state.storeCandidate = null; state.storeProductId = ''; state.storeCandidateTitle = ''; state.storeTargetGameId = null; renderStoreSettings(); });
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
  releaseThumbnailPreviews(body);
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
  // Stable managed location: each browser selects its child once, then can
  // Reload that same extension after a bundled code update.
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
  guide.append(el('p', 'store-help', t('ui.stores.stableCompanionHint', undefined, korean
    ? '고정된 current/chromium 폴더를 한 번 불러오면 런처 업데이트 뒤에도 같은 경로를 사용해요. 확장 코드가 바뀌면 브라우저 확장 관리에서 새로고침을 눌러 주세요. 구버전의 숫자 버전 폴더를 사용했다면 이번에 한 번만 경로를 바꿔 주세요.'
    : 'Load the stable current/chromium folder once. Launcher upgrades keep that path; Reload it in your browser extension manager when extension code changes. If you used a numbered version folder, switch once to the stable folder.')));
  guide.append(el('p', 'store-help', t('ui.stores.autoPanelHint', undefined, korean
    ? '지원 상품 페이지에서 확장 버튼을 열고 이 사이트 자동 패널을 켜면 큰 패널이 자동으로 나타나요. 사이트 접근 권한은 브라우저에서 한 번 허용해야 하며, 패널에서 접거나 숨길 수 있어요.'
    : 'On a supported product page, open the extension and enable automatic panels for that site. Approve the browser site-access request once, then collapse or hide the larger panel as needed.')));
  companion.append(guide);
  if (state.storeConnections?.companionPrepared === false) companion.append(el('p', 'store-error', t('ui.stores.companionRefreshFailed', undefined, korean
    ? '확장 파일 자동 갱신을 완료하지 못했어요. 기존 파일은 보존했어요. 폴더 열기를 다시 시도해 주세요.'
    : 'The extension files could not be refreshed automatically. Existing files were preserved. Try opening the extension folder again.')));
  const companionActions = el('div', 'store-actions');
  const openCompanion = el('button', 'ghost store-companion-open', t('ui.stores.openCompanion'));
  openCompanion.disabled = mutationBlocked();
  openCompanion.addEventListener('click', () => void performStoreAction(async () => {
    await api.stores.openCompanion();
    await refreshStoreConnections();
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

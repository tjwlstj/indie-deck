import { cleanDisplayTitle, LINK_FILENAME, metadataFromProductUrl, productPageForMetadata, serializeStoreLink, validateStoreLink } from './store-link.js';
import { normalizeArtworkUrl } from './artwork.js';

export const MESSAGES = {
  ko: {
    heading: 'IndieDeck 상품 연결', intro: '공식 상품 페이지의 공개 정보만 연결 파일로 저장해요.',
    loading: '현재 상품 페이지를 확인하고 있어요.', ready: '상품 정보를 확인한 뒤 연결 파일을 저장하세요.',
    unsupported: '지원하는 공식 게임 상품 페이지에서 확장 버튼을 눌러주세요.',
    unavailable: '현재 탭을 확인할 수 없어요. 상품 페이지를 열고 다시 시도해 주세요.',
    provider: '스토어', product: '상품 식별자', title: '상품명 (선택)', page: '공식 상품 페이지',
    export: '연결 파일 저장', exporting: '연결 파일 저장을 요청하고 있어요.',
    saved: '저장을 요청했어요. 다운로드 완료 여부는 브라우저에서 확인해 주세요.',
    failed: '연결 파일을 저장하지 못했어요. 확장 버튼을 다시 열고 시도해 주세요.',
    copy: '연결 정보 복사', copying: '연결 정보를 복사하고 있어요.',
    copied: '복사했어요. IndieDeck의 스토어 연결 화면에 붙여넣고 설치된 게임을 선택하세요.',
    copyFailed: '브라우저에서 복사를 허용하지 않았어요. 연결 파일을 저장한 뒤 IndieDeck으로 끌어다 놓으세요.',
    instructions: '연결 정보를 복사해 IndieDeck에 붙여넣거나, 저장한 .indiedeck-link.json 파일을 스토어 연결 화면에 끌어다 놓으세요.',
    privacy: '로그인·구매 확인은 개인 브라우저에서 진행해요. 파일에는 쿠키·다운로드 주소·게임 파일 경로가 포함되지 않아요.',
    scope: '지원 상품 페이지: Steam · Epic · GOG · itch.io · BOOTH · DLsite',
    findArtwork: '대표 이미지 찾기', artworkChoice: '가져올 이미지 주소', includeArtwork: '선택한 대표 이미지 주소를 함께 보내기',
    artworkHint: '이 버튼을 누를 때 현재 상품 페이지의 대표 이미지 메타 정보만 읽어요. 이미지는 런처에서 미리 보고 적용해요.',
    artworkLoading: '대표 이미지 메타 정보를 확인하고 있어요.',
    artworkReady: '이미지 후보를 찾았어요. 연결 정보를 가져온 뒤 런처에서 미리 보고 게임 표지로 적용하세요.',
    artworkEmpty: '허용된 대표 이미지 주소를 찾지 못했어요. 상품 정보만 보내거나 런처에서 직접 이미지를 선택할 수 있어요.',
    artworkFailed: '대표 이미지 정보를 읽지 못했어요. 상품 페이지를 다시 확인하거나 상품 정보만 보내세요.',
    artworkNumber: '대표 이미지',
  },
  en: {
    heading: 'Connect a product to IndieDeck', intro: 'Save public product information from an official product page.',
    loading: 'Checking the current product page…', ready: 'Review the product information before saving its connection file.',
    unsupported: 'Open a supported official game product page, then click this extension again.',
    unavailable: 'The current tab is unavailable. Open the product page and try again.',
    provider: 'Store', product: 'Product identifier', title: 'Product name (optional)', page: 'Official product page',
    export: 'Save connection file', exporting: 'Requesting a connection-file download…',
    saved: 'Save requested. Check download completion in your browser.',
    failed: 'The connection file could not be saved. Reopen this extension and try again.',
    copy: 'Copy connection information', copying: 'Copying connection information…',
    copied: 'Copied. Paste it into IndieDeck’s store connection screen and choose an installed game.',
    copyFailed: 'Clipboard access was unavailable. Save the connection file and drop it into IndieDeck instead.',
    instructions: 'Paste copied connection information into IndieDeck, or drop the saved .indiedeck-link.json file into its store connection screen.',
    privacy: 'Sign-in and purchases stay in your browser. The file contains no cookies, download URLs or game-file paths.',
    scope: 'Product pages: Steam · Epic · GOG · itch.io · BOOTH · DLsite',
    findArtwork: 'Find representative artwork', artworkChoice: 'Image address to import', includeArtwork: 'Include the selected artwork address',
    artworkHint: 'Only this button reads the current product page’s artwork metadata. Preview and apply the image in the launcher.',
    artworkLoading: 'Reading representative artwork metadata…',
    artworkReady: 'Artwork found. Import the connection information, then preview and apply the image to a game in the launcher.',
    artworkEmpty: 'No allowed artwork address was found. Send product information only or choose a local image in the launcher.',
    artworkFailed: 'Artwork metadata could not be read. Check the product page or send product information only.',
    artworkNumber: 'Artwork',
  },
};
const PROVIDER_NAMES = { steam: 'Steam', epic: 'Epic Games Store', gog: 'GOG', itch: 'itch.io', booth: 'BOOTH', dlsite: 'DLsite' };

/** Firefox uses Promise-only browser.*. Chromium/Whale callback support is retained. */
export async function currentTab(api, promiseApi = false) {
  if (!api?.tabs?.query) throw new Error('Browser tab API unavailable');
  const query = { active: true, currentWindow: true };
  const tabs = promiseApi ? await api.tabs.query(query) : await new Promise((resolve, reject) => {
    try {
      const pending = api.tabs.query(query, (values) => {
        if (api.runtime?.lastError) reject(new Error('Browser tab query failed'));
        else resolve(values);
      });
      if (pending?.then) pending.then(resolve, reject);
    } catch (error) { reject(error); }
  });
  return Array.isArray(tabs) ? tabs[0] : undefined;
}

/** Serialized by scripting.executeScript. No closures, body text, account data
 * or iframe traversal; a navigation race is checked before querying metadata. */
export function capturePageArtwork(expectedOrigin, expectedPath) {
  const pageUrl = String(globalThis.location?.href ?? '');
  let location;
  try { location = new URL(pageUrl); } catch { return { pageUrl: '', images: [] }; }
  if (location.origin !== expectedOrigin || location.pathname !== expectedPath) return { pageUrl, images: [] };
  const nodes = document.querySelectorAll('meta[property="og:image"],meta[name="og:image"],meta[name="twitter:image"],meta[property="twitter:image"]');
  const images = [];
  for (let index = 0; index < Math.min(nodes.length, 8); index += 1) {
    const content = nodes[index].getAttribute('content');
    if (typeof content === 'string' && content.length <= 2048) images.push(content.trim());
  }
  return { pageUrl, images };
}

/** User-clicked, main-frame-only capture. Recheck both the active tab and the
 * returned product identity; no metadata result can grant arbitrary URL access. */
export async function currentProductArtwork(api, tab, metadata, promiseApi = false) {
  if (!api?.scripting?.executeScript || !Number.isSafeInteger(tab?.id) || tab.id < 0) throw new Error('Artwork capture unavailable');
  const active = await currentTab(api, promiseApi), identity = metadataFromProductUrl(active?.url);
  if (active?.id !== tab.id || identity?.provider !== metadata.provider || identity?.productId !== metadata.productId) throw new Error('Product page changed');
  const page = new URL(active.url);
  const options = { target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: capturePageArtwork, args: [page.origin, page.pathname] };
  const results = promiseApi ? await api.scripting.executeScript(options) : await new Promise((resolve, reject) => {
    try {
      const pending = api.scripting.executeScript(options, values => {
        if (api.runtime?.lastError) reject(new Error('Artwork capture failed'));
        else resolve(values);
      });
      if (pending?.then) pending.then(resolve, reject);
    } catch (error) { reject(error); }
  });
  if (!Array.isArray(results) || results.length !== 1 || results[0]?.frameId !== 0) throw new Error('Artwork capture failed');
  const result = results[0]?.result, returned = metadataFromProductUrl(result?.pageUrl);
  if (returned?.provider !== metadata.provider || returned?.productId !== metadata.productId || !Array.isArray(result?.images)) throw new Error('Product page changed');
  const images = [];
  for (const candidate of result.images.slice(0, 8)) {
    const url = normalizeArtworkUrl(metadata.provider, metadata.productId, candidate);
    if (url && !images.includes(url)) images.push(url);
  }
  return images;
}

/** Mounting inspects metadata only. A download requires a second explicit click. */
export async function mountPopup({ document, api, promiseApi = false, language = 'ko', saveFile = saveConnectionFile, writeClipboard = copyConnectionMetadata, productContext }) {
  const locale = language.toLowerCase().startsWith('ko') ? 'ko' : 'en', messages = MESSAGES[locale];
  document.documentElement.lang = locale;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = messages[node.dataset.i18n] ?? '';
  const status = document.getElementById('status'), preview = document.getElementById('preview');
  const button = document.getElementById('saveLink'), title = document.getElementById('productTitle');
  const copy = document.getElementById('copyLink');
  const findArtwork = document.getElementById('findArtwork'), artworkChoice = document.getElementById('artworkChoice');
  const includeArtwork = document.getElementById('includeArtwork'), artworkStatus = document.getElementById('artworkStatus');
  if (copy) copy.disabled = true;
  if (findArtwork) findArtwork.disabled = true;
  if (artworkChoice) artworkChoice.disabled = true;
  if (includeArtwork) { includeArtwork.disabled = true; includeArtwork.checked = false; }
  button.disabled = true; preview.hidden = true; status.textContent = messages.loading;
  let metadata, tab;
  try {
    if (productContext) {
      if (productContext.isCurrent?.() !== true) throw new Error('Product page changed');
      metadata = validateStoreLink(productContext.metadata);
      if (metadata.schemaVersion !== 1) throw new Error('Unsupported product context');
    } else {
      tab = await currentTab(api, promiseApi);
      metadata = metadataFromProductUrl(tab?.url, tab?.title);
    }
    if (!metadata) { status.textContent = messages.unsupported; return { supported: false }; }
  } catch {
    status.textContent = messages.unavailable; return { supported: false };
  }
  document.getElementById('provider').textContent = PROVIDER_NAMES[metadata.provider];
  document.getElementById('productId').textContent = metadata.productId;
  const page = document.getElementById('productPage');
  page.textContent = productPageForMetadata(metadata); page.href = productPageForMetadata(metadata);
  title.value = metadata.title ?? ''; preview.hidden = false; button.disabled = false; status.textContent = messages.ready;
  if (copy) copy.disabled = false;
  const directCapture = typeof productContext?.readArtwork === 'function';
  const canCapture = directCapture || Boolean(api?.scripting?.executeScript && Number.isSafeInteger(tab?.id) && tab.id >= 0);
  if (findArtwork) findArtwork.disabled = !canCapture;
  let saving = false, artworkOptions = [];
  const reviewedPayload = () => {
    if (productContext && productContext.isCurrent?.() !== true) throw new Error('Product page changed');
    const displayTitle = cleanDisplayTitle(title.value);
    const url = includeArtwork?.checked && artworkOptions.includes(artworkChoice?.value) ? artworkChoice.value : null;
    return { schemaVersion: url ? 2 : 1, kind: 'indiedeck-store-link', provider: metadata.provider, productId: metadata.productId,
      ...(displayTitle ? { title: displayTitle } : {}), ...(url ? { artwork: { url } } : {}) };
  };
  const busy = (value) => {
    saving = value; button.disabled = value; if (copy) copy.disabled = value;
    if (findArtwork) findArtwork.disabled = value || !canCapture;
    if (artworkChoice) artworkChoice.disabled = value || artworkOptions.length === 0;
    if (includeArtwork) includeArtwork.disabled = value || artworkOptions.length === 0;
  };
  findArtwork?.addEventListener('click', async () => {
    if (saving || !canCapture) return;
    busy(true); if (artworkStatus) artworkStatus.textContent = messages.artworkLoading;
    artworkOptions = [];
    if (includeArtwork) includeArtwork.checked = false;
    artworkChoice?.replaceChildren();
    try {
      if (directCapture) {
        if (productContext.isCurrent?.() !== true) throw new Error('Product page changed');
        const found = await productContext.readArtwork();
        if (productContext.isCurrent?.() !== true || !Array.isArray(found)) throw new Error('Product page changed');
        artworkOptions = [...new Set(found.slice(0, 8).map(value => normalizeArtworkUrl(metadata.provider, metadata.productId, value)).filter(Boolean))];
      } else artworkOptions = await currentProductArtwork(api, tab, metadata, promiseApi);
      for (let index = 0; index < artworkOptions.length; index += 1) {
        const option = document.createElement('option'); option.value = artworkOptions[index];
        option.textContent = `${messages.artworkNumber} ${index + 1} · ${new URL(option.value).hostname}`;
        artworkChoice?.append(option);
      }
      if (artworkChoice && artworkOptions.length) artworkChoice.value = artworkOptions[0];
      // Capture itself is an explicit opt-in. The checkbox lets users retain
      // ordinary schema-v1 product-only export after reviewing the candidates.
      if (includeArtwork) includeArtwork.checked = artworkOptions.length > 0;
      if (artworkStatus) artworkStatus.textContent = artworkOptions.length ? messages.artworkReady : messages.artworkEmpty;
    } catch { if (artworkStatus) artworkStatus.textContent = messages.artworkFailed; }
    finally { busy(false); }
  });
  button.addEventListener('click', async () => {
    if (saving) return;
    busy(true); status.textContent = messages.exporting;
    try {
      await saveFile({ document, filename: LINK_FILENAME, contents: serializeStoreLink(reviewedPayload()) });
      status.textContent = messages.saved;
    } catch { status.textContent = messages.failed; }
    finally { busy(false); }
  });
  copy?.addEventListener('click', async () => {
    if (saving) return;
    busy(true); status.textContent = messages.copying;
    try { await writeClipboard(serializeStoreLink(reviewedPayload())); status.textContent = messages.copied; }
    catch { status.textContent = messages.copyFailed; }
    finally { busy(false); }
  });
  return { supported: true };
}

/** Explicit write only: no clipboard reads or persistent/background access. */
export async function copyConnectionMetadata(contents) {
  if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
  await globalThis.navigator.clipboard.writeText(contents);
}

export function saveConnectionFile({ document, filename, contents }) {
  const blob = new Blob([contents], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.hidden = true;
  try { document.body.append(anchor); anchor.click(); } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

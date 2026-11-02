import { cleanDisplayTitle, LINK_FILENAME, metadataFromProductUrl, productPageForMetadata, serializeStoreLink } from './store-link.js';

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
    instructions: '저장한 .indiedeck-link.json 파일을 IndieDeck의 스토어 연결 화면에서 가져오세요.',
    privacy: '로그인·구매 확인은 개인 브라우저에서 진행해요. 파일에는 쿠키·다운로드 주소·게임 파일 경로가 포함되지 않아요.',
    scope: '지원 상품 페이지: Steam · Epic · GOG · itch.io · BOOTH · DLsite',
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
    instructions: 'Import the saved .indiedeck-link.json file from IndieDeck’s store connection screen.',
    privacy: 'Sign-in and purchases stay in your browser. The file contains no cookies, download URLs or game-file paths.',
    scope: 'Product pages: Steam · Epic · GOG · itch.io · BOOTH · DLsite',
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

/** Mounting inspects metadata only. A download requires a second explicit click. */
export async function mountPopup({ document, api, promiseApi = false, language = 'ko', saveFile = saveConnectionFile }) {
  const locale = language.toLowerCase().startsWith('ko') ? 'ko' : 'en', messages = MESSAGES[locale];
  document.documentElement.lang = locale;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = messages[node.dataset.i18n] ?? '';
  const status = document.getElementById('status'), preview = document.getElementById('preview');
  const button = document.getElementById('saveLink'), title = document.getElementById('productTitle');
  button.disabled = true; preview.hidden = true; status.textContent = messages.loading;
  let metadata;
  try {
    const tab = await currentTab(api, promiseApi);
    metadata = metadataFromProductUrl(tab?.url, tab?.title);
    if (!metadata) { status.textContent = messages.unsupported; return { supported: false }; }
  } catch {
    status.textContent = messages.unavailable; return { supported: false };
  }
  document.getElementById('provider').textContent = PROVIDER_NAMES[metadata.provider];
  document.getElementById('productId').textContent = metadata.productId;
  const page = document.getElementById('productPage');
  page.textContent = productPageForMetadata(metadata); page.href = productPageForMetadata(metadata);
  title.value = metadata.title ?? ''; preview.hidden = false; button.disabled = false; status.textContent = messages.ready;
  let saving = false;
  button.addEventListener('click', async () => {
    if (saving) return;
    saving = true; button.disabled = true; status.textContent = messages.exporting;
    try {
      const displayTitle = cleanDisplayTitle(title.value);
      const payload = { schemaVersion: 1, kind: 'indiedeck-store-link', provider: metadata.provider, productId: metadata.productId,
        ...(displayTitle ? { title: displayTitle } : {}) };
      await saveFile({ document, filename: LINK_FILENAME, contents: serializeStoreLink(payload) });
      status.textContent = messages.saved;
    } catch { status.textContent = messages.failed; }
    finally { saving = false; button.disabled = false; }
  });
  return { supported: true };
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

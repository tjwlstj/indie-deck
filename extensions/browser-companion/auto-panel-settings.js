import { browserCall } from './browser-api.js';
import { metadataFromProductUrl } from './store-link.js';

export const AUTO_PANEL_KEY = 'indiedeckAutoPanel';
export const AUTO_PANEL_SCRIPT_ID = 'indiedeck-product-panel-v1';
export const OPTIONAL_SITE_PATTERNS = Object.freeze([
  'https://store.steampowered.com/*', 'https://store.epicgames.com/*',
  'https://www.gog.com/*', 'https://gog.com/*', 'https://*.itch.io/*',
  'https://booth.pm/*', 'https://*.booth.pm/*', 'https://www.dlsite.com/*', 'https://dlsite.com/*',
]);
const EMPTY = () => ({ schemaVersion: 1, enabledOrigins: [], collapsedOrigins: [] });
const MAX_SITES = 64;
export function supportedSiteOrigin(input) {
  if (typeof input !== 'string' || input.length > 256 || /[\\\s?#]/u.test(input)) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' ||
      !/^https:\/\/[^:/@]+\/?$/.test(input)) return null;
  const host = url.hostname;
  const fixed = ['store.steampowered.com', 'store.epicgames.com', 'www.gog.com', 'gog.com', 'booth.pm', 'www.dlsite.com', 'dlsite.com'];
  const child = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(itch\.io|booth\.pm)$/.exec(host);
  if (!fixed.includes(host) && (!child || ['api', 'accounts', 'www', 'static', 'cdn', 'uploads', 'download', 'downloads', 'support', 'help', 'status'].includes(child[1]))) return null;
  return url.origin;
}

export function normalizeAutoPanelSettings(input) {
  if (input === undefined) return EMPTY();
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 ||
      Object.keys(input).some(key => !['schemaVersion', 'enabledOrigins', 'collapsedOrigins'].includes(key))) throw new Error('Invalid panel settings');
  for (const field of ['enabledOrigins', 'collapsedOrigins']) {
    if (!Array.isArray(input[field]) || input[field].length > MAX_SITES || new Set(input[field]).size !== input[field].length ||
        input[field].some(origin => supportedSiteOrigin(origin) !== origin)) throw new Error('Invalid panel settings');
  }
  if (input.collapsedOrigins.some(origin => !input.enabledOrigins.includes(origin))) throw new Error('Invalid panel settings');
  return { schemaVersion: 1, enabledOrigins: [...input.enabledOrigins], collapsedOrigins: [...input.collapsedOrigins] };
}
export async function readAutoPanelSettings(api, promiseApi) {
  const stored = await browserCall(api, api.storage?.local, 'get', [AUTO_PANEL_KEY], promiseApi);
  return normalizeAutoPanelSettings(stored?.[AUTO_PANEL_KEY]);
}
export async function writeAutoPanelSettings(api, input, promiseApi) {
  const value = normalizeAutoPanelSettings(input);
  await browserCall(api, api.storage?.local, 'set', [{ [AUTO_PANEL_KEY]: value }], promiseApi);
  return value;
}
export function changeAutoPanelOrigin(value, origin, { enabled, collapsed } = {}) {
  const settings = normalizeAutoPanelSettings(value);
  if (supportedSiteOrigin(origin) !== origin) throw new Error('Unsupported panel site');
  for (const [key, flag] of [['enabledOrigins', enabled], ['collapsedOrigins', collapsed]]) {
    if (typeof flag !== 'boolean') continue;
    settings[key] = settings[key].filter(item => item !== origin);
    if (flag) settings[key].push(origin);
  }
  if (enabled === false) settings.collapsedOrigins = settings.collapsedOrigins.filter(item => item !== origin);
  return normalizeAutoPanelSettings(settings);
}

/** Runs only in the extension's background context. Exact granted origins are
 * registered; private routes are rejected by the content module before DOM reads. */
export async function reconcileAutoPanelScripts(api, promiseApi = false) {
  const settings = await readAutoPanelSettings(api, promiseApi);
  const origins = [];
  for (const origin of settings.enabledOrigins) {
    if (await browserCall(api, api.permissions, 'contains', [{ origins: [`${origin}/*`] }], promiseApi)) origins.push(origin);
  }
  const scripts = await browserCall(api, api.scripting, 'getRegisteredContentScripts', [{ ids: [AUTO_PANEL_SCRIPT_ID] }], promiseApi);
  const current = Array.isArray(scripts) ? scripts.find(script => script.id === AUTO_PANEL_SCRIPT_ID) : null;
  const matches = origins.map(origin => `${origin}/*`).sort();
  const wanted = { id: AUTO_PANEL_SCRIPT_ID, js: ['panel-loader.js'], matches,
    allFrames: false, runAt: 'document_idle', persistAcrossSessions: true };
  if (current && JSON.stringify([...(current.matches ?? [])].sort()) === JSON.stringify(matches)
      && JSON.stringify(current.js) === JSON.stringify(wanted.js) && current.allFrames === false &&
      current.runAt === wanted.runAt && current.persistAcrossSessions !== false) return origins;
  if (current) await browserCall(api, api.scripting, 'unregisterContentScripts', [{ ids: [AUTO_PANEL_SCRIPT_ID] }], promiseApi);
  if (matches.length) await browserCall(api, api.scripting, 'registerContentScripts', [[wanted]], promiseApi);
  return origins;
}

const TEXT = {
  ko: { enable: '이 사이트에서 자동 패널 켜기', disable: '이 사이트 자동 패널 끄기', hide: '패널 숨기기 / 다시 표시',
    disableAll: '모든 사이트 자동 패널 끄기', off: '자동 패널이 꺼져 있어요. 이 사이트 권한을 허용하면 지원 상품 페이지에서 큰 패널이 열려요.',
    on: '이 사이트의 자동 패널이 켜져 있어요. 패널을 숨기면 작은 열기 버튼으로 남아요.', busy: '자동 패널 설정을 변경하고 있어요.',
    failed: '설정을 바꾸지 못했어요. 브라우저의 사이트 접근 권한과 확장 버전을 확인해 주세요.', denied: '사이트 접근을 허용하지 않아 자동 패널을 켜지 않았어요.',
    scope: '브라우저가 이 사이트의 읽기·변경 권한을 요청해요. 자동 패널은 지원되는 공개 상품 경로에서만 동작해요.',
    refresh: '다른 열린 페이지는 새로고침하면 설정이 반영돼요. 자동 표시를 꺼도 허용한 사이트 권한은 브라우저에 남아 다시 켤 때 재사용해요.', heading: '자동 상품 패널' },
  en: { enable: 'Enable automatic panel on this site', disable: 'Disable automatic panel on this site', hide: 'Hide / show this site’s panel',
    disableAll: 'Disable all automatic panels', off: 'Automatic panels are off. Grant this site access to show a larger panel on supported product pages.',
    on: 'Automatic panels are enabled on this site. A hidden panel leaves a small reopen button.', busy: 'Updating automatic panel settings…',
    failed: 'Could not update settings. Check browser site access and the extension version.', denied: 'Site access was not granted, so automatic panels remain off.',
    scope: 'The browser asks to read and change this site. Automatic panels run only on supported public product routes.',
    refresh: 'Refresh other open pages to apply this setting. Disabling automatic display retains the browser site grant for reuse.', heading: 'Automatic product panels' },
};

/** Mounts only in the trusted toolbar popup. Host permission requests are
 * invoked immediately from the click handler, before any await loses its gesture. */
export async function mountAutoPanelSettings({ document, api, promiseApi = false, language = 'ko' }) {
  const controls = document.getElementById('autoPanelSettings');
  if (!controls) return;
  const words = TEXT[language.toLowerCase().startsWith('ko') ? 'ko' : 'en'];
  document.getElementById('autoPanelHeading').textContent = words.heading;
  const enable = document.getElementById('enableAutoPanel'), disable = document.getElementById('disableAutoPanel');
  const hide = document.getElementById('hideAutoPanel'), all = document.getElementById('disableAllAutoPanels');
  const status = document.getElementById('autoPanelStatus');
  for (const [node, key] of [[enable, 'enable'], [disable, 'disable'], [hide, 'hide'], [all, 'disableAll']]) { node.textContent = words[key]; node.disabled = true; }
  document.getElementById('autoPanelScope').textContent = words.scope;
  document.getElementById('autoPanelRefresh').textContent = words.refresh;
  let settings, tab, origin, busy = false;
  const render = () => {
    const enabled = Boolean(origin && settings?.enabledOrigins.includes(origin));
    enable.disabled = busy || !origin; disable.disabled = busy || !enabled; hide.disabled = busy || !enabled;
    all.disabled = busy || !settings?.enabledOrigins.length;
    status.textContent = enabled ? words.on : words.off;
  };
  try {
    const tabs = await browserCall(api, api.tabs, 'query', [{ active: true, currentWindow: true }], promiseApi);
    tab = Array.isArray(tabs) ? tabs[0] : null;
    const metadata = metadataFromProductUrl(tab?.url);
    origin = metadata ? supportedSiteOrigin(new URL(tab.url).origin) : null;
    settings = await readAutoPanelSettings(api, promiseApi); render();
  } catch { status.textContent = words.failed; return; }
  const sync = async () => {
    const response = await browserCall(api, api.runtime, 'sendMessage', [{ kind: 'indiedeck-auto-panel-sync' }], promiseApi);
    if (response?.ok !== true) throw new Error('Panel sync failed');
  };
  async function perform(task) {
    if (busy) return;
    busy = true; render(); status.textContent = words.busy;
    try { const message = await task(); settings = await readAutoPanelSettings(api, promiseApi); render(); if (typeof message === 'string') status.textContent = message; }
    catch { status.textContent = words.failed; }
    finally { busy = false; const text = status.textContent; render(); status.textContent = text; }
  }
  enable.addEventListener('click', () => {
    if (busy || !origin) return;
    // Keep the request inside the original browser user gesture.
    const grant = browserCall(api, api.permissions, 'request', [{ origins: [`${origin}/*`] }], promiseApi);
    void perform(async () => {
      if (!await grant) return words.denied;
      const previous = await readAutoPanelSettings(api, promiseApi);
      await writeAutoPanelSettings(api, changeAutoPanelOrigin(previous, origin, { enabled: true, collapsed: false }), promiseApi);
      try { await sync(); }
      catch (error) { await writeAutoPanelSettings(api, previous, promiseApi); throw error; }
      // Open immediately on the current supported page; future navigations use
      // the registered script. The module revalidates before reading any title.
      const active = await browserCall(api, api.tabs, 'query', [{ active: true, currentWindow: true }], promiseApi);
      if (active?.[0]?.id === tab?.id && metadataFromProductUrl(active[0]?.url) && new URL(active[0].url).origin === origin) {
        await browserCall(api, api.scripting, 'executeScript', [{ target: { tabId: tab.id, frameIds: [0] }, files: ['panel-loader.js'] }], promiseApi);
      }
    });
  });
  disable.addEventListener('click', () => { if (!origin) return; void perform(async () => {
    await writeAutoPanelSettings(api, changeAutoPanelOrigin(await readAutoPanelSettings(api, promiseApi), origin, { enabled: false }), promiseApi); await sync();
  }); });
  hide.addEventListener('click', () => { if (!origin) return; void perform(async () => {
    const current = await readAutoPanelSettings(api, promiseApi);
    await writeAutoPanelSettings(api, changeAutoPanelOrigin(current, origin, { collapsed: !current.collapsedOrigins.includes(origin) }), promiseApi);
  }); });
  all.addEventListener('click', () => { void perform(async () => {
    const current = await readAutoPanelSettings(api, promiseApi); current.enabledOrigins = []; current.collapsedOrigins = [];
    await writeAutoPanelSettings(api, current, promiseApi); await sync();
  }); });
}

/** Trusted extension toolbar only. It never runs in the product-page panel,
 * and only a direct user click asks this extension to reload its own code. */
export function mountCompanionReload({ document, api, language = 'ko' }) {
  const button = document.getElementById('reloadCompanion');
  if (!button) return;
  const korean = language.toLowerCase().startsWith('ko');
  button.textContent = korean ? '확장 업데이트 적용 / 새로고침' : 'Apply extension update / reload';
  const trusted = typeof api.runtime?.getURL === 'function' && document.location?.href === api.runtime.getURL('popup.html');
  button.disabled = !trusted || typeof api.runtime?.reload !== 'function';
  button.addEventListener('click', () => {
    if (button.disabled || !trusted) return;
    button.disabled = true;
    const fail = () => {
      button.disabled = false;
      const status = document.getElementById('autoPanelStatus');
      if (status) status.textContent = korean ? '확장을 새로고침하지 못했어요. 브라우저 확장 관리에서 새로고침해 주세요.' : 'Could not reload. Use the browser extension manager to reload this extension.';
    };
    try { const pending = api.runtime.reload(); if (pending?.catch) pending.catch(fail); }
    catch { fail(); }
  });
}

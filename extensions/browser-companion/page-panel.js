import { mountPopup } from './popup-controller.js';
import { metadataFromProductUrl } from './store-link.js';
import { normalizeArtworkUrl } from './artwork.js';
import { AUTO_PANEL_KEY, readAutoPanelSettings, writeAutoPanelSettings, changeAutoPanelOrigin, normalizeAutoPanelSettings } from './auto-panel-settings.js';

export const PANEL_HOST_ID = 'indiedeck-product-panel-host';
const instances = new WeakMap();
const routeWatchers = new WeakMap();
const PROVIDER_NAMES = { steam: 'Steam', epic: 'Epic Games Store', gog: 'GOG', itch: 'itch.io', booth: 'BOOTH', dlsite: 'DLsite' };
const text = {
  ko: { name: 'IndieDeck 상품 가져오기', collapse: '접기', hide: '숨기기', reopen: 'IndieDeck 열기', disable: '이 사이트 자동 표시 끄기',
    hint: '공개 상품 정보만 가져와요. 언어·구매·다운로드 상태는 브라우저에서 확인해 주세요.', fail: '설정을 저장하지 못했어요. 브라우저 확장 버튼에서 다시 시도해 주세요.' },
  en: { name: 'Import product to IndieDeck', collapse: 'Collapse', hide: 'Hide', reopen: 'Open IndieDeck', disable: 'Disable automatic display on this site',
    hint: 'Import public product details only. Check language, purchase and download status in your browser.', fail: 'Could not save settings. Retry from the browser extension button.' },
};

function sameProduct(window, expected, origin) {
  const current = metadataFromProductUrl(window.location?.href);
  return Boolean(current && current.provider === expected.provider && current.productId === expected.productId &&
    new URL(window.location.href).origin === origin);
}
/** A public route is checked before querying even the page's image metadata. */
export function collectPanelArtwork(document, window, expected, origin) {
  if (!sameProduct(window, expected, origin)) throw new Error('Product page changed');
  const nodes = document.querySelectorAll('meta[property="og:image"],meta[name="og:image"],meta[name="twitter:image"],meta[property="twitter:image"]');
  const images = [];
  for (let index = 0; index < Math.min(nodes.length, 8); index += 1) {
    const content = nodes[index].getAttribute('content');
    const value = typeof content === 'string' && content.length <= 2048 ? normalizeArtworkUrl(expected.provider, expected.productId, content.trim()) : null;
    if (value && !images.includes(value)) images.push(value);
  }
  return images;
}

const STYLE = `
:host{all:initial!important;position:fixed!important;top:16px!important;right:16px!important;z-index:2147483000!important;max-width:calc(100vw - 32px)!important;color-scheme:dark}
*{box-sizing:border-box} [hidden]{display:none!important}
.panel{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;border:1px solid #9bb7ff;border-radius:12px;background:#151923;color:#f0f3ff;box-shadow:0 8px 36px #0007;font:15px/1.65 'Malgun Gothic','Segoe UI',system-ui,sans-serif}
.bar{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:14px 18px;background:#20283b;border-bottom:1px solid #596782}
.bar strong{flex:1;font-size:17px}.content{padding:20px} h1{font-size:22px;line-height:1.4;margin:0 0 10px} p{margin:10px 0;overflow-wrap:anywhere} .intro,.privacy,.scope,dt{color:#c1cbe0} .scope{font-size:13px}
button,input,select{font:inherit;color:inherit} button{min-height:44px;padding:9px 13px;border:1px solid #8ca8ed;border-radius:7px;background:#304e90;cursor:pointer} button:disabled{opacity:.5;cursor:default}
.bar button{background:#293650;min-height:38px;padding:5px 11px} .reopen{font:600 15px/1.5 'Malgun Gothic','Segoe UI',system-ui,sans-serif;box-shadow:0 3px 18px #0006}
label,.page-label{display:block;margin:14px 0 7px}input,select{width:100%;padding:10px;border:1px solid #697a9e;border-radius:6px;background:#101520}dl{display:grid;grid-template-columns:auto 1fr;gap:7px 14px;margin:16px 0}dd{margin:0;overflow-wrap:anywhere}
a{display:block;color:#c4d6ff;overflow-wrap:anywhere}#status{border-left:3px solid #a5bfff;background:#222a3e;border-radius:5px;padding:10px 13px}
.artwork-controls{padding:14px;border:1px solid #56637f;border-radius:8px;margin:16px 0}.artwork-controls button,#copyLink,#saveLink{width:100%}#copyLink,#saveLink{margin-top:12px}
.checkbox-label{display:flex;align-items:flex-start;gap:9px}.checkbox-label input{width:auto;margin-top:5px}.privacy{border-top:1px solid #53617b;padding-top:14px}.site-disable{width:100%;margin-top:14px;background:#293650}
:focus-visible{outline:3px solid #c6d8ff;outline-offset:3px}
`;

function productControls(document, parent) {
  const node = (tag, id, i18n, into = parent) => {
    const value = document.createElement(tag);
    if (id) value.id = id;
    if (i18n) value.dataset.i18n = i18n;
    into.append(value); return value;
  };
  node('h1', null, 'heading'); node('p', null, 'intro').className = 'intro';
  node('p', 'status').setAttribute('role', 'status');
  const preview = node('section', 'preview'); preview.hidden = true;
  const details = node('dl', null, null, preview);
  node('dt', null, 'provider', details); node('dd', 'provider', null, details);
  node('dt', null, 'product', details); node('dd', 'productId', null, details);
  const label = node('label', null, 'title', preview); label.setAttribute('for', 'productTitle');
  const title = node('input', 'productTitle', null, preview); title.type = 'text'; title.maxLength = 240; title.autocomplete = 'off';
  node('p', null, 'page', preview).className = 'page-label';
  const link = node('a', 'productPage', null, preview); link.target = '_blank'; link.rel = 'noopener noreferrer';
  const artwork = node('section', null, null, preview); artwork.className = 'artwork-controls';
  const find = node('button', 'findArtwork', 'findArtwork', artwork); find.type = 'button'; find.disabled = true;
  node('p', 'artworkStatus', 'artworkHint', artwork).setAttribute('role', 'status');
  node('label', null, 'artworkChoice', artwork).setAttribute('for', 'artworkChoice');
  node('select', 'artworkChoice', null, artwork).disabled = true;
  const checkLabel = node('label', null, null, artwork); checkLabel.className = 'checkbox-label';
  const include = node('input', 'includeArtwork', null, checkLabel); include.type = 'checkbox'; include.disabled = true;
  node('span', null, 'includeArtwork', checkLabel);
  for (const [id, key] of [['copyLink', 'copy'], ['saveLink', 'export']]) {
    const button = node('button', id, key, preview); button.type = 'button'; button.disabled = true;
  }
  node('p', null, 'instructions', preview).className = 'instructions';
  node('p', null, 'privacy').className = 'privacy'; node('p', null, 'scope').className = 'scope';
}

/** No iframe, page message listener, account data, remote resources or timer
 * polling. A granted origin can display UI only on an exact public product route. */
export async function mountProductPanel({ document, window, api, promiseApi = false, language = 'ko' }) {
  if (!window || window.top !== window.self) return null;
  // A supported site can navigate to its product route without reloading. The
  // watcher checks URL identity only; even an initial private route reads no DOM.
  if (!routeWatchers.has(document)) {
    const remove = [], origin = new URL(window.location.href).origin;
    const check = () => { void mountProductPanel({ document, window, api, promiseApi, language }); };
    const on = (target, name) => { target?.addEventListener?.(name, check); remove.push(() => target?.removeEventListener?.(name, check)); };
    on(window, 'popstate'); on(window, 'hashchange');
    on(window.navigation, 'currententrychange'); on(window.navigation, 'navigatesuccess');
    const changed = (changes, area) => {
      if (area !== 'local' || !changes?.[AUTO_PANEL_KEY]) return;
      let enabled = false;
      try { enabled = normalizeAutoPanelSettings(changes[AUTO_PANEL_KEY].newValue).enabledOrigins.includes(origin); } catch { /* stop routing on invalid local state */ }
      if (!enabled) { remove.forEach(dispose => dispose()); api.storage?.onChanged?.removeListener(changed); routeWatchers.delete(document); }
    };
    api.storage?.onChanged?.addListener(changed); routeWatchers.set(document, true);
  }
  const metadata = metadataFromProductUrl(window.location?.href);
  if (!metadata) {
    // Remove only our existing UI after a same-document private navigation.
    // No page title, body content or metadata is inspected here.
    const current = instances.get(document);
    if (current?.dispose) current.dispose();
    else if (current) void Promise.resolve(current).then(value => value?.dispose());
    return null;
  }
  if (instances.has(document)) return instances.get(document);
  let controller;
  const pending = create(); instances.set(document, pending);
  try {
    controller = await pending;
    if (instances.get(document) === pending) {
      if (controller) instances.set(document, controller); else instances.delete(document);
    }
    return controller;
  } catch { if (instances.get(document) === pending) instances.delete(document); return null; }

  async function create() {
    const origin = new URL(window.location.href).origin;
    const settings = await readAutoPanelSettings(api, promiseApi);
    if (!settings.enabledOrigins.includes(origin) || !sameProduct(window, metadata, origin)) return null;
    if (!document.body || document.getElementById(PANEL_HOST_ID)) return null;
    // The public title is read only after route, grant-backed registration and
    // stored opt-in checks. It remains editable display text, never authority.
    const current = metadataFromProductUrl(window.location.href, document.title);
    const words = text[language.toLowerCase().startsWith('ko') ? 'ko' : 'en'];
    const host = document.createElement('div'); host.id = PANEL_HOST_ID;
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important'); host.style.setProperty('top', '16px', 'important');
    host.style.setProperty('right', '16px', 'important'); host.style.setProperty('z-index', '2147483000', 'important');
    const shadow = host.attachShadow({ mode: 'closed' }), style = document.createElement('style'); style.textContent = STYLE; shadow.append(style);
    const panel = document.createElement('section'); panel.className = 'panel'; panel.id = 'indiedeckPanel';
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', words.name);
    const bar = document.createElement('div'); bar.className = 'bar';
    const heading = document.createElement('strong'); heading.textContent = `${words.name} · ${PROVIDER_NAMES[current.provider]}`; bar.append(heading);
    const button = (id, label) => { const value = document.createElement('button'); value.id = id; value.type = 'button'; value.textContent = label; return value; };
    const collapse = button('panelCollapse', words.collapse), hide = button('panelHide', words.hide);
    bar.append(collapse, hide); panel.append(bar);
    const content = document.createElement('div'); content.className = 'content'; panel.append(content); productControls(document, content);
    const disable = button('panelDisableSite', words.disable); disable.className = 'site-disable'; content.append(disable);
    const ownStatus = document.createElement('p'); ownStatus.id = 'panelSettingsStatus'; ownStatus.setAttribute('role', 'status'); content.append(ownStatus);
    const reopen = button('panelReopen', words.reopen); reopen.className = 'reopen';
    shadow.append(panel, reopen); document.body.append(host);
    let disposed = false, writing = false;
    const cleanups = [];
    const listen = (target, event, fn) => { target?.addEventListener?.(event, fn); cleanups.push(() => target?.removeEventListener?.(event, fn)); };
    const show = value => { panel.hidden = !value; reopen.hidden = value; };
    show(!settings.collapsedOrigins.includes(origin));
    const scoped = { documentElement: content, body: content, createElement: tag => document.createElement(tag),
      getElementById: id => shadow.getElementById(id), querySelectorAll: selector => content.querySelectorAll(selector) };
    await mountPopup({ document: scoped, api, promiseApi, language, productContext: {
      metadata: current, isCurrent: () => !disposed && sameProduct(window, current, origin),
      readArtwork: () => collectPanelArtwork(document, window, current, origin),
    } });
    async function change(change) {
      if (writing || disposed || !sameProduct(window, current, origin)) return;
      writing = true; collapse.disabled = hide.disabled = reopen.disabled = disable.disabled = true;
      try {
        const saved = await writeAutoPanelSettings(api, changeAutoPanelOrigin(await readAutoPanelSettings(api, promiseApi), origin, change), promiseApi);
        if (!saved.enabledOrigins.includes(origin)) dispose();
        else show(!saved.collapsedOrigins.includes(origin));
      } catch { ownStatus.textContent = words.fail; }
      finally { writing = false; collapse.disabled = hide.disabled = reopen.disabled = disable.disabled = false; }
    }
    collapse.addEventListener('click', () => { void change({ collapsed: true }); });
    hide.addEventListener('click', () => { void change({ collapsed: true }); });
    reopen.addEventListener('click', () => { void change({ collapsed: false }); });
    disable.addEventListener('click', () => { void change({ enabled: false }); });
    const storageChanged = (changes, area) => {
      if (area !== 'local' || !changes?.[AUTO_PANEL_KEY]) return;
      void readAutoPanelSettings(api, promiseApi).then(saved => {
        if (disposed) return;
        if (!saved.enabledOrigins.includes(origin)) dispose();
        else show(!saved.collapsedOrigins.includes(origin));
      }).catch(dispose);
    };
    api.storage?.onChanged?.addListener(storageChanged); cleanups.push(() => api.storage?.onChanged?.removeListener(storageChanged));
    const navigation = () => {
      if (disposed || sameProduct(window, current, origin)) return;
      dispose(); void mountProductPanel({ document, window, api, promiseApi, language });
    };
    listen(window, 'popstate', navigation); listen(window, 'hashchange', navigation);
    if (window.navigation) {
      listen(window.navigation, 'navigatesuccess', navigation);
      listen(window.navigation, 'currententrychange', navigation);
    }
    const title = document.querySelector('title'), Observer = window.MutationObserver;
    let observer;
    if (title && typeof Observer === 'function') {
      observer = new Observer(navigation); observer.observe(title, { childList: true, characterData: true, subtree: true });
    }
    function dispose() {
      if (disposed) return;
      disposed = true; observer?.disconnect(); cleanups.forEach(cleanup => cleanup()); host.remove();
      const owned = instances.get(document);
      if (owned === pending || owned === controller) instances.delete(document);
    }
    // A hide/disable may arrive while the first UI mount is awaiting. Re-read
    // after subscribing so no earlier storage event can leave stale visible UI.
    const latest = await readAutoPanelSettings(api, promiseApi);
    if (disposed || !latest.enabledOrigins.includes(origin) || !sameProduct(window, current, origin)) { dispose(); return null; }
    show(!latest.collapsedOrigins.includes(origin));
    return { host, dispose, collapse: () => change({ collapsed: true }), reopen: () => change({ collapsed: false }) };
  }
}

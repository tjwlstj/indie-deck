// Registered as an isolated, top-frame-only classic content script. Import only
// extension-owned modules; no page scripts or messages are executed.
(() => {
  if (globalThis.top !== globalThis.self) return;
  const api = globalThis.browser ?? globalThis.chrome ?? globalThis.whale;
  if (!api?.runtime?.getURL) return;
  void import(api.runtime.getURL('page-panel.js')).then(module => module.mountProductPanel({
    document, window: globalThis, api, promiseApi: Boolean(globalThis.browser), language: navigator.language,
  })).catch(() => {});
})();

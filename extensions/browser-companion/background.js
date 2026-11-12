import { AUTO_PANEL_KEY, readAutoPanelSettings, writeAutoPanelSettings, reconcileAutoPanelScripts } from './auto-panel-settings.js';
import { browserCall } from './browser-api.js';

export function installAutoPanelBackground(api, promiseApi = false) {
  let pending = Promise.resolve();
  const sync = () => {
    const work = pending.catch(() => {}).then(() => reconcileAutoPanelScripts(api, promiseApi));
    pending = work; return work;
  };
  const quietSync = () => { void sync().catch(() => {}); };
  api.runtime?.onInstalled?.addListener(quietSync);
  api.runtime?.onStartup?.addListener(quietSync);
  api.storage?.onChanged?.addListener((changes, area) => { if (area === 'local' && changes?.[AUTO_PANEL_KEY]) quietSync(); });
  api.permissions?.onAdded?.addListener(quietSync);
  api.permissions?.onRemoved?.addListener(() => {
    void (async () => {
      const settings = await readAutoPanelSettings(api, promiseApi), kept = [];
      for (const origin of settings.enabledOrigins) {
        if (await browserCall(api, api.permissions, 'contains', [{ origins: [`${origin}/*`] }], promiseApi)) kept.push(origin);
      }
      if (kept.length !== settings.enabledOrigins.length) await writeAutoPanelSettings(api, { ...settings, enabledOrigins: kept,
        collapsedOrigins: settings.collapsedOrigins.filter(origin => kept.includes(origin)) }, promiseApi);
      await sync();
    })().catch(() => {});
  });
  api.runtime?.onMessage?.addListener((message, sender, respond) => {
    if (message?.kind !== 'indiedeck-auto-panel-sync' || sender?.id !== api.runtime.id || sender?.tab ||
        sender?.url !== api.runtime.getURL('popup.html')) return undefined;
    void sync().then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  });
  quietSync();
  return { sync };
}

const api = globalThis.browser ?? globalThis.chrome ?? globalThis.whale;
if (api?.runtime?.id) installAutoPanelBackground(api, Boolean(globalThis.browser));

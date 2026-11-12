import { mountPopup } from './popup-controller.js';
import { mountAutoPanelSettings, mountCompanionReload } from './auto-panel-settings.js';

const api = globalThis.browser ?? globalThis.chrome ?? globalThis.whale;
mountCompanionReload({ document, api, language: navigator.language });
void mountPopup({ document, api, promiseApi: Boolean(globalThis.browser), language: navigator.language });
void mountAutoPanelSettings({ document, api, promiseApi: Boolean(globalThis.browser), language: navigator.language });

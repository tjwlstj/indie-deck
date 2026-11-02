import { mountPopup } from './popup-controller.js';

const api = globalThis.browser ?? globalThis.chrome ?? globalThis.whale;
void mountPopup({ document, api, promiseApi: Boolean(globalThis.browser), language: navigator.language });

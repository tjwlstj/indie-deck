/**
 * Renderer-side translation.
 *
 * The renderer has no filesystem access, so the main process ships it a
 * flattened catalogue (English merged under the active locale) and this module
 * does the lookups. Behaviour matches core's `t()`: a missing key renders the
 * English source text written at the call site, so a new string works before it
 * is translated.
 */

let catalog = {};
let locale = 'en';
let locales = [];

export function applyCatalog(payload) {
  catalog = payload?.catalog ?? {};
  locale = payload?.locale ?? 'en';
  locales = payload?.locales ?? [];
}

export function currentLocale() {
  return locale;
}

export function localeOptions() {
  return locales;
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
}

/** `t(key, params, fallbackEnglish)` */
export function t(key, params, fallback) {
  const template = catalog[key] ?? fallback ?? key;
  return interpolate(template, params);
}

/**
 * Re-renders a message core already translated. Core sends `text` plus the key
 * and params it was built from, so a language switch does not require the
 * resolver to run again.
 */
export function retranslate(entry, keyField = 'messageKey', paramsField = 'messageParams', textField = 'message') {
  const key = entry?.[keyField];
  if (!key) return entry?.[textField] ?? '';
  return t(key, entry[paramsField], entry[textField]);
}

/**
 * Translates the static chrome. Elements opt in with `data-i18n="key"` for text
 * or `data-i18n-attr="attr:key"` for an attribute, so index.html never needs
 * touching again when a language is added.
 */
export function applyStaticTranslations(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n, undefined, node.textContent);
  }
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':');
      if (!attr || !key) continue;
      node.setAttribute(attr.trim(), t(key.trim(), undefined, node.getAttribute(attr.trim()) ?? ''));
    }
  }
  document.documentElement.lang = locale;
}

/** Tiny DOM helpers. Deliberately not a framework. */

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Status bar. `tone` is 'ok' | 'err' | undefined. */
export function setStatus(text, tone) {
  const node = $('status');
  if (!node) return;
  node.textContent = text;
  node.removeAttribute('data-i18n');
  node.style.color = tone === 'err' ? 'var(--err)' : tone === 'ok' ? 'var(--ok)' : '';
}

export function severityTone(severity) {
  if (severity === 'block' || severity === 'error') return 'err';
  if (severity === 'warn') return 'warn';
  return 'info';
}

export function severityMark(severity) {
  if (severity === 'block' || severity === 'error') return '×';
  if (severity === 'warn') return '!';
  return '•';
}

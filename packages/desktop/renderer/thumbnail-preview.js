import { t } from './i18n.js';
import { normaliseThumbnail } from './thumbnail-model.js';

const bindings = new WeakMap(), managers = new WeakMap(), images = new Map();
let nextId = 0;

function remember(binding, image) {
  images.delete(binding);
  if (image) images.set(binding, image);
  // Preview browsing must not retain an image for every search result.
  while (images.size > 4) images.delete(images.keys().next().value);
}

function managerFor(document, window) {
  let manager = managers.get(document);
  if (manager) return manager;
  let active = null, generation = 0;
  const hoverTimers = new Set();
  const listen = (node, name, fn, options) => {
    node?.addEventListener?.(name, fn, options);
    return () => node?.removeEventListener?.(name, fn, options);
  };
  function close(reason = 'dismiss') {
    generation += 1;
    const previous = active; active = null;
    if (!previous) return;
    previous.cleanups.forEach(cleanup => cleanup());
    previous.observer?.disconnect(); previous.node.remove();
    previous.binding.expanded(false);
    if (previous.pinned && ['escape', 'button', 'toggle'].includes(reason)) {
      const trigger = previous.binding.toggleButton ?? previous.binding.target;
      if (trigger.isConnected !== false) trigger.focus?.({ preventScroll: true });
    }
  }
  const cancelHovers = () => { for (const cancel of [...hoverTimers]) cancel(); };
  const dismissAll = reason => { cancelHovers(); close(reason); };
  // One listener set per document also cancels delayed hovers before a popover exists.
  listen(window, 'blur', () => dismissAll('blur'));
  listen(document, 'visibilitychange', () => { if (document.hidden === true) dismissAll('hidden'); });
  for (const event of ['scroll', 'resize']) listen(window, event, value => {
    if (event === 'scroll' && value?.target && active?.node.contains(value.target)) return;
    dismissAll(event);
  }, true);
  listen(window, 'keydown', event => { if (event.key === 'Escape') cancelHovers(); }, true);
  async function open(binding, pinned) {
    if (binding.disposed || binding.target.isConnected === false || document.hidden === true) return;
    if (active?.pinned && !pinned) return;
    if (pinned) cancelHovers();
    if (active?.binding === binding) {
      active.pinned ||= pinned;
      return;
    }
    close();
    const token = generation;
    const node = document.createElement('div'); node.className = 'thumbnail-preview-popover';
    node.id = `thumbnail-preview-${++nextId}`;
    node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'false');
    node.setAttribute('aria-label', binding.label || t('ui.thumbnail.preview', undefined, 'Image preview'));
    const heading = document.createElement('strong'); heading.className = 'thumbnail-preview-label'; heading.textContent = binding.label;
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'ghost thumbnail-preview-close';
    dismiss.textContent = t('ui.thumbnail.previewClose', undefined, 'Close preview');
    dismiss.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); close('button'); });
    const status = document.createElement('p'); status.className = 'thumbnail-preview-status'; status.setAttribute('role', 'status');
    status.textContent = t('ui.thumbnail.previewLoading', undefined, 'Loading preview…');
    node.append(heading, dismiss, status); document.body.append(node);
    const rect = binding.target.getBoundingClientRect?.() ?? { top: 12, left: 12, right: 12, bottom: 12 };
    const width = window?.innerWidth ?? 1024, height = window?.innerHeight ?? 768;
    const left = Math.max(8, Math.min(rect.right + 8 + 344 <= width ? rect.right + 8 : rect.left, width - 344));
    const above = rect.bottom + 306 > height && rect.top >= 306;
    const top = Math.max(8, Math.min(above ? rect.top - 306 : rect.bottom + 6, height - 100));
    node.style.left = `${left}px`; node.style.top = `${top}px`;
    node.style.maxWidth = `${Math.max(80, width - left - 8)}px`;
    node.style.maxHeight = `${Math.max(60, height - top - 8)}px`;
    const item = { binding, pinned, node, cleanups: [], observer: null };
    active = item; binding.expanded(true, node.id);
    // Window capture runs before the gaming navigator's document capture:
    // Escape dismisses a preview without leaving native fullscreen mode.
    item.cleanups.push(listen(window, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissAll('escape'); }
    }, true));
    item.cleanups.push(listen(document, 'pointerdown', event => {
      if (!node.contains(event.target) && !binding.target.contains(event.target) && !binding.toggleButton?.contains(event.target)) dismissAll('outside');
    }, true));
    const Observer = window?.MutationObserver ?? globalThis.MutationObserver;
    if (typeof Observer === 'function') {
      item.observer = new Observer(() => { if (binding.target.isConnected === false) close('detached'); });
      item.observer.observe(document.body, { childList: true, subtree: true });
    }
    const image = await binding.read();
    if (active === item && (binding.disposed || binding.target.isConnected === false)) close('detached');
    if (active !== item || generation !== token) return;
    if (!image) {
      status.textContent = t('ui.thumbnail.previewUnavailable', undefined, 'This image preview is unavailable.');
      return;
    }
    const picture = document.createElement('img'); picture.className = 'thumbnail-preview-image';
    picture.alt = binding.label || t('ui.thumbnail.previewAlt', undefined, 'Image preview');
    picture.src = image.dataUrl;
    picture.addEventListener('error', () => {
      if (active !== item) return;
      picture.remove(); images.delete(binding);
      status.hidden = false; status.textContent = t('ui.thumbnail.previewUnavailable', undefined, 'This image preview is unavailable.');
    });
    status.hidden = true; node.append(picture);
  }
  manager = { close, open, scheduleHover: cancel => hoverTimers.add(cancel), cancelHover: cancel => hoverTimers.delete(cancel),
    isActive: binding => active?.binding === binding,
    isPinned: binding => active?.binding === binding && active.pinned };
  managers.set(document, manager);
  return manager;
}

/** An explicit toggle is always available. Optional hover/context modes only
 * open a read-only data-image preview; they never choose or save a cover. */
export function bindThumbnailPreview(target, { getThumbnail, label = '', mode = () => 'hover', toggleButton,
  document = target.ownerDocument ?? globalThis.document, window = document?.defaultView ?? globalThis.window,
  hoverDelay = 350, schedule = (fn, ms) => globalThis.setTimeout(fn, ms), cancel = id => globalThis.clearTimeout(id) } = {}) {
  bindings.get(target)?.dispose();
  let disposed = false, timer = null, pending = null;
  const manager = managerFor(document, window);
  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; manager.cancelHover(clearTimer); };
  const binding = {
    target, toggleButton, label,
    get disposed() { return disposed; },
    expanded(value, id) {
      if (toggleButton) {
        toggleButton.setAttribute('aria-expanded', String(value));
        if (id) toggleButton.setAttribute('aria-controls', id);
        else if (!value) toggleButton.removeAttribute?.('aria-controls');
      }
    },
    async read() {
      if (images.has(binding)) { const image = images.get(binding); remember(binding, image); return image; }
      if (pending) return pending;
      const request = Promise.resolve().then(() => getThumbnail?.()).then(normaliseThumbnail).catch(() => null);
      pending = request;
      try {
        const image = await request;
        if (!disposed && target.isConnected !== false) remember(binding, image);
        return image;
      } finally { if (pending === request) pending = null; }
    },
  };
  function enter() {
    clearTimer();
    if (mode() !== 'hover') return;
    timer = schedule(() => { timer = null; manager.cancelHover(clearTimer); if (mode() === 'hover') void manager.open(binding, false); }, hoverDelay);
    manager.scheduleHover(clearTimer);
  }
  function leave() { clearTimer(); if (manager.isActive(binding) && !manager.isPinned(binding)) manager.close('leave'); }
  function context(event) {
    if (mode() !== 'context') return;
    event.preventDefault(); event.stopPropagation(); clearTimer(); void manager.open(binding, true);
  }
  function toggle(event) {
    event?.preventDefault?.(); event?.stopPropagation?.(); clearTimer();
    if (manager.isPinned(binding)) manager.close('toggle'); else void manager.open(binding, true);
  }
  target.dataset.thumbnailPreview = 'true';
  target.addEventListener('mouseenter', enter); target.addEventListener('mouseleave', leave); target.addEventListener('contextmenu', context);
  toggleButton?.setAttribute('aria-expanded', 'false');
  toggleButton?.addEventListener('click', toggle);
  const controller = { toggle, close() { clearTimer(); if (manager.isActive(binding)) manager.close(); },
    invalidate() { clearTimer(); images.delete(binding); if (manager.isActive(binding)) manager.close(); },
    dispose() {
      if (disposed) return;
      disposed = true; clearTimer(); if (manager.isActive(binding)) manager.close('detached'); images.delete(binding);
      target.removeEventListener?.('mouseenter', enter); target.removeEventListener?.('mouseleave', leave); target.removeEventListener?.('contextmenu', context);
      toggleButton?.removeEventListener?.('click', toggle);
      delete target.dataset.thumbnailPreview; bindings.delete(target);
    } };
  bindings.set(target, controller);
  return controller;
}

/** Release before replacing rows/results so a hidden or detached image cannot
 * leave a floating preview or publish the result of an obsolete request. */
export function releaseThumbnailPreviews(container) {
  if (!container) return;
  bindings.get(container)?.dispose();
  for (const target of container.querySelectorAll?.('[data-thumbnail-preview]') ?? []) bindings.get(target)?.dispose();
}

export function invalidateThumbnailPreview(target) { bindings.get(target)?.invalidate(); }

import { t } from './i18n.js';

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';
const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function spatialTarget(items, active, direction) {
  if (!items.length) return null;
  if (!active || !items.includes(active)) return items.find(node => node.matches?.('.game.selected')) ?? items[0];
  const current = active.getBoundingClientRect();
  const origin = { x: current.left + current.width / 2, y: current.top + current.height / 2 };
  let chosen = null, score = Infinity;
  for (const node of items) {
    if (node === active) continue;
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - origin.x, y = rect.top + rect.height / 2 - origin.y;
    const primary = direction === 'right' ? x : direction === 'left' ? -x : direction === 'down' ? y : -y;
    if (primary <= 2) continue;
    const secondary = direction === 'right' || direction === 'left' ? Math.abs(y) : Math.abs(x);
    const candidate = primary + secondary * 2.5;
    if (candidate < score) { score = candidate; chosen = node; }
  }
  return chosen;
}

export function standardGamepadInput(pad) {
  if (!pad || pad.connected === false || pad.mapping !== 'standard') return { direction: null, activate: false, back: false };
  const pressed = index => Boolean(pad.buttons?.[index]?.pressed || pad.buttons?.[index]?.value > 0.6);
  const axis = index => Number.isFinite(pad.axes?.[index]) ? Math.max(-1, Math.min(1, pad.axes[index])) : 0;
  const horizontal = axis(0), vertical = axis(1);
  const direction = pressed(12) ? 'up' : pressed(13) ? 'down' : pressed(14) ? 'left' : pressed(15) ? 'right'
    : Math.abs(horizontal) >= 0.65 || Math.abs(vertical) >= 0.65
      ? Math.abs(horizontal) > Math.abs(vertical) ? horizontal > 0 ? 'right' : 'left' : vertical > 0 ? 'down' : 'up'
      : null;
  return { direction, activate: pressed(0), back: pressed(1) };
}

/** Controller polling exists only while this visible, focused window is in
 * gaming mode. Held activation buttons never repeat or activate on resume. */
export function createGamingNavigator({ document, window, readGamepads = () => window.navigator?.getGamepads?.() ?? [],
  onBack = () => {}, onToggle = () => {}, now = () => Date.now(),
  schedule = (fn, ms) => window.setTimeout(fn, ms), cancel = id => window.clearTimeout(id) }) {
  let enabled = false, timer = null, disposed = false, neutralRequired = true;
  let previous = { direction: null, activate: false, back: false }, nextDirectionAt = 0, padKey = null;
  const focused = () => document.hidden !== true && (typeof document.hasFocus !== 'function' || document.hasFocus());
  function scope() { const dialogs = [...document.querySelectorAll('dialog[open]')]; return dialogs.at(-1) ?? document; }
  function candidates() {
    return [...scope().querySelectorAll(FOCUSABLE)].filter(node => !node.disabled && !node.matches?.(':disabled') && node.tabIndex >= 0 &&
      node.getAttribute?.('aria-disabled') !== 'true' && !node.closest?.('[hidden], [inert], [aria-hidden="true"]') &&
      node.getClientRects().length > 0 && !['hidden', 'collapse'].includes(window.getComputedStyle?.(node).visibility));
  }
  function move(direction) {
    const node = spatialTarget(candidates(), document.activeElement, direction);
    if (!node) return;
    node.focus({ preventScroll: true }); node.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }
  function activate() {
    const nodes = candidates(); let node = document.activeElement;
    if (!nodes.includes(node)) { node = spatialTarget(nodes, null, 'down'); node?.focus(); }
    if (!node || node.disabled) return;
    // Native select popups are not opened by synthetic gamepad clicks. A cycles
    // their enabled options; keyboard users keep the normal select behavior.
    if (node.tagName === 'SELECT') {
      const options = [...node.options]; const start = node.selectedIndex >= 0 ? node.selectedIndex : -1;
      for (let offset = 1; offset <= options.length; offset += 1) {
        const index = (start + offset) % options.length;
        if (!options[index].disabled && !options[index].parentElement?.disabled) { node.selectedIndex = index; node.dispatchEvent(new window.Event('change', { bubbles: true })); break; }
      }
    } else node.click();
  }
  function back() {
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    if (dialogs.length) { dialogs.at(-1).close(); return; }
    onBack();
  }
  function stop() { if (timer !== null) cancel(timer); timer = null; neutralRequired = true; padKey = null; previous = { direction: null, activate: false, back: false }; }
  function poll() {
    timer = null;
    if (disposed || !enabled || !focused()) { stop(); return; }
    let pads; try { pads = [...readGamepads()]; } catch { pads = []; }
    const selectedPad = pads.find(pad => pad?.connected !== false && pad?.mapping === 'standard');
    if (!selectedPad) { neutralRequired = true; padKey = null; previous = { direction: null, activate: false, back: false }; return; }
    const key = `${selectedPad.index}:${selectedPad.id}`;
    if (padKey !== key) { padKey = key; neutralRequired = true; }
    const input = standardGamepadInput(selectedPad);
    if (neutralRequired) {
      if (!input.direction && !input.activate && !input.back) neutralRequired = false;
    } else {
      if (input.back && !previous.back) back();
      else if (input.activate && !previous.activate) activate();
      else if (input.direction && (!previous.direction || input.direction !== previous.direction || now() >= nextDirectionAt)) {
        move(input.direction); nextDirectionAt = now() + (input.direction === previous.direction ? 150 : 350);
      }
    }
    previous = input;
    if (!disposed && enabled && focused()) timer = schedule(poll, 50);
  }
  function wake() { stop(); if (!disposed && enabled && focused()) timer = schedule(poll, 50); }
  function keydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'F11') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) onToggle(); return; }
    if (!enabled || !focused()) return;
    const target = event.target ?? document.activeElement;
    if (event.key === 'Escape') {
      if (!document.querySelectorAll('dialog[open]').length && (EDITABLE.has(target?.tagName) || target?.isContentEditable)) return;
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) back(); return;
    }
    if (EDITABLE.has(target?.tagName) || target?.isContentEditable) return;
    const direction = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' })[event.key];
    if (direction) { event.preventDefault(); event.stopPropagation(); move(direction); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) activate();
    }
  }
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake); window.addEventListener('blur', stop);
  window.addEventListener('gamepadconnected', wake); window.addEventListener('gamepaddisconnected', wake);
  return {
    setEnabled(value) { const next = value === true; if (next !== enabled) { enabled = next; wake(); } },
    focusFirst() { const node = spatialTarget(candidates(), null, 'down'); node?.focus(); },
    dispose() {
      disposed = true; stop(); document.removeEventListener('keydown', keydown, true); document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake); window.removeEventListener('blur', stop);
      window.removeEventListener('gamepadconnected', wake); window.removeEventListener('gamepaddisconnected', wake);
    },
  };
}

/** Main owns OS fullscreen state. Renderer changes follow its confirmed state. */
export function bindGamingMode({ api, document = globalThis.document, window = globalThis.window, onBack, onError = () => {} }) {
  let snapshot = null, pending = false, readToken = 0;
  const button = document.getElementById('toggleGamingMode'), hint = document.getElementById('gamingNavigationHint');
  async function toggle(force) {
    if (pending || !api?.setFullscreen) return;
    pending = true; if (button) button.disabled = true;
    try { accept(await api.setFullscreen(typeof force === 'boolean' ? force : snapshot?.fullscreen !== true)); }
    catch { onError(); }
    finally { pending = false; render(); }
  }
  const navigator = createGamingNavigator({ document, window,
    onToggle: () => void toggle(), onBack: () => onBack?.(() => void toggle(false)) });
  function render() {
    const fullscreen = snapshot?.fullscreen === true;
    document.body.classList.toggle('gaming-mode', fullscreen);
    document.body.dataset.gamingMode = String(fullscreen);
    if (button) {
      button.textContent = fullscreen ? t('ui.gaming.exitMode', undefined, 'Window mode') : t('ui.gaming.enterMode', undefined, 'Gaming mode');
      button.setAttribute('aria-pressed', String(fullscreen)); button.disabled = pending || !api?.setFullscreen;
      button.title = t('ui.gaming.modeShortcut', undefined, 'Toggle gaming mode (F11)');
    }
    if (hint) { hint.hidden = !fullscreen; hint.textContent = t('ui.gaming.navigationHint', undefined, 'D-pad / stick: move · A: select or cycle options · B: back · F11: window mode'); }
    navigator.setEnabled(fullscreen);
  }
  function accept(value) {
    if (!value || typeof value.fullscreen !== 'boolean' || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return;
    if (Number.isSafeInteger(snapshot?.sequence) && (!Number.isSafeInteger(value.sequence) || value.sequence < snapshot.sequence)) return;
    const wasFullscreen = snapshot?.fullscreen === true; snapshot = value; readToken += 1; render();
    if (!wasFullscreen && value.fullscreen && (document.activeElement === document.body || document.activeElement === button)) navigator.focusFirst();
  }
  const unsubscribe = api?.onState?.(accept);
  if (button) button.addEventListener('click', () => void toggle());
  const token = ++readToken;
  Promise.resolve().then(() => api?.current?.()).then(value => { if (token === readToken) accept(value); }).catch(() => { render(); });
  render();
  return { accept, render, toggle, dispose: () => { navigator.dispose(); if (typeof unsubscribe === 'function') unsubscribe(); } };
}

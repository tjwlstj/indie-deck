import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, saveConfig } from '../src/library/index.ts';
import { scanLaunchTarget } from '../../desktop/src/security-launch-policy.ts';

class Element {
  tag: string; id = ''; className = ''; textContent = ''; type = ''; checked = false; disabled = false;
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; children: Element[] = [];
  listeners: Record<string, () => void> = {};
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute(_key: string, _value: string) {}
  removeAttribute(_key: string) {}
  addEventListener(name: string, fn: () => void) { this.listeners[name] = fn; }
  find(predicate: (node: Element) => boolean): Element | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return undefined;
  }
  text(): string { return [this.textContent, ...this.children.map((child) => child.text())].join(' '); }
}
async function until(check: () => boolean) {
  for (let tries = 0; tries < 400; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic UI action did not complete');
}

test('launch scan setting round-trips through synthetic UI and diagnostics follow only the selected game', async () => {
  const base = path.resolve('out'); await fs.mkdir(base, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(base, 'launch-scan-ui-'));
  const settings = new Element('div'); settings.id = 'securitySettingsBody';
  const status = new Element('div'); status.id = 'status';
  const panel = new Element('div');
  const roots = [settings, status, panel];
  let diagnosticListener: ((event: unknown) => void) | undefined;
  let release: (() => void) | undefined;
  let store: any;
  let saveCalls = 0;
  let rejectNext = false;
  const security = {
    setLaunchScan: async (enabled: unknown) => {
      assert.equal(typeof enabled, 'boolean'); saveCalls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      if (rejectNext) { rejectNext = false; throw new Error('synthetic save failure'); }
      const current = await loadConfig(fixture);
      await saveConfig({ ...current, scanOnLaunch: enabled as boolean }, fixture);
      return loadConfig(fixture);
    },
  };
  (globalThis as any).document = {
    createElement: (tag: string) => new Element(tag),
    getElementById: (id: string) => roots.map((root) => root.find((node) => node.id === id)).find(Boolean) ?? null,
  };
  (globalThis as any).CustomEvent = class { type: string; detail: unknown; constructor(type: string, data: { detail: unknown }) { this.type = type; this.detail = data.detail; } };
  (globalThis as any).window = {
    indiedeck: { security, game: { onLaunchDiagnostic: (fn: (event: unknown) => void) => { diagnosticListener = fn; } } },
    dispatchEvent: (event: any) => { if (event.type === 'indiedeck:security-state') store.state.securityBusy = event.detail.busy; },
  };
  try {
    store = await import('../../desktop/renderer/store.js');
    const { applyCatalog } = await import('../../desktop/renderer/i18n.js');
    applyCatalog({ catalog: {
      'ui.security.launchScanEnabled': 'LAUNCH_SCAN_ON', 'ui.security.launchScanDisabled': 'LAUNCH_SCAN_OFF',
      'ui.security.gateHelp': 'ALL_SCANS_REQUIRED', 'ui.security.launchScanSaveFailed': 'SAVE_FAILED',
    } });
    store.state.config = await loadConfig(fixture);
    const { renderSecuritySettings } = await import('../../desktop/renderer/panels/security.js');
    const { renderDiagnostics } = await import('../../desktop/renderer/panels/diagnostics.js');
    renderSecuritySettings();
    const toggle = () => settings.find((node) => node.className === 'security-launch-scan-toggle')!;
    assert.equal(toggle().checked, true);
    assert.match(settings.text(), /LAUNCH_SCAN_ON/);
    assert.match(settings.text(), /ALL_SCANS_REQUIRED/);

    toggle().checked = false; toggle().listeners.change();
    await until(() => !!release);
    assert.equal(toggle().disabled, true, 'save blocks repeated changes');
    release!(); release = undefined;
    await until(() => store.state.config.scanOnLaunch === false && !store.state.securityBusy);
    assert.equal((await loadConfig(fixture)).scanOnLaunch, false);
    assert.equal(toggle().checked, false);
    assert.match(settings.text(), /LAUNCH_SCAN_OFF/);
    assert.doesNotMatch(settings.text(), /ALL_SCANS_REQUIRED/);
    let scans = 0;
    await scanLaunchTarget((await loadConfig(fixture)).scanOnLaunch, async () => { scans += 1; });
    assert.equal(scans, 0);

    toggle().checked = true; toggle().listeners.change();
    await until(() => !!release); release!(); release = undefined;
    await until(() => store.state.config.scanOnLaunch === true && !store.state.securityBusy);
    assert.equal((await loadConfig(fixture)).scanOnLaunch, true);
    assert.equal(toggle().checked, true);
    await scanLaunchTarget((await loadConfig(fixture)).scanOnLaunch, async () => { scans += 1; });
    assert.equal(scans, 1);
    rejectNext = true; toggle().checked = false; toggle().listeners.change();
    await until(() => !!release); release!(); release = undefined;
    await until(() => !store.state.securityBusy);
    assert.equal(saveCalls, 3);
    assert.equal(toggle().checked, true, 'failed saves restore the persisted value');
    assert.equal((await loadConfig(fixture)).scanOnLaunch, true);
    assert.equal(status.textContent, 'SAVE_FAILED');

    const gameId = '0123456789abcdef';
    const context = { profile: { id: gameId, executable: 'Synthetic.exe' }, launchDiagnostic: null };
    store.state.detail = context;
    renderDiagnostics(panel as any, context);
    assert.ok(diagnosticListener);
    diagnosticListener!({ gameId: 'fedcba9876543210', result: { kind: 'spawn-failed' } });
    assert.equal(context.launchDiagnostic, null, 'another game cannot change this card');
    diagnosticListener!({ gameId, result: { kind: 'nonzero-exit', code: 7 } });
    assert.match(panel.text(), /exited with code 7/);
    assert.match(panel.text(), /do not establish a crash or cause/);
    diagnosticListener!({ gameId, result: { kind: 'nonzero-exit', code: 'private-data' } });
    assert.match(panel.text(), /exited with code 7/, 'malformed values are ignored');
    diagnosticListener!({ gameId, result: { kind: 'spawn-failed' } });
    assert.match(panel.text(), /could not start/);
    diagnosticListener!({ gameId, result: null });
    assert.match(panel.text(), /No launch problem recorded/);
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).CustomEvent;
    assert.equal(path.dirname(fixture), base);
    assert.ok(path.basename(fixture).startsWith('launch-scan-ui-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { exportBrowserCompanion } from '../../desktop/src/browser-companion-export.ts';

const parent = path.resolve(os.tmpdir()), temporary = fs.mkdtempSync(path.join(parent, 'indiedeck-companion-export-'));
after(() => { assert.equal(path.dirname(temporary), parent); assert.ok(path.basename(temporary).startsWith('indiedeck-companion-export-')); fs.rmSync(temporary, { recursive: true, force: true }); });
const project = path.resolve(import.meta.dirname, '../../..');
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;

test('bundled companion exports both browser manifests, verifies repeats and preserves edits', async () => {
  const data = path.join(temporary, 'state');
  const exported = await exportBrowserCompanion(project, data, version);
  assert.equal(exported, path.join(data, 'browser-companion', 'current'));
  const chromium = JSON.parse(fs.readFileSync(path.join(exported, 'chromium', 'manifest.json'), 'utf8'));
  const firefox = JSON.parse(fs.readFileSync(path.join(exported, 'firefox', 'manifest.json'), 'utf8'));
  assert.deepEqual(chromium.permissions, ['activeTab', 'scripting', 'storage']); assert.deepEqual(firefox.permissions, ['activeTab', 'scripting', 'storage']);
  assert.equal(chromium.version, firefox.version);
  const marker = JSON.parse(fs.readFileSync(path.join(exported, '.indiedeck-companion.json'), 'utf8'));
  assert.equal(marker.schemaVersion, 2); assert.equal(marker.extensionVersion, chromium.version);
  assert.equal(marker.launcherVersion, version);
  assert.equal(fs.existsSync(path.join(exported, 'chromium', 'artwork.js')), true);
  assert.equal(fs.existsSync(path.join(exported, 'firefox', 'artwork.js')), true);
  assert.equal(await exportBrowserCompanion(project, data, version), exported);
  const modified = path.join(exported, 'chromium', 'popup.js');
  fs.writeFileSync(modified, 'user local edit');
  await assert.rejects(exportBrowserCompanion(project, data, version), /companionExportFailed/);
  assert.equal(fs.readFileSync(modified, 'utf8'), 'user local edit');
});

const common = ['store-link.js', 'artwork.js', 'popup-controller.js', 'popup.js', 'popup.html', 'popup.css',
  'browser-api.js', 'auto-panel-settings.js', 'background.js', 'panel-loader.js', 'page-panel.js'];
const optionalHosts = ['https://store.steampowered.com/*', 'https://store.epicgames.com/*', 'https://www.gog.com/*', 'https://gog.com/*',
  'https://*.itch.io/*', 'https://booth.pm/*', 'https://*.booth.pm/*', 'https://www.dlsite.com/*', 'https://dlsite.com/*'];
function bundle(name: string, extensionVersion = '0.2.0', label = 'first'): string {
  const app = path.join(temporary, name), directory = path.join(app, 'extensions', 'browser-companion');
  fs.mkdirSync(directory, { recursive: true });
  const base = { manifest_version: 3, name: 'Fixture companion', version: extensionVersion, permissions: ['activeTab', 'scripting', 'storage'],
    optional_host_permissions: optionalHosts, web_accessible_resources: [{
      resources: ['page-panel.js', 'popup-controller.js', 'store-link.js', 'artwork.js', 'auto-panel-settings.js', 'browser-api.js'], matches: optionalHosts,
    }] };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ ...base, background: { service_worker: 'background.js', type: 'module' } }));
  fs.writeFileSync(path.join(directory, 'manifest.firefox.json'), JSON.stringify({ ...base, background: { scripts: ['background.js'], type: 'module' } }));
  for (const file of [...common, 'README.md']) fs.writeFileSync(path.join(directory, file), `${label}: ${file}\n`);
  return app;
}
function data(name: string) { return path.join(temporary, `data-${name}`); }
function popup(current: string) { return path.join(current, 'chromium', 'popup.js'); }

test('launcher releases retain one stable browser path and do not rewrite an unchanged independent extension', async () => {
  const app = bundle('same-source'), home = data('same');
  const current = await exportBrowserCompanion(app, home, '0.1.20');
  assert.equal(JSON.parse(fs.readFileSync(path.join(current, 'chromium', 'manifest.json'), 'utf8')).version, '0.2.0');
  const markerPath = path.join(current, '.indiedeck-companion.json'), before = fs.readFileSync(markerPath), stamp = fs.statSync(markerPath);
  assert.equal(await exportBrowserCompanion(app, home, '0.1.21'), current);
  assert.deepEqual(fs.readFileSync(markerPath), before);
  assert.equal(fs.statSync(markerPath).mtimeMs, stamp.mtimeMs);
  assert.equal(fs.statSync(markerPath).ino, stamp.ino);
});

test('invalid or broadened bundled manifest policies fail before creating user data', async () => {
  const variants = [
    { permissions: ['activeTab', 'scripting', 'storage', 'tabs'] },
    { host_permissions: ['<all_urls>'] },
    { optional_host_permissions: ['https://*/*'] },
    { content_scripts: [{ matches: ['<all_urls>'], js: ['page-panel.js'] }] },
    { externally_connectable: { matches: ['https://*/*'] } },
    { web_accessible_resources: [{ resources: ['*'], matches: optionalHosts }] },
    { background: { service_worker: 'unknown.js', type: 'module' } },
    { version: '99999.2.0' }, { version: '00.2.0' },
  ];
  for (let at = 0; at < variants.length; at += 1) {
    const app = bundle(`policy-${at}`), file = path.join(app, 'extensions', 'browser-companion', 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...variants[at] }));
    const home = data(`policy-${at}`);
    await assert.rejects(exportBrowserCompanion(app, home, '0.1.20'), /companionExportFailed/);
    assert.equal(fs.existsSync(home), false);
  }
});

test('a verified extension update refreshes the stable path and preserves old versioned exports', async () => {
  const first = bundle('update-old'), next = bundle('update-new', '0.2.1', 'second'), home = data('update');
  const current = await exportBrowserCompanion(first, home, '0.1.20');
  const legacy = path.join(home, 'browser-companion', '0.1.19'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'user-copy'), 'preserve');
  assert.equal(await exportBrowserCompanion(next, home, '0.1.21'), current);
  assert.match(fs.readFileSync(popup(current), 'utf8'), /^second:/);
  assert.equal(fs.readFileSync(path.join(legacy, 'user-copy'), 'utf8'), 'preserve');
  assert.deepEqual(fs.readdirSync(path.dirname(current)).sort(), ['0.1.19', 'current']);
  await assert.rejects(exportBrowserCompanion(first, home, '0.1.22'), /companionExportFailed/);
  assert.match(fs.readFileSync(popup(current), 'utf8'), /^second:/, 'an older bundled extension cannot downgrade current');
});

test('foreign files, changed owned files and hardlinks block replacement without deleting data', async () => {
  const first = bundle('unsafe-old'), next = bundle('unsafe-new', '0.2.1', 'second');
  for (const kind of ['extra', 'edit', 'hardlink']) {
    const current = await exportBrowserCompanion(first, data(kind), '0.1.20');
    let outside: string | undefined;
    if (kind === 'extra') fs.writeFileSync(path.join(current, 'notes.txt'), 'user notes');
    if (kind === 'edit') fs.writeFileSync(popup(current), 'user local edit');
    if (kind === 'hardlink') {
      outside = path.join(temporary, 'hardlink-target'); fs.writeFileSync(outside, fs.readFileSync(popup(current)));
      fs.unlinkSync(popup(current)); fs.linkSync(outside, popup(current));
    }
    const before = fs.readFileSync(popup(current));
    await assert.rejects(exportBrowserCompanion(next, data(kind), '0.1.21'), /companionExportFailed/);
    assert.deepEqual(fs.readFileSync(popup(current)), before);
    if (kind === 'extra') assert.equal(fs.readFileSync(path.join(current, 'notes.txt'), 'utf8'), 'user notes');
    if (outside) assert.deepEqual(fs.readFileSync(outside), before);
  }
});

test('failed directory publication rolls back the previous complete extension', async () => {
  const first = bundle('rollback-old'), next = bundle('rollback-new', '0.2.1', 'second'), home = data('rollback');
  const current = await exportBrowserCompanion(first, home, '0.1.20'), old = fs.readFileSync(popup(current));
  const rename = fsp.rename; let blocked = false;
  fsp.rename = async (from, to) => {
    if (!blocked && String(to) === current && path.basename(String(from)).startsWith('.staging-')) { blocked = true; throw new Error('synthetic publication failure'); }
    return rename(from, to);
  };
  try { await assert.rejects(exportBrowserCompanion(next, home, '0.1.21'), /companionExportFailed/); }
  finally { fsp.rename = rename; }
  assert.equal(blocked, true); assert.deepEqual(fs.readFileSync(popup(current)), old);
  assert.deepEqual(fs.readdirSync(path.dirname(current)), ['current']);
  assert.equal(await exportBrowserCompanion(next, home, '0.1.21'), current);
  assert.match(fs.readFileSync(popup(current), 'utf8'), /^second:/);
});

test('an interrupted rename journal restores the old tree before the next export', async () => {
  const first = bundle('recovery-old'), next = bundle('recovery-new', '0.2.1', 'second'), home = data('recovery');
  const current = await exportBrowserCompanion(first, home, '0.1.20'), old = fs.readFileSync(popup(current));
  const rename = fsp.rename;
  fsp.rename = async (from, to) => { if (String(to) === current) throw new Error('synthetic locked target'); return rename(from, to); };
  try { await assert.rejects(exportBrowserCompanion(next, home, '0.1.21'), /companionExportFailed/); }
  finally { fsp.rename = rename; }
  assert.equal(fs.existsSync(current), false); assert.equal(fs.existsSync(path.join(path.dirname(current), '.indiedeck-companion-update.json')), true);
  assert.equal(await exportBrowserCompanion(first, home, '0.1.21'), current);
  assert.deepEqual(fs.readFileSync(popup(current)), old);
  assert.deepEqual(fs.readdirSync(path.dirname(current)), ['current']);
});

test('partial cleanup resumes from its verified journal without touching unrelated files', async () => {
  const first = bundle('cleanup-old'), next = bundle('cleanup-new', '0.2.1', 'second'), home = data('cleanup');
  const current = await exportBrowserCompanion(first, home, '0.1.20'), unlink = fsp.unlink;
  fsp.unlink = async file => {
    if (String(file).includes(`${path.sep}.backup-`) && path.basename(String(file)) === 'popup.js') throw new Error('synthetic backup lock');
    return unlink(file);
  };
  try { await assert.rejects(exportBrowserCompanion(next, home, '0.1.21'), /companionExportFailed/); }
  finally { fsp.unlink = unlink; }
  assert.match(fs.readFileSync(popup(current), 'utf8'), /^second:/);
  assert.equal(fs.existsSync(path.join(path.dirname(current), '.indiedeck-companion-update.json')), true);
  assert.equal(await exportBrowserCompanion(next, home, '0.1.21'), current);
  assert.deepEqual(fs.readdirSync(path.dirname(current)), ['current']);
});

test('corrupt ownership or traversal journals preserve current and outside files', async () => {
  const app = bundle('journal-source'), home = data('journal'), current = await exportBrowserCompanion(app, home, '0.1.20');
  const file = path.join(path.dirname(current), '.indiedeck-companion-update.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, stage: '../outside', backup: null, previous: null, next: {} }));
  const before = fs.readFileSync(popup(current));
  await assert.rejects(exportBrowserCompanion(app, home, '0.1.21'), /companionExportFailed/);
  assert.deepEqual(fs.readFileSync(popup(current)), before); assert.equal(fs.existsSync(file), true);
});

test('concurrent exports serialize and retain the newer extension at the same path', async () => {
  const first = bundle('concurrent-old'), next = bundle('concurrent-new', '0.2.1', 'second'), home = data('concurrent');
  const [a, b] = await Promise.all([exportBrowserCompanion(first, home, '0.1.20'), exportBrowserCompanion(next, home, '0.1.21')]);
  assert.equal(a, b); assert.match(fs.readFileSync(popup(a), 'utf8'), /^second:/);
  assert.deepEqual(fs.readdirSync(path.dirname(a)), ['current']);
});

test('companion export refuses unsafe version names and linked destinations', async (context) => {
  const data = path.join(temporary, 'linked-state'), outside = path.join(temporary, 'outside');
  await assert.rejects(exportBrowserCompanion(project, data, '../outside'), /companionExportFailed/);
  fs.mkdirSync(data); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'preserve');
  try { fs.symlinkSync(outside, path.join(data, 'browser-companion'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { context.skip('Local directory link privilege unavailable'); return; }
  await assert.rejects(exportBrowserCompanion(project, data, version), /companionExportFailed/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'preserve');
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
});

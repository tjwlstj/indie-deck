import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { exportBrowserCompanion } from '../../desktop/src/browser-companion-export.ts';

const parent = path.resolve(os.tmpdir()), temporary = fs.mkdtempSync(path.join(parent, 'indiedeck-companion-export-'));
after(() => { assert.equal(path.dirname(temporary), parent); fs.rmSync(temporary, { recursive: true, force: true }); });
const project = path.resolve(import.meta.dirname, '../../..');
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;

test('bundled companion exports both browser manifests, verifies repeats and preserves edits', async () => {
  const data = path.join(temporary, 'state');
  const exported = await exportBrowserCompanion(project, data, version);
  assert.equal(exported, path.join(data, 'browser-companion', version));
  const chromium = JSON.parse(fs.readFileSync(path.join(exported, 'chromium', 'manifest.json'), 'utf8'));
  const firefox = JSON.parse(fs.readFileSync(path.join(exported, 'firefox', 'manifest.json'), 'utf8'));
  assert.deepEqual(chromium.permissions, ['activeTab']); assert.deepEqual(firefox.permissions, ['activeTab']);
  assert.equal(await exportBrowserCompanion(project, data, version), exported);
  const modified = path.join(exported, 'chromium', 'popup.js');
  fs.writeFileSync(modified, 'user local edit');
  await assert.rejects(exportBrowserCompanion(project, data, version), /companionExportFailed/);
  assert.equal(fs.readFileSync(modified, 'utf8'), 'user local edit');
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function bridge() {
  let api: any;
  const calls: unknown[][] = [];
  const nativeFile = {};
  const source = fs.readFileSync(new URL('../../desktop/preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, { require: () => ({
    contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { api = value; } },
    ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true, data: { accepted: true } }; } },
    webUtils: { getPathForFile: (file: unknown) => file === nativeFile ? 'C:\\fixtures\\selected.png' : '' },
  }) });
  return { api, calls, nativeFile };
}

test('file import methods resolve a native File in preload without returning its path', async () => {
  const { api, calls, nativeFile } = bridge();
  const value = await api.game.importThumbnail('0123456789abcdef', nativeFile);
  assert.deepEqual(calls[0], ['game:importThumbnail', '0123456789abcdef', 'C:\\fixtures\\selected.png']);
  assert.equal(JSON.stringify(value).includes('fixtures'), false);
  await api.stores.importFile(nativeFile);
  assert.equal(calls[1]?.[0], 'stores:importFile');
});

test('raw paths, forged File-like objects and synthetic files cannot invoke import IPC', async () => {
  const { api, calls } = bridge();
  for (const value of ['C:\\private\\file.png', { path: 'C:\\private\\file.png' }, null]) {
    await assert.rejects(api.game.importThumbnail('0123456789abcdef', value), /ui.thumbnail.importFailed/);
    await assert.rejects(api.stores.importFile(value), /ui.stores.error.linkFileInvalid/);
  }
  assert.equal(calls.length, 0);
});

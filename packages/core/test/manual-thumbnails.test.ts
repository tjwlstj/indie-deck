import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { importManualThumbnail, readManualThumbnail, clearManualThumbnail } from '../../desktop/src/manual-thumbnails.ts';

const parent = path.resolve(os.tmpdir()), fixture = fs.mkdtempSync(path.join(parent, 'indiedeck-manual-cover-'));
after(() => {
  assert.equal(path.dirname(fixture), parent);
  assert.ok(path.basename(fixture).startsWith('indiedeck-manual-cover-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});
const game = '0123456789abcdef', other = 'fedcba9876543210';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=', 'base64');
function directory(name: string) { const file = path.join(fixture, name); fs.mkdirSync(file, { recursive: true }); return file; }

test('manual image persists as a private launcher-owned copy and source edits/deletion cannot change it', async () => {
  const sourceDir = directory('game'), data = path.join(fixture, 'data'), source = path.join(sourceDir, 'arbitrary filename.png');
  await fsp.writeFile(source, png);
  const selected = await importManualThumbnail(data, game, source);
  assert.equal(selected.source, 'manual');
  assert.equal(selected.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(await fsp.readdir(sourceDir), ['arbitrary filename.png']);
  assert.deepEqual(await fsp.readFile(source), png);
  const stored = path.join(data, 'manual-thumbnails', `${game}.image`);
  assert.deepEqual(await fsp.readFile(stored), png);
  assert.equal((await fsp.stat(stored)).nlink, 1);
  if (process.platform !== 'win32') assert.equal((await fsp.stat(stored)).mode & 0o777, 0o600);
  await fsp.unlink(source);
  assert.deepEqual(await readManualThumbnail(data, game), selected);
  assert.equal(await readManualThumbnail(data, other), null);
  await clearManualThumbnail(data, game);
  assert.equal(await readManualThumbnail(data, game), null);
  assert.deepEqual(await fsp.readdir(path.join(data, 'manual-thumbnails')), []);
});

test('rejected images preserve the prior selection and create no temporary files', async () => {
  const files = directory('validation'), data = path.join(fixture, 'validation-data'), valid = path.join(files, 'valid.webp');
  await fsp.writeFile(valid, png); // Bytes determine type, not the chosen extension.
  const saved = await importManualThumbnail(data, game, valid);
  const giant = Buffer.from(png); giant.writeUInt32BE(9000, 16);
  const cases = [Buffer.alloc(0), Buffer.from('<svg onload="evil()"/>'), Buffer.from('<html>not an image</html>'), giant, Buffer.alloc(2 * 1024 * 1024 + 1)];
  for (let i = 0; i < cases.length; i++) {
    const file = path.join(files, `${i}.png`); await fsp.writeFile(file, cases[i]!);
    await assert.rejects(importManualThumbnail(data, game, file));
    assert.deepEqual(await readManualThumbnail(data, game), saved);
  }
  await assert.rejects(importManualThumbnail(data, game, files));
  assert.deepEqual(await fsp.readdir(path.join(data, 'manual-thumbnails')), [`${game}.image`]);
});

test('opaque IDs cannot escape the manual store and invalid paths do not create storage', async () => {
  const data = path.join(fixture, 'invalid-target');
  for (const bad of ['../outside', game.toUpperCase(), '', `${game}/../x`]) {
    assert.throws(() => importManualThumbnail(data, bad, path.join(fixture, 'missing.png')), /Invalid manual thumbnail target/);
    await assert.rejects(readManualThumbnail(data, bad), /Invalid manual thumbnail target/);
    assert.throws(() => clearManualThumbnail(data, bad), /Invalid manual thumbnail target/);
  }
  await assert.rejects(importManualThumbnail(data, game, 'relative.png'));
  await assert.rejects(fsp.stat(data), { code: 'ENOENT' });
});

test('concurrent replacement and reset are ordered and never leave a partial saved image', async () => {
  const files = directory('concurrent'), data = path.join(fixture, 'concurrent-data'), source = path.join(files, 'source.png');
  await fsp.writeFile(source, png);
  await Promise.all([importManualThumbnail(data, game, source), clearManualThumbnail(data, game)]);
  assert.equal(await readManualThumbnail(data, game), null);
  await Promise.all([clearManualThumbnail(data, game), importManualThumbnail(data, game, source)]);
  assert.equal((await readManualThumbnail(data, game))?.source, 'manual');
  assert.deepEqual(await fsp.readdir(path.join(data, 'manual-thumbnails')), [`${game}.image`]);
});

test('linked source files are rejected without changing the linked target', async (context) => {
  const files = directory('linked'), source = path.join(files, 'source.png'), linked = path.join(files, 'linked.png');
  await fsp.writeFile(source, png);
  try { await fsp.symlink(source, linked, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip('host does not allow file symlinks'); return; } throw error; }
  await assert.rejects(importManualThumbnail(path.join(fixture, 'linked-data'), game, linked));
  assert.deepEqual(await fsp.readFile(source), png);
});

test('linked storage directories are rejected before writing or deleting outside the launcher store', async () => {
  const source = path.join(directory('directory-source'), 'source.png'); await fsp.writeFile(source, png);
  const data = directory('linked-store-data'), outside = directory('outside-store');
  await fsp.symlink(outside, path.join(data, 'manual-thumbnails'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(importManualThumbnail(data, game, source));
  assert.equal(await readManualThumbnail(data, game), null);
  await assert.rejects(clearManualThumbnail(data, game));
  assert.deepEqual(await fsp.readdir(outside), []);
  assert.deepEqual(await fsp.readFile(source), png);
});

test('linked stored files and hard links cannot redirect reset or replacement into other files', async () => {
  const files = directory('hardlink'), data = directory('hardlink-data'), store = directory('hardlink-data/manual-thumbnails');
  const source = path.join(files, 'source.png'), target = path.join(store, `${game}.image`);
  await fsp.writeFile(source, png); await fsp.link(source, target);
  assert.equal(await readManualThumbnail(data, game), null);
  await assert.rejects(clearManualThumbnail(data, game));
  await assert.rejects(importManualThumbnail(data, game, source));
  assert.deepEqual(await fsp.readFile(source), png);
  assert.deepEqual(await fsp.readFile(target), png);
});

test('corrupt saved images fall back without deletion and explicit replacement can recover them', async () => {
  const data = directory('corrupt-data'), store = directory('corrupt-data/manual-thumbnails'), target = path.join(store, `${game}.image`);
  const source = path.join(directory('replacement'), 'valid.png'); await fsp.writeFile(source, png);
  await fsp.writeFile(target, 'corrupt');
  assert.equal(await readManualThumbnail(data, game), null);
  assert.equal(await fsp.readFile(target, 'utf8'), 'corrupt');
  await importManualThumbnail(data, game, source);
  assert.equal((await readManualThumbnail(data, game))?.source, 'manual');
});

test('a source replaced after path inspection cannot publish a different file or lose the previous image', async () => {
  const files = directory('raced-source'), data = path.join(fixture, 'raced-data'), source = path.join(files, 'source.png');
  await fsp.writeFile(source, png);
  const saved = await importManualThumbnail(data, game, source);
  const originalOpen = fsp.open;
  let replaced = false;
  fsp.open = async (file, flags, mode) => {
    if (file === source && !replaced) {
      replaced = true;
      await fsp.rename(source, path.join(files, 'original.png'));
      const different = Buffer.from(png); different.writeUInt32BE(2, 16);
      await fsp.writeFile(source, different);
    }
    return originalOpen(file, flags, mode);
  };
  try { await assert.rejects(importManualThumbnail(data, game, source), /changed while reading/); }
  finally { fsp.open = originalOpen; }
  assert.equal(replaced, true);
  assert.deepEqual(await readManualThumbnail(data, game), saved);
  assert.deepEqual(await fsp.readdir(path.join(data, 'manual-thumbnails')), [`${game}.image`]);
});

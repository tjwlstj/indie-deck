import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, mock, test } from 'node:test';
import { extract7z, find7zExtractor, findExtractedEntry } from '../src/install/sevenzip.ts';

const parent = path.resolve(os.tmpdir());
const temporary = await fs.mkdtemp(path.join(parent, 'indiedeck-sevenzip-security-'));
after(async () => {
  assert.equal(path.dirname(path.resolve(temporary)), parent);
  await fs.rm(temporary, { recursive: true, force: true });
});
const entry = 'arialuni_sdf_u2021', payload = Buffer.from('ordinary selected font bytes');
const systemExtractor = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : '/usr/bin/bsdtar';
type Call = { executable: string; args: string[]; options: childProcess.SpawnOptions };
async function fixture(name: string) {
  const cache = path.join(temporary, name);
  await fs.mkdir(cache);
  const archive = path.join(cache, 'font.7z'); await fs.writeFile(archive, 'synthetic archive ' + name);
  return { cache, archive };
}
async function withExtractor<T>(settings: {
  list?: string | Buffer; bytes?: Buffer; onExtract?: () => Promise<void>; fail?: boolean;
}, work: (calls: Call[]) => Promise<T>): Promise<T> {
  const original = fs.lstat, sample = await fs.stat(process.execPath);
  const trusted = Object.assign(Object.create(Object.getPrototypeOf(sample)), sample, { uid: 0, mode: 0o100755 });
  const statMock = mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) =>
    String(args[0]) === systemExtractor ? trusted : original(...args));
  const calls: Call[] = [];
  const spawnMock = mock.method(childProcess, 'spawn', (command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, systemExtractor);
    calls.push({ executable: command, args: [...args], options });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.stdout.destroy(); child.stderr.destroy(); return true; };
    queueMicrotask(() => {
      void (async () => {
        if (args[0] === '--version') child.stdout.end('bsdtar 3.8.9 - libarchive 3.8.9');
        else if (args[0] === '-tf') child.stdout.end(settings.list ?? './\n./' + entry + '\n./unrelated.txt\n');
        else if (args[0] === '-xOf') {
          await settings.onExtract?.();
          if (settings.fail) child.stderr.end('SyntheticPrivate archive diagnostic');
          child.stdout.end(settings.bytes ?? payload);
        } else throw new Error('Unexpected extractor fixture arguments.');
        child.stderr.end(); child.emit('close', settings.fail && args[0] === '-xOf' ? 2 : 0);
      })().catch((error) => child.emit('error', error));
    });
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  });
  try { return await work(calls); }
  finally { spawnMock.mock.restore(); statMock.mock.restore(); }
}
test('one explicit font entry is sent to stdout through a fixed protected extractor with a scrubbed environment', async () => {
  const data = await fixture('one-entry');
  await withExtractor({}, async (calls) => {
    const result = await extract7z(data.archive, data.cache, entry);
    const file = await findExtractedEntry(result.dir, entry);
    assert.ok(file); assert.deepEqual(await fs.readFile(file), payload);
    const extraction = calls.find((call) => call.args[0] === '-xOf');
    assert.deepEqual(extraction?.args, ['-xOf', data.archive, '--', './' + entry]);
    for (const call of calls) {
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.cwd, path.dirname(systemExtractor));
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'USERPROFILE']) assert.equal(key in (call.options.env ?? {}), false);
    }
    assert.deepEqual((await fs.readdir(result.dir)).sort(), ['.indiedeck-extracted.json', entry]);
  });
});
test('cache reuse requires a process-local seal and revalidates cached payload bytes', async () => {
  const data = await fixture('seal');
  await withExtractor({}, async (calls) => {
    const first = await extract7z(data.archive, data.cache, entry);
    const before = calls.length;
    const cached = await extract7z(data.archive, data.cache, entry);
    assert.equal(cached.fromCache, true); assert.equal(calls.length, before);
    await fs.writeFile(path.join(first.dir, entry), 'forged cached bytes');
    await fs.writeFile(path.join(first.dir, '.indiedeck-extracted.json'), JSON.stringify({ fileSha256: crypto.createHash('sha256').update('forged cached bytes').digest('hex') }));
    const repaired = await extract7z(data.archive, data.cache, entry);
    assert.equal(repaired.fromCache, false);
    assert.deepEqual(await fs.readFile(path.join(repaired.dir, entry)), payload);
    assert.equal(calls.filter((call) => call.args[0] === '-xOf').length, 2);
  });
});
test('a preseeded disk marker and payload never authorize cache reuse', async () => {
  const data = await fixture('disk-forgery');
  const digest = crypto.createHash('sha256').update(await fs.readFile(data.archive)).digest('hex');
  const key = crypto.createHash('sha256').update(digest + '\n' + entry).digest('hex').slice(0, 32);
  const directory = path.join(data.cache, 'extracted', key);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, entry), 'forged');
  await fs.writeFile(path.join(directory, '.indiedeck-extracted.json'), JSON.stringify({
    schemaVersion: 1, archiveSha256: digest, entry, fileSha256: crypto.createHash('sha256').update('forged').digest('hex'), bytes: 6, extractor: 'bsdtar',
  }));
  await withExtractor({}, async (calls) => {
    const result = await extract7z(data.archive, data.cache, entry);
    assert.equal(result.fromCache, false);
    assert.equal(calls.filter((call) => call.args[0] === '-xOf').length, 1);
    assert.deepEqual(await fs.readFile(path.join(result.dir, entry)), payload);
  });
});
test('unsafe or ambiguous archive names fail before any payload is decoded', async () => {
  const names = ['../outside', '/outside', 'C:/outside', 'dir\\outside', 'dir/../outside', 'dir/file*'];
  for (let index = 0; index < names.length; index += 1) {
    const data = await fixture('bad-name-' + index);
    await withExtractor({ list: entry + '\n' + names[index] + '\n' }, async (calls) => {
      await assert.rejects(() => extract7z(data.archive, data.cache, entry), /Unsafe archive/);
      assert.equal(calls.some((call) => call.args[0] === '-xOf'), false);
    });
  }
  const data = await fixture('ambiguous');
  await withExtractor({ list: 'a/' + entry + '\nb/' + entry + '\n' }, async (calls) => {
    await assert.rejects(() => extract7z(data.archive, data.cache, entry), /ambiguous/);
    assert.equal(calls.some((call) => call.args[0] === '-xOf'), false);
  });
});
test('an archive changed during native decoding cannot publish a font', async () => {
  const data = await fixture('changed-archive');
  await withExtractor({ onExtract: () => fs.writeFile(data.archive, 'changed archive bytes') }, async () => {
    await assert.rejects(() => extract7z(data.archive, data.cache, entry), /changed during extraction/);
    const directories = await fs.readdir(path.join(data.cache, 'extracted'));
    assert.equal(directories.length, 1);
    assert.deepEqual(await fs.readdir(path.join(data.cache, 'extracted', directories[0]!)), []);
  });
});
test('entry selection is mandatory and cache file links cannot become font sources', async () => {
  const data = await fixture('links');
  await assert.rejects(() => extract7z(data.archive, data.cache), /Select a safe/);
  await assert.rejects(() => extract7z(data.archive, data.cache, '../outside'), /Select a safe/);
  for (const name of ['COM¹.txt', 'LPT³.bin', 'CONIN$', 'CONOUT$']) {
    await assert.rejects(() => extract7z(data.archive, data.cache, name), /Select a safe/);
  }
  const outside = path.join(temporary, 'outside-font'); await fs.writeFile(outside, payload);
  const directory = path.join(data.cache, 'linked'); await fs.mkdir(directory);
  await fs.link(outside, path.join(directory, entry));
  await assert.rejects(() => findExtractedEntry(directory, entry), /Unsafe.*file/);
  assert.deepEqual(await fs.readFile(outside), payload);
  const link = path.join(data.cache, 'directory-link');
  await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => findExtractedEntry(link, entry), /Linked.*paths/);
});
test('archive listing excess and native diagnostics are bounded, and raw diagnostics are not surfaced', async () => {
  const data = await fixture('large-list');
  await withExtractor({ list: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61) }, async () => {
    await assert.rejects(() => extract7z(data.archive, data.cache, entry), /output limit/);
  });
  const failed = await fixture('failed-native');
  await withExtractor({ fail: true }, async () => {
    await assert.rejects(() => extract7z(failed.archive, failed.cache, entry), (error: Error) => {
      assert.doesNotMatch(error.message, /SyntheticPrivate/); return /extractor failed/.test(error.message);
    });
  });
});
test('the protected bsdtar path decodes a harmless real 7-Zip selection without extracting unrelated files', async (context) => {
  const extractor = await find7zExtractor();
  if (!extractor || extractor.kind !== 'bsdtar') { context.skip('A protected bsdtar is not installed on this host.'); return; }
  const data = await fixture('native');
  const source = path.join(data.cache, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, entry), payload); await fs.writeFile(path.join(source, 'unrelated.txt'), 'not selected');
  const created = childProcess.spawnSync(extractor.command, ['--format=7zip', '-cf', data.archive, '-C', source, '.'], {
    windowsHide: true, shell: false, timeout: 5000, stdio: 'pipe',
  });
  assert.equal(created.status, 0, 'The protected extractor could not create the harmless fixture.');
  const result = await extract7z(data.archive, data.cache, entry);
  assert.deepEqual(await fs.readFile(path.join(result.dir, entry)), payload);
  assert.deepEqual((await fs.readdir(result.dir)).sort(), ['.indiedeck-extracted.json', entry]);
});
test('the expected archive hash is checked before a native process and decoded hashes bind the returned file', async () => {
  const data = await fixture('expected-hash'), expected = crypto.createHash('sha256').update(await fs.readFile(data.archive)).digest('hex');
  await withExtractor({}, async (calls) => {
    await assert.rejects(() => extract7z(data.archive, data.cache, entry, '0'.repeat(64)), /checksum mismatch/);
    assert.equal(calls.length, 0);
    const result = await extract7z(data.archive, data.cache, entry, expected);
    assert.equal(result.sha256, crypto.createHash('sha256').update(payload).digest('hex')); assert.equal(result.bytes, payload.length);
    const reused = await extract7z(data.archive, data.cache, entry, expected);
    assert.equal(reused.fromCache, true); assert.equal(reused.sha256, result.sha256); assert.equal(reused.bytes, result.bytes);
  });
});

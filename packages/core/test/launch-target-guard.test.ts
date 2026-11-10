import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectLaunchDirectory, inspectLaunchTarget, revalidateLaunchTarget } from '../../desktop/src/launch-target-guard.ts';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'indiedeck-launch-target-'));
  const game = path.join(base, 'game'), binary = path.join(game, 'bin', 'Game.EXE');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, Buffer.from('MZ harmless non-runnable launch fixture'));
  return { base, game, binary, remove: () => fs.rm(base, { recursive: true, force: true }) };
}

test('a stable nested Windows executable is admitted before and after an asynchronous scan boundary', async () => {
  const f = await fixture();
  try {
    const target = await inspectLaunchTarget(f.game, 'bin\\Game.EXE');
    await inspectLaunchDirectory(f.game);
    assert.equal(target.cwd, f.game);
    assert.equal(target.executable, f.binary);
    await Promise.resolve();
    await revalidateLaunchTarget(target);
  } finally { await f.remove(); }
});

test('absolute, parent, non-exe, device and alternate-stream executable names fail before launch', async () => {
  const f = await fixture();
  try {
    for (const value of ['../outside.exe', '/outside.exe', 'C:\\outside.exe', 'bin/../Game.exe', 'bin//Game.exe',
      'bin/Game.cmd', 'bin/Game.exe:stream', 'bin/Game.exe.', 'bin/NUL.exe', 'bin/Game.exe\0', '\\\\server\\share\\Game.exe']) {
      await assert.rejects(inspectLaunchTarget(f.game, value), /^Error: ui\.gaming\.error\.unsafeLaunchTarget$/);
    }
    await assert.rejects(inspectLaunchTarget(f.game, 'bin/Missing.exe'), /^Error: ui\.gaming\.error\.unsafeLaunchTarget$/);
    await assert.rejects(inspectLaunchTarget(f.game, 'bin'), /^Error: ui\.gaming\.error\.unsafeLaunchTarget$/);
  } finally { await f.remove(); }
});

test('same-size executable replacement after scan admission is rejected', async () => {
  const f = await fixture();
  try {
    const admitted = await inspectLaunchTarget(f.game, 'bin/Game.EXE');
    const content = await fs.readFile(f.binary);
    await fs.rename(f.binary, `${f.binary}.old`);
    await fs.writeFile(f.binary, content);
    await assert.rejects(revalidateLaunchTarget(admitted), /^Error: ui\.gaming\.error\.launchTargetChanged$/);
  } finally { await f.remove(); }
});

test('an in-place executable edit or replaced parent directory invalidates admission', async () => {
  const f = await fixture();
  try {
    const admitted = await inspectLaunchTarget(f.game, 'bin/Game.EXE');
    const content = await fs.readFile(f.binary); content[3] ^= 1;
    await fs.writeFile(f.binary, content);
    const timestamp = new Date(admitted.file.mtimeMs + 1000);
    await fs.utimes(f.binary, timestamp, timestamp);
    await assert.rejects(revalidateLaunchTarget(admitted), /^Error: ui\.gaming\.error\.launchTargetChanged$/);
    const second = await inspectLaunchTarget(f.game, 'bin/Game.EXE');
    await fs.rename(path.dirname(f.binary), path.join(f.game, 'old-bin'));
    await fs.mkdir(path.dirname(f.binary)); await fs.writeFile(f.binary, content);
    await assert.rejects(revalidateLaunchTarget(second), /^Error: ui\.gaming\.error\.launchTargetChanged$/);
  } finally { await f.remove(); }
});

test('hard-linked executables and junction/symlink parent directories cannot be admitted', async () => {
  const f = await fixture();
  try {
    await fs.link(f.binary, path.join(f.game, 'Linked.exe'));
    await assert.rejects(inspectLaunchTarget(f.game, 'Linked.exe'), /unsafeLaunchTarget/);
    await fs.unlink(path.join(f.game, 'Linked.exe'));
    const alias = path.join(f.base, 'game-alias');
    await fs.symlink(f.game, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectLaunchDirectory(alias), /unsafeLaunchTarget/);
    await assert.rejects(inspectLaunchTarget(alias, 'bin/Game.EXE'), /unsafeLaunchTarget/);
    const nestedAlias = path.join(f.game, 'alias');
    await fs.symlink(path.dirname(f.binary), nestedAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectLaunchTarget(f.game, 'alias/Game.EXE'), /unsafeLaunchTarget/);
  } finally { await f.remove(); }
});

test('a file symlink is rejected when the host permits creating it', async (t) => {
  const f = await fixture();
  try {
    const alias = path.join(f.game, 'Alias.exe');
    try { await fs.symlink(f.binary, alias, 'file'); }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('host does not permit file symlinks'); return; } throw error; }
    await assert.rejects(inspectLaunchTarget(f.game, 'Alias.exe'), /unsafeLaunchTarget/);
  } finally { await f.remove(); }
});

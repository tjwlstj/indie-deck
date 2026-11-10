import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseGamingEntryArgs, quoteWindowsArgument, gamingRegistration, gamingSettingsUrl, exportGamingShortcut } from '../../desktop/src/gaming-entry.ts';

const exe = 'C:\\Program Files\\IndieDeck\\IndieDeck.exe';
const context = { packaged: true, executable: exe };
const id = '0123456789abcdef';

test('packaged and development entries accept only the launcher fullscreen/game-id contract', () => {
  assert.deepEqual(parseGamingEntryArgs([exe], context), { valid: true, fullscreen: false });
  assert.deepEqual(parseGamingEntryArgs([exe, '--launch-game', id, '--fullscreen'], context), { valid: true, fullscreen: true, launchGameId: id });
  assert.equal(parseGamingEntryArgs([exe, '--fullscreen', '--launch-game', id], context).launchGameId, id);
  assert.deepEqual(parseGamingEntryArgs([exe, '--updated'], context), { valid: true, fullscreen: false });
  assert.deepEqual(parseGamingEntryArgs([exe, '--updated', '--fullscreen'], context), { valid: true, fullscreen: true });
  const electron = path.resolve('fixtures/electron'), app = path.resolve('fixtures/app');
  assert.deepEqual(parseGamingEntryArgs([electron, app, '--fullscreen'], { packaged: false, executable: electron, appPath: app }), { valid: true, fullscreen: true });
  assert.equal(parseGamingEntryArgs([electron, '--fullscreen'], { packaged: false, executable: electron, appPath: app }).valid, false);
});

test('unknown switches, injected paths, duplicate arguments and malformed ids never authorize a launch', () => {
  for (const args of [ ['--launch-game'], ['--launch-game', '../game.exe'], ['--launch-game', id, 'extra'],
    ['--fullscreen', '--fullscreen'], ['--launch-game', id, '--launch-game', id], ['--remote-debugging-port=9222'],
    ['--launch-game', '0123456789ABCDEF'], ['--launch-game', id + '\n'], ['https://evil.invalid/game'], ['--', '--fullscreen'], ['--updated', '--updated'] ]) {
    const parsed = parseGamingEntryArgs([exe, ...args], context);
    assert.equal(parsed.valid, false); assert.equal(parsed.launchGameId, undefined); assert.equal(parsed.fullscreen, false);
  }
  assert.equal(parseGamingEntryArgs(['C:\\other.exe', '--launch-game', id], context).valid, false);
});

test('registration keeps the executable separate from a quoted fixed argument list', () => {
  const registration = gamingRegistration(exe, id);
  assert.equal(registration.executable, exe);
  assert.equal(registration.argumentLine, `--fullscreen --launch-game ${id}`);
  assert.equal(registration.shortcutName, `IndieDeck-${id}.lnk`);
  assert.equal(quoteWindowsArgument('C:\\folder with spaces\\'), '"C:\\folder with spaces\\\\"');
  assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
  assert.throws(() => gamingRegistration('cmd.exe', id));
  assert.throws(() => gamingRegistration(exe, '../bad'));
  assert.throws(() => gamingSettingsUrl('ms-settings:anything'));
  assert.equal(gamingSettingsUrl('xboxMode'), 'ms-settings:gaming-fullscreen');
});

function fakeShell() {
  return {
    writeShortcutLink(file: string, _operation: 'create', info: unknown) {
      // The test has no Windows shell. Ordinary JSON fixture bytes retain the
      // exact target/argument contract for publication and collision checks.
      fsSync.writeFileSync(file, JSON.stringify(info), { flag: 'wx' }); return true;
    },
    readShortcutLink(file: string) { return JSON.parse(fsSync.readFileSync(file, 'utf8')); },
  };
}

test('export creates one ordinary shortcut without overwriting an existing or raced foreign file', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'indiedeck-shortcut-'));
  try {
    const registration = gamingRegistration(exe, id), shell = fakeShell();
    const output = await exportGamingShortcut(folder, registration, shell);
    assert.equal(output.path, path.join(folder, registration.shortcutName));
    const first = await fs.readFile(output.path, 'utf8');
    await assert.rejects(exportGamingShortcut(folder, registration, shell), /already exists/);
    assert.equal(await fs.readFile(output.path, 'utf8'), first);
    const other = gamingRegistration(exe);
    const racedShell = { ...shell, readShortcutLink(file: string) {
      fsSync.writeFileSync(path.join(folder, other.shortcutName), 'foreign');
      return shell.readShortcutLink(file);
    } };
    await assert.rejects(exportGamingShortcut(folder, other, racedShell));
    assert.equal(await fs.readFile(path.join(folder, other.shortcutName), 'utf8'), 'foreign');
    assert.deepEqual((await fs.readdir(folder)).sort(), [registration.shortcutName, other.shortcutName].sort());
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('a failed shell write cleans a partial launcher-owned temporary link', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'indiedeck-shortcut-failed-'));
  try {
    const shell = { ...fakeShell(), writeShortcutLink(file: string) { fsSync.writeFileSync(file, 'partial'); return false; } };
    await assert.rejects(exportGamingShortcut(folder, gamingRegistration(exe), shell), /Could not create/);
    assert.deepEqual(await fs.readdir(folder), []);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

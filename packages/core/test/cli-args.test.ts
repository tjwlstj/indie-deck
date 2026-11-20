import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../cli/src/index.ts';
import { cleanupFixtures, fakeExe, fixtureRoot, makeGame } from './fixtures.ts';

after(cleanupFixtures);

const entry = fileURLToPath(new URL('../../cli/src/index.ts', import.meta.url));
const cliVersion = JSON.parse(fs.readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8')).version;

function runCli(...args: string[]) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', entry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, INDIEDECK_HOME: path.join(fixtureRoot(), 'home') },
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

function cli(...args: string[]): string {
  const result = runCli(...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('switches leave the command and its positional arguments in place', () => {
  assert.deepEqual(parseArgs(['--no-color', 'scan', '--deep', 'Game Library', '--depth', '3']), {
    command: 'scan', args: ['Game Library'], flags: { 'no-color': true, deep: true, depth: '3' },
  });
  assert.deepEqual(parseArgs(['install', '--dry-run', 'Game', '--dry-run']), {
    command: 'install', args: ['Game'], flags: { 'dry-run': true },
  });
});

test('value options keep separate and inline values, repeated sets and short switches', () => {
  assert.deepEqual(parseArgs(['--locale', 'ko', '-j', 'config', 'Game', '--set', 'a=1', '--set=b=2']), {
    command: 'config', args: ['Game'], flags: { locale: 'ko', json: true, set: ['a=1', 'b=2'] },
  });
});

test('stats emits the same JSON with the global switch before or after its command', () => {
  const stats = JSON.parse(cli('stats', '--json'));
  assert.equal(stats.total, 0);
  assert.deepEqual(JSON.parse(cli('--json', 'stats')), stats);
});

test('the global version switch returns the CLI version', () => {
  assert.equal(cli('--version'), cliVersion);
  assert.equal(cli('-v'), cliVersion);
  assert.equal(cli('uninstall', 'unopened-test-game', '--version=legacy'), cliVersion);
  assert.equal(cli('--version=legacy', 'install', 'unopened-test-game'), cliVersion);
});

test('explicit help succeeds before or after a command', () => {
  const help = cli('--help');
  assert.equal(cli('--help', 'stats'), help);
  assert.equal(cli('stats', '--help'), help);
  assert.equal(cli('install', '--version', '-h'), help);
});

test('global version takes precedence over a translator pin in either order', () => {
  for (const args of [
    ['-v', 'install', 'unopened-test-game', '--version=5.5.2'],
    ['install', 'unopened-test-game', '--version=5.5.2', '-v'],
    ['--version', 'plan', 'unopened-test-game', '--version=5.5.2'],
    ['install', '--version=', '-v'],
  ]) {
    assert.equal(cli(...args), cliVersion);
  }
  assert.deepEqual(parseArgs(['-v']), { command: '', args: [], flags: { version: true } });
  assert.equal(parseArgs(['-v', 'install', 'Game', '--version=5.5.2']).flags.version, '5.5.2');
});

test('missing or repeated translator versions fail before dispatch', () => {
  for (const args of [['--version', '--yes'], ['--version='], ['--version=5.5.2', '--version=5.6.1']]) {
    const result = runCli('--locale', 'en', 'install', 'unopened-test-game', ...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--version.*translator version/);
  }
  const korean = runCli('--locale', 'ko', 'plan', 'unopened-test-game', '--version');
  assert.equal(korean.status, 2);
  assert.match(korean.stderr, /--version.*번역기 버전/);
});

test('plan and install use the pinned translator version and a dry run writes no game files', () => {
  const game = makeGame('Pinned Game', {
    'Game.exe': fakeExe(0x8664),
    'UnityPlayer.dll': 'fixture',
    'Game_Data/Managed/Assembly-CSharp.dll': 'fixture',
  });
  const version = '5.5.2';
  const before = fs.readdirSync(game, { recursive: true }).sort();
  const planned = JSON.parse(cli('plan', game, '--version', version, '--json'));
  assert.equal(planned.options.version, version);
  assert.ok(planned.plans.length > 0);
  assert.ok(planned.plans.every((plan: { version: string }) => plan.version === version));
  const install = JSON.parse(cli('install', '--dry-run', game, '--version=' + version, '--json'));
  assert.equal(install.plan.version, version);
  assert.equal(install.result.receiptStatus, 'not-run');
  assert.deepEqual(install.result.filesWritten, []);
  assert.deepEqual(fs.readdirSync(game, { recursive: true }).sort(), before);
});

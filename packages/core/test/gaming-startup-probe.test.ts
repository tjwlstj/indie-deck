import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireHostedRunner, sanitizedLog, startupEnvironment } from '../../../scripts/check-gaming-startup.mjs';

const hosted = { GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_REPOSITORY: 'tjwlstj/indie-deck', INDIEDECK_GAMING_STARTUP_CI: '1', RUNNER_TEMP: 'C:\\runner\\temp' };
test('packaged startup probe refuses local, foreign, self-hosted and unsafe environments', () => {
  requireHostedRunner(hosted, 'win32', 'x64');
  for (const change of [{ GITHUB_ACTIONS: undefined }, { CI: undefined }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_REPOSITORY: 'other/repository' }, { INDIEDECK_GAMING_STARTUP_CI: undefined },
    { RUNNER_TEMP: 'relative' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) {
    assert.throws(() => requireHostedRunner({ ...hosted, ...change }, 'win32', 'x64'));
  }
  assert.throws(() => requireHostedRunner(hosted, 'linux', 'x64'));
  assert.throws(() => requireHostedRunner(hosted, 'win32', 'arm64'));
});

test('packaged probe child inherits only runtime essentials and isolated paths', () => {
  const clean = startupEnvironment({ PATH: 'runtime', SystemRoot: 'C:\\Windows', GH_TOKEN: 'credential',
    GITHUB_TOKEN: 'credential', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: 'unwanted',
    INDIEDECK_SMOKE_FLOW: '1', PORTABLE_EXECUTABLE_FILE: 'unwanted', OTHER_SECRET: 'credential' },
  'fixture', 'screenshot.png');
  assert.equal(clean.PATH, 'runtime'); assert.equal(clean.SystemRoot, 'C:\\Windows');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS',
    'INDIEDECK_SMOKE_FLOW', 'PORTABLE_EXECUTABLE_FILE', 'OTHER_SECRET']) assert.equal(key in clean, false);
  assert.equal(clean.INDIEDECK_SMOKE, '1'); assert.equal(clean.INDIEDECK_DISABLE_UPDATES, '1');
  assert.equal(clean.INDIEDECK_SCREENSHOT, 'screenshot.png');
  assert.ok(clean.INDIEDECK_HOME.startsWith('fixture')); assert.ok(clean.APPDATA.startsWith('fixture'));
});

test('captured startup output is bounded and redacts network credentials', () => {
  const text = sanitizedLog('x'.repeat(100000) + '\nhttps://example.invalid/file?signature=secret\n'
    + 'ghp_syntheticcredential\ntoken=synthetic\nAuthorization: Bearer synthetic\n');
  assert.ok(text.length <= 65536);
  for (const value of ['https://', 'signature=secret', 'ghp_syntheticcredential', 'token=synthetic', 'Bearer synthetic']) {
    assert.equal(text.includes(value), false);
  }
  assert.match(text, /redacted/);
});

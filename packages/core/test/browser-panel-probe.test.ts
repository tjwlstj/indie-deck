import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireBrowserPanelRunner } from '../../../scripts/check-browser-panel.mjs';
test('real browser probe refuses local, foreign and self-hosted execution before browser launch', () => {
  const safe = { GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'tjwlstj/indie-deck',
    INDIEDECK_BROWSER_PANEL_CI: '1', RUNNER_TEMP: '/tmp/runner' };
  requireBrowserPanelRunner(safe, 'linux', 'x64');
  for (const change of [{ GITHUB_ACTIONS: undefined }, { CI: undefined }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_REPOSITORY: 'other/repo' }, { INDIEDECK_BROWSER_PANEL_CI: undefined }, { RUNNER_TEMP: 'relative' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) assert.throws(() => requireBrowserPanelRunner({ ...safe, ...change }, 'linux', 'x64'));
  assert.throws(() => requireBrowserPanelRunner(safe, 'win32', 'x64'));
  assert.throws(() => requireBrowserPanelRunner(safe, 'linux', 'arm64'));
});

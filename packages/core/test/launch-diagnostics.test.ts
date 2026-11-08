import assert from 'node:assert/strict';
import test from 'node:test';
import { createLaunchDiagnostics } from '../../desktop/src/launch-diagnostics.ts';

test('launch diagnostics report only bounded evidence from the latest observed child', () => {
  const events: unknown[] = [];
  const diagnostics = createLaunchDiagnostics((game, result) => { events.push({ game, result }); });
  const first = diagnostics.begin('game');
  const second = diagnostics.begin('game');
  diagnostics.exited('game', first, 9);
  assert.equal(diagnostics.get('game'), null);
  diagnostics.exited('game', second, 3);
  assert.equal(diagnostics.get('game')?.kind, 'nonzero-exit');
  assert.deepEqual(Object.keys(diagnostics.get('game')!).sort(), ['at', 'code', 'kind']);
  const third = diagnostics.begin('game');
  diagnostics.exited('game', third, 0);
  assert.equal(diagnostics.get('game'), null);
  const fourth = diagnostics.begin('game');
  diagnostics.failed('game', fourth);
  assert.equal(diagnostics.get('game')?.kind, 'spawn-failed');
  assert.ok(events.length > 0);
});

test('old entries are evicted and observer failure cannot affect a launch', () => {
  const diagnostics = createLaunchDiagnostics(() => { throw new Error('observer'); });
  const stale = diagnostics.begin('stale');
  for (let index = 0; index < 100; index += 1) diagnostics.begin(`game-${index}`);
  diagnostics.failed('stale', stale);
  assert.equal(diagnostics.get('stale'), null);
  const token = diagnostics.begin('current');
  assert.doesNotThrow(() => diagnostics.failed('current', token));
  assert.equal(diagnostics.get('current')?.kind, 'spawn-failed');
});

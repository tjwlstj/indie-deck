import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnedGameSessions, shouldDeferBackgroundWork } from '../../desktop/src/owned-game-sessions.ts';

const game = '0123456789abcdef', other = 'fedcba9876543210';

test('reservation prevents duplicate launches and only successful spawn becomes running', () => {
  const sessions = createOwnedGameSessions({ now: () => new Date('2026-11-10T01:02:03.000Z') });
  const token = sessions.reserve(game);
  assert.deepEqual(sessions.snapshot(), { revision: 1, sessions: [{ gameId: game, status: 'starting' }] });
  assert.throws(() => sessions.reserve(game), /ui.gaming.error.alreadyRunning/);
  assert.equal(sessions.started(game, token), true);
  assert.equal(sessions.started(game, token), false);
  assert.deepEqual(sessions.snapshot().sessions, [{ gameId: game, status: 'running', startedAt: '2026-11-10T01:02:03.000Z' }]);
  assert.equal(sessions.finish(game, token), true);
  assert.equal(sessions.has(game), false);
});

test('scan/spawn failures release reservations and stale events cannot end a newer run', () => {
  const sessions = createOwnedGameSessions();
  const first = sessions.reserve(game);
  assert.equal(sessions.finish(game, first), true);
  const second = sessions.reserve(game);
  assert.notEqual(first, second);
  assert.equal(sessions.started(game, first), false);
  assert.equal(sessions.finish(game, first), false);
  assert.equal(sessions.has(game), true);
  sessions.started(game, second);
  assert.equal(sessions.finish(game, first), false);
  assert.equal(sessions.snapshot().sessions[0]?.status, 'running');
});

test('snapshots are detached opaque state and observer exceptions cannot own process lifecycle', () => {
  const sessions = createOwnedGameSessions({ onChange: () => { throw new Error('untrusted observer'); } });
  const token = sessions.reserve(game), value = sessions.snapshot();
  value.sessions[0]!.gameId = other; value.sessions.length = 0;
  assert.equal(sessions.has(game), true);
  assert.equal(sessions.started(game, token), true);
  assert.equal(JSON.stringify(sessions.snapshot()).includes('token'), false);
  assert.equal(JSON.stringify(sessions.snapshot()).includes('pid'), false);
  assert.equal(sessions.finish(game, token), true);
});

test('resource deferral requires a hidden launcher and an owned running child', () => {
  const sessions = createOwnedGameSessions();
  assert.equal(shouldDeferBackgroundWork(sessions.snapshot(), false), false);
  const token = sessions.reserve(game);
  assert.equal(shouldDeferBackgroundWork(sessions.snapshot(), false), false);
  sessions.started(game, token);
  assert.equal(shouldDeferBackgroundWork(sessions.snapshot(), false), true);
  assert.equal(shouldDeferBackgroundWork(sessions.snapshot(), true), false);
  const otherToken = sessions.reserve(other); sessions.started(other, otherToken);
  sessions.finish(game, token);
  assert.equal(shouldDeferBackgroundWork(sessions.snapshot(), false), true);
  sessions.finish(other, otherToken);
  assert.equal(shouldDeferBackgroundWork(sessions.snapshot(), false), false);
});

test('invalid ids and session overflow are rejected without evicting active children', () => {
  const sessions = createOwnedGameSessions();
  assert.throws(() => sessions.reserve('C:\\Game.exe'), /ui.gaming.error.invalidGame/);
  for (let n = 0; n < 100; n++) sessions.reserve(n.toString(16).padStart(16, '0'));
  assert.throws(() => sessions.reserve(game), /ui.gaming.error.sessionLimit/);
  assert.equal(sessions.snapshot().sessions.length, 100);
});

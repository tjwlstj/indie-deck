import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptMToolStatusResponse,
  applyMToolStatus,
  beginMToolStatusRequest,
  failMToolStatusRequest,
  hasMToolIntegration,
  mtoolPresentation,
  withMToolStatus,
} from '../../desktop/renderer/mtool-model.js';
import { mergePostMutationState } from '../../desktop/renderer/state-model.js';

test('MTool cards target RPG Maker families only and do not imply a translator installation', () => {
  for (const engineId of ['rpgmaker-mv', 'rpgmaker-mz', 'rpgmaker-rgss']) {
    assert.equal(hasMToolIntegration({ profile: { engineId }, mtoolIntegration: { supported: true } }), true);
  }
  for (const engineId of ['unity', 'wolf-rpg', 'renpy', 'unknown']) {
    assert.equal(hasMToolIntegration({ profile: { engineId }, mtoolIntegration: { supported: true } }), false);
  }
  assert.equal(hasMToolIntegration({ profile: { engineId: 'rpgmaker-mv' } }), false);
  const display = mtoolPresentation({ status: 'ready', gameExecutable: 'Game.exe' });
  assert.equal(display.canLaunch, true);
  assert.equal('installed' in display, false);
  assert.equal('translated' in display, false);
});

test('MTool handoff actions require ready state and known game file while folder actions stay read-only', () => {
  const ready = mtoolPresentation({ status: 'ready', gameExecutable: 'Game.exe' }, true);
  assert.equal(ready.canLaunch, false);
  assert.equal(ready.canOpen, false);
  assert.equal(ready.canOpenFolder, true);
  assert.equal(ready.canLocateGame, true);
  assert.equal(mtoolPresentation({ status: 'ready' }).canLaunch, false);
  assert.equal(mtoolPresentation({ status: 'ready' }).canOpen, true);
  for (const status of ['missing', 'disabled', 'invalid', 'unexpected']) {
    const display = mtoolPresentation({ status, gameExecutable: 'Game.exe' });
    assert.equal(display.canLaunch, false);
    assert.equal(display.canOpen, false);
    assert.equal(display.canOpenFolder, false);
  }
  assert.equal(mtoolPresentation(null).status, 'missing');
});

test('MTool configuration status replacement preserves the displayed game identity and disables auto-apply', () => {
  const context = {
    profile: { id: 'game-a', engineId: 'rpgmaker-mv', installedTranslators: [] },
    gameRevision: 4,
    mtoolIntegration: {
      supported: true, status: 'ready', gameExecutable: 'Game.exe',
      autoApply: false, docsUrl: 'https://mtool.app/tutorial.php?lang=en',
    },
  };
  const updated = withMToolStatus(context, { status: 'disabled', source: 'disabled', autoApply: true });
  assert.equal(updated.profile, context.profile);
  assert.equal(updated.gameRevision, 4);
  assert.equal(updated.mtoolIntegration.gameExecutable, 'Game.exe');
  assert.equal(updated.mtoolIntegration.status, 'disabled');
  assert.equal(updated.mtoolIntegration.autoApply, false);
  assert.deepEqual(updated.profile.installedTranslators, []);
  assert.equal(context.mtoolIntegration.status, 'ready');
  const unrelated = { profile: { id: 'game-b', engineId: 'unity' } };
  assert.equal(withMToolStatus(unrelated, { status: 'ready' }), unrelated);
});

test('external MTool refresh for game A updates the library without injecting A into selected game B', () => {
  const contextB = { profile: { id: 'game-b' }, mtoolIntegration: { status: 'disabled' } };
  const state = {
    games: [], stats: null, audits: new Map(), libraryRevision: 1,
    gameRevisions: new Map([['game-b', 2]]), translatorConfigs: new Map(),
    selected: 'game-b', detail: contextB,
  };
  const result = mergePostMutationState(state, {
    gameId: 'game-a', gameRevision: 5,
    library: { index: { revision: 5, games: [{ id: 'game-a', installedTranslators: [] }] }, audits: [] },
    detail: { profile: { id: 'game-a' }, mtoolIntegration: { status: 'ready' } },
    translatorConfig: null,
  });
  assert.equal(result.library, true);
  assert.equal(result.detail, false);
  assert.equal(state.detail, contextB);
  assert.equal(state.gameRevisions.get('game-a'), 5);
});

function probeState() {
  return {
    mtoolStatus: { status: 'ready', source: 'default', root: 'D:\\MTool' },
    mtoolStatusLoading: false,
    mtoolStatusRequestToken: 0,
    detail: {
      profile: { id: 'game-a', engineId: 'rpgmaker-mv', installedTranslators: [] },
      mtoolIntegration: {
        status: 'ready', supported: true, gameExecutable: 'Game.exe', autoApply: false,
        docsUrl: 'https://mtool.app/tutorial.php?lang=en',
      },
    },
  };
}

test('settings status re-probe gates launches and replaces stale ready with current missing/invalid evidence', () => {
  const state = probeState();
  const token = beginMToolStatusRequest(state);
  assert.equal(state.mtoolStatusLoading, true);
  assert.equal(mtoolPresentation(state.mtoolStatus, state.mtoolStatusLoading).canOpen, false);
  assert.equal(acceptMToolStatusResponse(state, token, { status: 'invalid', source: 'default', root: 'D:\\MTool' }), true);
  assert.equal(state.mtoolStatusLoading, false);
  assert.equal(state.mtoolStatus.status, 'invalid');
  assert.equal(state.detail.mtoolIntegration.status, 'invalid');
  assert.equal(state.detail.profile.id, 'game-a');
  assert.equal(state.detail.mtoolIntegration.gameExecutable, 'Game.exe');
  assert.equal(mtoolPresentation(state.mtoolStatus).canOpen, false);
});

test('a late older settings probe cannot restore Ready after a newer invalid result or connection change', () => {
  const state = probeState();
  const older = beginMToolStatusRequest(state);
  const newer = beginMToolStatusRequest(state);
  assert.equal(acceptMToolStatusResponse(state, newer, { status: 'missing', source: 'default' }), true);
  assert.equal(acceptMToolStatusResponse(state, older, { status: 'ready', source: 'default' }), false);
  assert.equal(state.mtoolStatus.status, 'missing');

  const priorConfigRead = beginMToolStatusRequest(state);
  applyMToolStatus(state, { status: 'disabled', source: 'disabled' });
  assert.equal(acceptMToolStatusResponse(state, priorConfigRead, { status: 'ready', source: 'default' }), false);
  assert.equal(state.mtoolStatus.status, 'disabled');
  assert.equal(state.mtoolStatusLoading, false);
});

test('status probe failure closes stale Ready and a stale failure cannot replace a successful newer probe', () => {
  const state = probeState();
  const token = beginMToolStatusRequest(state);
  assert.equal(failMToolStatusRequest(state, token), true);
  assert.equal(state.mtoolStatus.status, 'invalid');
  assert.equal(state.mtoolStatusLoading, false);
  assert.equal(mtoolPresentation(state.mtoolStatus).canOpen, false);
  const older = beginMToolStatusRequest(state);
  const newer = beginMToolStatusRequest(state);
  acceptMToolStatusResponse(state, newer, { status: 'ready', source: 'configured' });
  assert.equal(failMToolStatusRequest(state, older), false);
  assert.equal(state.mtoolStatus.status, 'ready');
});

test('a probe completes against the currently displayed game, never its former game snapshot', () => {
  const state = probeState();
  const token = beginMToolStatusRequest(state);
  state.detail = {
    profile: { id: 'game-b', engineId: 'rpgmaker-mz', installedTranslators: [] },
    mtoolIntegration: {
      status: 'ready', supported: true, gameExecutable: 'GameB.exe', autoApply: false,
      docsUrl: 'https://mtool.app/tutorial.php?lang=en',
    },
  };
  acceptMToolStatusResponse(state, token, { status: 'invalid', source: 'default' });
  assert.equal(state.detail.profile.id, 'game-b');
  assert.equal(state.detail.mtoolIntegration.gameExecutable, 'GameB.exe');
  assert.equal(state.detail.mtoolIntegration.status, 'invalid');
});

// Preload runs before the renderer and is the only bridge across the isolation
// boundary. It exposes a fixed list of channels - the renderer can never reach
// ipcRenderer, require, or the filesystem directly.
//
// Note what is NOT here: nothing takes a filesystem path or an executable name.
// The renderer works in opaque ids and the main process resolves them against
// its own tables, so a compromised renderer cannot name a target of its own.
const { contextBridge, ipcRenderer } = require('electron');

/** Unwraps the {ok, data|error} envelope the main process replies with. */
async function call(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply || reply.ok !== true) throw new Error(reply?.error ?? `IPC ${channel} failed`);
  return reply.data;
}

function subscribe(channel, fn) {
  const listener = (_event, value) => fn(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('indiedeck', {
  registry: () => call('registry:get'),

  config: {
    get: () => call('config:get'),
    set: (config) => call('config:set', config),
  },

  roots: {
    // Adding always goes through the OS folder picker, opened by the main
    // process; there is deliberately no add(path).
    pick: () => call('root:pick'),
    remove: (root) => call('root:remove', root),
  },

  library: {
    load: () => call('library:load'),
    scan: (options) => call('library:scan', options ?? {}),
  },

  game: {
    detail: (gameId, options) => call('game:detail', gameId, options ?? {}),
    install: (gameId, planId, options) => call('game:install', gameId, planId, options ?? {}),
    uninstall: (gameId, componentId) => call('game:uninstall', gameId, componentId),
    launch: (gameId) => call('game:launch', gameId),
    openFolder: (gameId) => call('shell:openGameFolder', gameId),
  },

  translatorConfig: {
    read: (gameId, translatorId, options) => call('config:read', gameId, translatorId, options ?? {}),
    plan: (gameId, translatorId, changes) => call('config:plan', gameId, translatorId, changes),
    write: (gameId, translatorId, changes) => call('config:write', gameId, translatorId, changes),
  },

  mods: {
    toggle: (gameId, modId, enabled) => call('mods:toggle', gameId, modId, enabled),
    add: (gameId) => call('mods:add', gameId),
  },

  open: {
    url: (url) => call('shell:openExternal', url),
  },

  on: {
    scanProgress: (fn) => subscribe('scan:progress', fn),
    installProgress: (fn) => subscribe('install:progress', fn),
    installBytes: (fn) => subscribe('install:bytes', fn),
  },
});

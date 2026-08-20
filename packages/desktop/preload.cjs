// Preload runs before the renderer and is the only bridge across the isolation
// boundary. It exposes a fixed list of channels - the renderer can never reach
// ipcRenderer, require, or the filesystem directly.
const { contextBridge, ipcRenderer } = require('electron');

/** Unwraps the {ok, data|error} envelope the main process replies with. */
async function call(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply || reply.ok !== true) throw new Error(reply?.error ?? `IPC ${channel} failed`);
  return reply.data;
}

contextBridge.exposeInMainWorld('indiedeck', {
  registry: () => call('registry:get'),

  config: {
    get: () => call('config:get'),
    set: (config) => call('config:set', config),
  },

  roots: {
    add: (root) => call('root:add', root),
    remove: (root) => call('root:remove', root),
    pick: () => call('root:pick'),
  },

  library: {
    load: () => call('library:load'),
    scan: (options) => call('library:scan', options ?? {}),
  },

  game: {
    detail: (gamePath, options) => call('game:detail', gamePath, options ?? {}),
    install: (plan, options) => call('game:install', plan, options ?? {}),
    uninstall: (gamePath, componentId) => call('game:uninstall', gamePath, componentId),
    launch: (gamePath, executable) => call('game:launch', gamePath, executable),
  },

  mods: {
    toggle: (gamePath, modId, enabled) => call('mods:toggle', gamePath, modId, enabled),
    add: (gamePath) => call('mods:add', gamePath),
  },

  open: {
    folder: (target) => call('shell:openPath', target),
    url: (url) => call('shell:openExternal', url),
  },

  on: {
    scanProgress: (fn) => {
      const listener = (_event, value) => fn(value);
      ipcRenderer.on('scan:progress', listener);
      return () => ipcRenderer.removeListener('scan:progress', listener);
    },
    installProgress: (fn) => {
      const listener = (_event, value) => fn(value);
      ipcRenderer.on('install:progress', listener);
      return () => ipcRenderer.removeListener('install:progress', listener);
    },
    installBytes: (fn) => {
      const listener = (_event, value) => fn(value);
      ipcRenderer.on('install:bytes', listener);
      return () => ipcRenderer.removeListener('install:bytes', listener);
    },
  },
});

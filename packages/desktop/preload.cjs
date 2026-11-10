// Preload runs before the renderer and is the only bridge across the isolation
// boundary. It exposes a fixed list of channels - the renderer can never reach
// ipcRenderer, require, or the filesystem directly.
//
// Game actions use opaque ids. User-selected File objects are resolved only
// here; their paths are never returned to the web content.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function selectedFilePath(file, errorKey) {
  try {
    const selected = webUtils.getPathForFile(file);
    if (selected && selected.length <= 32767) return selected;
  } catch { /* Reject objects and synthetic Files that have no disk backing. */ }
  throw new Error(errorKey);
}

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
  app: {
    info: () => call('app:info'),
  },

  gaming: {
    current: () => call('gaming:current'),
    setFullscreen: (enabled) => call('gaming:setFullscreen', enabled),
    configure: (preferences) => call('gaming:configure', preferences),
    registration: (gameId) => call('gaming:registration', gameId),
    exportShortcut: (gameId) => call('gaming:exportShortcut', gameId),
    openSettings: (action) => call('gaming:openSettings', action),
    onState: (fn) => subscribe('gaming:state', fn),
    onEntryError: (fn) => subscribe('gaming:entry-error', fn),
  },

  updates: {
    current: () => call('updates:current'),
    check: () => call('updates:check'),
    download: () => call('updates:download'),
    install: () => call('updates:install'),
    openRelease: () => call('updates:openRelease'),
    onStatus: (fn) => subscribe('updates:status', fn),
  },

  registry: () => call('registry:get'),

  security: {
    current: () => call('security:current'),
    setLaunchScan: (enabled) => call('security:setLaunchScan', enabled),
    refresh: () => call('security:refresh'),
    scanGame: (gameId) => call('security:scanGame', gameId),
    update: () => call('security:update'),
    cancel: (taskId) => call('security:cancel', taskId),
    openHelp: (action) => call('security:openHelp', action),
    onStatus: (fn) => subscribe('security:status', fn),
  },

  i18n: {
    get: () => call('i18n:get'),
  },

  config: {
    get: () => call('config:get'),
    set: (config) => call('config:set', config),
  },

  libraryPreferences: {
    read: () => call('library-preferences:read'),
    save: (input) => call('library-preferences:save', input),
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
    scanCurrent: () => call('library:scanCurrent'),
    cancelScan: (id) => call('library:cancelScan', id),
  },

  game: {
    pickThumbnail: (gameId, fromGameFolder = false) => call('game:pickThumbnail', gameId, fromGameFolder),
    importThumbnail: async (gameId, file) => call('game:importThumbnail', gameId, selectedFilePath(file, 'ui.thumbnail.importFailed')),
    clearThumbnail: (gameId) => call('game:clearThumbnail', gameId),
    onLaunchDiagnostic: (fn) => subscribe('game:launch-diagnostic', fn),
    thumbnail: (gameId) => call('game:thumbnail', gameId),
    thumbnailSearch: (gameId) => call('game:thumbnailSearch', gameId),
    thumbnailPreview: (gameId, provider, resultId) => call('game:thumbnailPreview', gameId, provider, resultId),
    thumbnailSelect: (gameId, appId) => call('game:thumbnailSelect', gameId, appId),
    thumbnailSearchGog: (gameId) => call('game:thumbnailSearchGog', gameId),
    thumbnailSelectGog: (gameId, id) => call('game:thumbnailSelectGog', gameId, id),
    detail: (gameId, options) => call('game:detail', gameId, options ?? {}),
    refresh: (gameId) => call('game:refresh', gameId),
    launch: (gameId) => call('game:launch', gameId),
    openFolder: (gameId) => call('shell:openGameFolder', gameId),
  },

  mtool: {
    status: () => call('mtool:status'),
    pick: () => call('mtool:pick'),
    clear: () => call('mtool:clear'),
    launch: (gameId) => call('mtool:launch', gameId),
    open: () => call('mtool:open'),
    openFolder: () => call('mtool:openFolder'),
    selectGameFile: (gameId) => call('mtool:selectGameFile', gameId),
  },

  archives: {
    list: () => call('archives:list'),
    pick: () => call('archives:pick'),
    import: (candidateId, label, productId) => call('archives:import', candidateId, label, productId),
    activate: (installationId) => call('archives:activate', installationId),
    recover: () => call('archives:recover'),
    current: () => call('archives:current'),
    onProgress: (fn) => subscribe('archives:progress', fn),
  },

  stores: {
    list: () => call('stores:list'),
    pick: () => call('stores:pick'),
    preview: (text) => call('stores:preview', text),
    previewArtwork: (candidateId) => call('stores:previewArtwork', candidateId),
    applyArtwork: (candidateId, previewId, gameId) => call('stores:applyArtwork', candidateId, previewId, gameId),
    importFile: async (file) => call('stores:importFile', selectedFilePath(file, 'ui.stores.error.linkFileInvalid')),
    save: (candidateId, managedProductId, gameId, title) => call('stores:save', candidateId, managedProductId, gameId, title),
    remove: (linkId) => call('stores:remove', linkId),
    open: (provider, action, linkId) => call('stores:open', provider, action, linkId),
    openCompanion: () => call('stores:openCompanion'),
  },

  maintenance: {
    start: (request) => call('maintenance:start', request),
    current: () => call('maintenance:current'),
    outcome: (operationId) => call('maintenance:outcome', operationId),
    acknowledge: (operationId) => call('maintenance:acknowledge', operationId),
  },

  translatorConfig: {
    clearHistory: (gameId) => call('config:clearHistory', gameId),
    read: (gameId, translatorId) => call('config:read', gameId, translatorId),
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
    scanStatus: (fn) => subscribe('scan:status', fn),
    scanProgress: (fn) => subscribe('scan:progress', fn),
    maintenanceProgress: (fn) => subscribe('maintenance:progress', fn),
    maintenanceOutcome: (fn) => subscribe('maintenance:outcome', fn),
  },
});

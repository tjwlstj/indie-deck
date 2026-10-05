/**
 * The app-level settings view (§4.2 of the UX contract).
 *
 * Global options only. Per-game translator configuration stays in the game
 * detail panel; the two never mix. Roots are managed exclusively here - the
 * sidebar keeps no editable copy - and adding one still goes through the main
 * process's OS folder picker, never a renderer-supplied path.
 */

import { $, clear, el, setStatus } from '../dom.js';
import { localeOptions, t } from '../i18n.js';
import { api, applyLibraryPayload, emit, mutationBlocked, state } from '../store.js';
import { resetConfigPanel } from './config.js';
import { renderMToolSettings } from './mtool.js';
import { renderArchiveSettings } from './archives.js';
import { renderLauncherUpdates } from './updates.js';
import { validScanDepth } from '../scan-model.js';

export function setSettingsMutationDisabled() {
  const disabled = mutationBlocked();
  for (const id of ['uiLocale', 'targetLanguage', 'sourceLanguage', 'endpoint', 'saveDefaults', 'scanDepth', 'saveScanSettings', 'addRoot', 'rescanRoots', 'importArchive']) {
    const node = $(id);
    if (node) node.disabled = disabled;
  }
  for (const button of document.querySelectorAll('#rootList button')) button.disabled = disabled;
  renderMToolSettings();
  renderArchiveSettings();
  renderLauncherUpdates();
}

export function populateScanSettings() {
  const select = $('scanDepth');
  select.replaceChildren();
  for (let depth = 0; depth <= 12; depth += 1) {
    const label = depth === 0
      ? t('ui.scan.rootOnly', undefined, '0 — registered game folder only')
      : depth === 6 ? t('ui.scan.recommendedDepth', undefined, '6 — recommended') : String(depth);
    const option = el('option', null, label);
    option.value = String(depth);
    select.append(option);
  }
  const depth = state.config?.scanDepth;
  select.value = String(validScanDepth(depth) ? depth : 6);
  $('scanLegacyHint').hidden = depth !== 2;
}

export function renderRoots() {
  const list = clear($('rootList'));
  const configured = state.config?.roots ?? [];
  if (configured.length === 0) {
    const li = el('li');
    li.append(el('span', 'path muted-text', t('ui.sidebar.noRoots', undefined, 'none configured')));
    list.append(li);
  }
  for (const root of configured) {
    const li = el('li');
    li.append(el('span', 'path', root));
    const remove = el('button', null, '×');
    remove.title = t('ui.sidebar.stopScanning', { root }, 'Stop scanning {root}');
    remove.disabled = mutationBlocked();
    remove.addEventListener('click', async () => {
      if (mutationBlocked()) return;
      try {
        state.config = await api.roots.remove(root);
        // Root removal is already committed at this point. Reflect that fact
        // even if the follow-up library read fails, instead of leaving the
        // removed root visible as though nothing changed.
        renderRoots();
        emit('all');
        const payload = await api.library.load();
        applyLibraryPayload(payload);
        if (state.selected && !state.games.some((game) => game.id === state.selected)) {
          state.selected = null;
          state.detail = null;
          state.selectionRequestToken += 1;
          resetConfigPanel();
        }
        emit('all');
      } catch (err) {
        setStatus(err.message, 'err');
      }
    });
    li.append(remove);
    list.append(li);
  }
  setSettingsMutationDisabled();
}

export function renderAbout() {
  $('appVersion').textContent = `v${state.appInfo.version}`;
  $('appVersion').hidden = false;
  const mode = state.updateStatus?.mode ?? state.appInfo.updateMode ?? (state.appInfo.portable ? 'portable' : 'development');
  const kind = mode === 'portable'
    ? t('ui.settings.portableBuild', undefined, 'portable build')
    : mode === 'development'
      ? t('ui.settings.developmentBuild', undefined, 'development / unpacked build')
      : mode === 'disabled'
        ? t('ui.settings.updateDisabledMode', undefined, 'in-app updates disabled')
        : t('ui.settings.installedBuild', undefined, 'installed build');
  $('aboutInfo').textContent =
    `IndieDeck v${state.appInfo.version} · ${kind}` +
    (mode !== 'installed' ? ` · ${t('ui.settings.manualUpdatesOnly', undefined, 'updates are manual')}` : '');
}

export function populateDefaultsForm(endpoints) {
  const endpointSelect = $('endpoint');
  endpointSelect.replaceChildren();
  for (const endpoint of endpoints) {
    const option = el('option', null, endpoint.needsKey ? `${endpoint.id} (key)` : endpoint.id);
    option.value = endpoint.id;
    endpointSelect.append(option);
  }
  const defaults = state.config?.defaults ?? {};
  $('targetLanguage').value = defaults.targetLanguage ?? 'en';
  $('sourceLanguage').value = defaults.sourceLanguage ?? 'ja';
  endpointSelect.value = defaults.endpoint ?? 'GoogleTranslate';
}

export function populateLocaleSelect() {
  const select = $('uiLocale');
  select.replaceChildren();
  const system = el('option', null, `${t('ui.app.language', undefined, 'Language')}: auto`);
  system.value = 'system';
  select.append(system);
  for (const locale of localeOptions()) {
    const option = el('option', null, locale.label);
    option.value = locale.code;
    select.append(option);
  }
  select.value = state.config?.locale ?? 'system';
}

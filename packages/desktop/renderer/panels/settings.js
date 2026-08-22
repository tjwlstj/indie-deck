/**
 * The app-level settings view (§4.2 of the UX contract).
 *
 * Global options only. Per-game translator configuration stays in the game
 * detail panel; the two never mix. Roots are managed exclusively here - the
 * sidebar keeps no editable copy - and adding one still goes through the main
 * process's OS folder picker, never a renderer-supplied path.
 */

import { $, clear, el } from '../dom.js';
import { localeOptions, t } from '../i18n.js';
import { api, emit, state } from '../store.js';

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
    remove.addEventListener('click', async () => {
      state.config = await api.roots.remove(root);
      renderRoots();
      emit('library');
    });
    li.append(remove);
    list.append(li);
  }
}

export function renderAbout() {
  $('appVersion').textContent = `v${state.appInfo.version}`;
  $('appVersion').hidden = false;
  const kind = state.appInfo.portable
    ? t('ui.settings.portableBuild', undefined, 'portable build')
    : t('ui.settings.installedBuild', undefined, 'installed build');
  $('aboutInfo').textContent =
    `IndieDeck v${state.appInfo.version} · ${kind}` +
    (state.appInfo.portable ? ` · ${t('ui.settings.manualUpdatesOnly', undefined, 'updates are manual')}` : '');
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

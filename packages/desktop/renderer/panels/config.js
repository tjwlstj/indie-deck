/**
 * The translation-settings form.
 *
 * The form is generated from the config schema core sends, so it never hard
 * codes a setting or an INI key: adding a setting to
 * registry/configs/*.json makes a control appear here with no change to this
 * file.
 */

import { $, el, setStatus } from '../dom.js';
import { retranslate, t } from '../i18n.js';
import { api, state } from '../store.js';

const config = {
  data: null,
  pending: new Map(),
  open: new Set(['basic', 'credentials']),
  busy: false,
};

export function resetConfigPanel() {
  config.data = null;
  config.pending.clear();
  config.busy = false;
}

function currentValue(id, fallback) {
  return config.pending.has(id) ? config.pending.get(id) : fallback;
}

function stage(id, value, original) {
  if (value === original) config.pending.delete(id);
  else config.pending.set(id, value);
  renderFooterCount();
}

/* -------------------------------------------------------------- controls */

const LANGUAGE_CODES = ['ko', 'ja', 'en', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'ru', 'pt', 'it', 'vi', 'th', 'id'];

function select(options, value, onChange) {
  const node = el('select');
  for (const option of options) {
    const item = el('option', null, option.label);
    item.value = option.value;
    node.append(item);
  }
  if (value && ![...node.options].some((o) => o.value === value)) {
    const custom = el('option', null, t('ui.config.inFile', { value }, '{value} (in file)'));
    custom.value = value;
    node.append(custom);
  }
  node.value = value;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function control(id, type, value, original, options = {}) {
  if (type === 'boolean') {
    const button = el('button', `toggle${String(value).toLowerCase() === 'true' ? ' on' : ''}`);
    button.addEventListener('click', () => {
      const next = String(currentValue(id, value)).toLowerCase() === 'true' ? 'False' : 'True';
      stage(id, next, original);
      button.classList.toggle('on', next === 'True');
    });
    return button;
  }

  if (type === 'provider-select') {
    const entries = config.data.config.providers.map((p) => ({
      value: p.provider.id,
      label: `${p.provider.label}  ·  ${p.provider.tier.join('/')}`,
    }));
    if (options.allowEmpty) entries.unshift({ value: '', label: t('ui.config.none', undefined, '(none)') });
    return select(entries, value, (next) => {
      stage(id, next, original);
      render();
    });
  }

  if (type === 'language') {
    return select(
      LANGUAGE_CODES.map((code) => ({ value: code, label: code })),
      value,
      (next) => stage(id, next, original),
    );
  }

  if (type === 'font-bundle') {
    const entries = [{ value: '', label: t('ui.config.none', undefined, '(none)') }];
    for (const bundle of config.data.fontBundles ?? []) entries.push({ value: bundle, label: bundle });
    const node = select(entries, value, (next) => stage(id, next, original));
    if (value && ![...node.options].some((o) => o.value === value)) {
      const custom = el('option', null, t('ui.config.inFileNotInFolder', { value }, '{value} (in file, not in folder)'));
      custom.value = value;
      node.append(custom);
      node.value = value;
    }
    return node;
  }

  const input = el('input');
  input.type = type === 'secret' ? 'password' : type === 'integer' || type === 'number' ? 'number' : 'text';
  input.value = value;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (type === 'secret') input.autocomplete = 'off';
  input.addEventListener('input', () => stage(id, input.value, original));
  return input;
}

function settingRow(setting) {
  const row = el('div', 'cfg-row');
  const label = el('label', 'cfg-label');
  label.append(el('span', null, setting.label));
  if (setting.deprecated) label.append(el('span', 'pill warn', t('ui.config.deprecated', undefined, 'deprecated')));
  // When the version itself is unknown every mapping is assumed and the panel
  // header already says so - only flag a row when it is the exception.
  if (setting.assumed && config.data?.config.detected.version) {
    label.append(el('span', 'pill warn', t('ui.config.assumed', undefined, 'assumed')));
  }
  row.append(label);
  row.append(control(setting.id, setting.type, currentValue(setting.id, setting.value), setting.value, setting.ui));
  if (setting.help) row.append(el('div', 'cfg-help', setting.help));
  return row;
}

/* --------------------------------------------------------------- render */

function renderFooterCount() {
  const footer = $('cfgFooter');
  if (!footer) return;
  const count = config.pending.size;
  footer.hidden = count === 0;
  const label = $('cfgCount');
  if (label) {
    label.textContent =
      count === 1
        ? t('ui.config.unsavedOne', undefined, '1 unsaved change')
        : t('ui.config.unsavedMany', { count }, '{count} unsaved changes');
  }
}

function section(host, id, label, settings, extra) {
  const node = el('section', 'cfg-section');
  const header = el('button', 'cfg-head');
  const isOpen = config.open.has(id);
  header.append(el('span', 'chev', isOpen ? '▾' : '▸'), el('span', null, label));
  header.addEventListener('click', () => {
    if (config.open.has(id)) config.open.delete(id);
    else config.open.add(id);
    render();
  });
  node.append(header);

  if (isOpen) {
    const body = el('div', 'cfg-body');
    for (const setting of settings ?? []) body.append(settingRow(setting));
    if (extra) extra(body);
    node.append(body);
  }
  host.append(node);
}

function render() {
  const host = $('configPanel');
  if (!host || !config.data) return;
  host.replaceChildren();

  const data = config.data;
  const current = data.config;

  const meta = el('div', 'cfg-meta');
  meta.append(
    el('span', null, `${current.translatorName}  ${current.detected.version ?? t('ui.detail.unknownVersion', undefined, 'unknown version')}`),
    el(
      'span',
      'plan-sub',
      t('ui.config.versionFrom', { source: current.detected.source, confidence: current.detected.confidence }, 'from {source} · {confidence}'),
    ),
  );
  host.append(meta);
  host.append(
    el(
      'div',
      'plan-sub',
      current.location.path + (current.location.exists ? '' : `  (${t('ui.config.createdOnLaunch', undefined, 'created on first launch')})`),
    ),
  );
  host.append(
    el(
      'div',
      'plan-sub',
      t(
        'ui.config.coverage',
        { described: current.coverage.described, total: current.coverage.total },
        'schema describes {described} of {total} keys; the rest are preserved untouched',
      ),
    ),
  );

  for (const warning of current.warnings) {
    const row = el('div', 'issue');
    row.append(el('div', null, retranslate(warning, 'key', 'params', 'text')));
    host.append(row);
  }

  const byCategory = new Map();
  for (const value of current.values) {
    if (!byCategory.has(value.category)) byCategory.set(value.category, []);
    byCategory.get(value.category).push(value);
  }

  for (const category of data.categories) {
    if (category.id === 'credentials') continue;
    const settings = byCategory.get(category.id);
    if (!settings || settings.length === 0) continue;
    section(host, category.id, category.label, settings);
  }

  // Credentials follow whichever engine is selected right now, staged edits
  // included, so switching engine immediately shows the right fields.
  const selectedId = currentValue('xunity.endpoint', current.values.find((v) => v.id === 'xunity.endpoint')?.value ?? '');
  const selected = current.providers.find((p) => p.provider.id === selectedId);
  if (selected) {
    section(host, 'credentials', t('ui.config.credentials', { provider: selected.provider.label }, '{provider} credentials'), [], (body) => {
      if (selected.fields.length === 0) {
        body.append(el('div', 'cfg-help', t('ui.config.noCredentials', undefined, 'This engine needs no credentials.')));
      }
      for (const field of selected.fields) {
        const id = `provider:${selected.provider.id}:${field.key}`;
        const row = el('div', 'cfg-row');
        const label = el('label', 'cfg-label');
        label.append(el('span', null, field.label));
        if (field.required && !field.value) label.append(el('span', 'pill err', t('ui.config.required', undefined, 'required')));
        row.append(label);
        row.append(control(id, field.type, currentValue(id, ''), '', { placeholder: field.value || undefined }));
        if (field.isSecret) {
          row.append(
            el('div', 'cfg-help', t('ui.config.plaintextWarning', undefined, 'Stored in the game config as plain text - that is how the plugin reads it.')),
          );
        }
        body.append(row);
      }
      if (selected.provider.note) body.append(el('div', 'cfg-help', selected.provider.note));
      if (selected.provider.languages) {
        body.append(
          el(
            'div',
            'cfg-help',
            t(
              'ui.config.supports',
              { source: selected.provider.languages.source.join(', '), target: selected.provider.languages.target.join(', ') },
              'Supports {source} → {target}',
            ),
          ),
        );
      }
    });
  }

  if (current.unknown.length > 0) {
    section(host, 'expert', t('ui.config.undescribed', { count: current.unknown.length }, 'Keys IndieDeck does not describe ({count})'), [], (body) => {
      body.append(el('div', 'cfg-help', t('ui.config.undescribedNote', undefined, 'Never modified. Listed so nothing looks lost.')));
      const list = el('div', 'log');
      list.textContent = current.unknown.map((u) => `[${u.section}] ${u.key}=${u.value}`).join('\n');
      body.append(list);
    });
  }

  const footer = el('div', 'cfg-footer');
  footer.id = 'cfgFooter';
  footer.hidden = config.pending.size === 0;
  const count = el('span', 'cfg-count');
  count.id = 'cfgCount';
  footer.append(count);

  const preview = el('button', 'ghost', t('ui.config.preview', undefined, 'Preview'));
  preview.addEventListener('click', () => apply(true));
  const save = el('button', 'primary', t('ui.config.save', undefined, 'Save'));
  save.addEventListener('click', () => apply(false));
  const discard = el('button', 'ghost', t('ui.config.discard', undefined, 'Discard'));
  discard.addEventListener('click', () => {
    config.pending.clear();
    render();
  });
  footer.append(preview, save, discard);
  host.append(footer);

  const log = el('div', 'log');
  log.id = 'cfgLog';
  log.hidden = true;
  host.append(log);
  renderFooterCount();
}

/* ---------------------------------------------------------------- apply */

function planText(plan) {
  const lines = plan.changes.map(
    (change) =>
      `[${change.section}] ${change.key}: ${change.from || t('ui.config.none', undefined, '(none)')} -> ${change.to || t('ui.config.none', undefined, '(none)')}`,
  );
  for (const issue of plan.issues) {
    const mark = issue.severity === 'error' ? '×' : issue.severity === 'warn' ? '!' : '•';
    lines.push(`${mark} ${retranslate(issue)}`);
  }
  return lines.join('\n');
}

async function apply(previewOnly) {
  if (config.busy) return;
  const changes = [...config.pending.entries()].map(([id, value]) => ({ id, value }));
  if (changes.length === 0) return;

  config.busy = true;
  const log = $('cfgLog');
  log.hidden = false;
  log.textContent = t('ui.config.checking', undefined, 'Checking…');

  try {
    if (previewOnly) {
      log.textContent = planText(await api.translatorConfig.plan(state.selected, config.data.config.translatorId, changes));
      return;
    }

    const { plan, result } = await api.translatorConfig.write(state.selected, config.data.config.translatorId, changes);
    log.textContent = planText(plan);
    if (!result) {
      setStatus(t('ui.config.notWritten', undefined, 'Nothing written - fix the errors above.'), 'err');
      return;
    }
    log.textContent += `\n\n${t('ui.config.written', { count: result.changed, path: result.path }, '{count} setting(s) written to {path}')}`;
    if (result.backup) log.textContent += `\n${t('ui.config.backedUp', { path: result.backup }, 'original backed up to {path}')}`;
    config.pending.clear();
    setStatus(t('ui.config.saved', { count: result.changed }, '{count} setting(s) saved'), 'ok');
    await load();
  } catch (err) {
    log.textContent = err.message;
    setStatus(err.message, 'err');
  } finally {
    config.busy = false;
    renderFooterCount();
  }
}

async function load() {
  const host = $('configPanel');
  if (!host || !state.selected) return;
  try {
    config.data = await api.translatorConfig.read(state.selected, config.data?.config.translatorId, {});
    render();
  } catch (err) {
    host.replaceChildren(el('div', 'cfg-help', err.message));
  }
}

/** Mounts the panel into the detail column. */
export function renderConfigSection(panel) {
  panel.append(el('h3', null, t('ui.config.title', undefined, 'Translation settings')));
  const host = el('div', 'cfg');
  host.id = 'configPanel';
  panel.append(host);
  void load();
}

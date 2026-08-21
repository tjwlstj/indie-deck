import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GameProfile, InstallReceipt, LoaderDef, ModLayout, Registry } from '../types.ts';

import { ensureDir, pathExists } from '../util/fsx.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import { isNativeLoader } from '../registry/index.ts';
import { BACKUP_DIR, writeReceipt } from '../install/apply.ts';
import { withTransaction } from '../install/transaction.ts';
import { extractZip } from '../install/unzip.ts';

export type { ModLayout };

export interface ModEntry {
  id: string;
  name: string;
  /** Path relative to the game root. */
  file: string;
  enabled: boolean;
  isDirectory: boolean;
  loaderId: string;
  managedByIndieDeck: boolean;
  sizeBytes?: number;
}

export interface ModHost {
  loader: LoaderDef;
  layout: ModLayout;
  /** Resolved, root-relative mod directory. */
  dir: string;
  registryFile?: string;
}

const EXT_BY_ENTRY: Record<ModLayout['entry'], string[]> = {
  dll: ['.dll'],
  'dll-or-folder': ['.dll'],
  folder: [],
  js: ['.js'],
  rpy: ['.rpy', '.rpyc', '.rpa'],
};

function substitute(value: string, profile: GameProfile): string {
  return value.replace('$shippingBinDir', profile.captures['shippingBinDir'] ?? 'Binaries/Win64');
}

/** Which mod hosts are actually usable for this game right now. */
export function modHosts(reg: Registry, profile: GameProfile): ModHost[] {
  const hosts: ModHost[] = [];
  const engineLoaders = reg.engines.find((e) => e.id === profile.engineId)?.loaders ?? [];
  const installedIds = new Set(profile.installedLoaders.map((l) => l.loaderId));

  for (const loader of reg.loaders) {
    const layout = loader.modLayout;
    if (!layout) continue;
    if (!engineLoaders.includes(loader.id)) continue;
    // Native hosts (RPG Maker plugins, Ren'Py game/) always apply; external
    // loaders only count once they are actually installed.
    const isNative = isNativeLoader(reg, loader.id);
    if (!isNative && !installedIds.has(loader.id)) continue;

    const primary = substitute(layout.dir, profile);
    const dir = layout.altDir && !existsRelSync(profile, primary) && existsRelSync(profile, layout.altDir) ? layout.altDir : primary;
    const host: ModHost = { loader, layout, dir };
    const registryFile =
      dir === layout.altDir ? layout.altRegistryFile ?? layout.registryFile : layout.registryFile;
    if (registryFile) host.registryFile = substitute(registryFile, profile);
    hosts.push(host);
  }
  return hosts;
}

function existsRelSync(profile: GameProfile, rel: string): boolean {
  try {
    return fs.existsSync(path.join(profile.path, rel));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------- registry formats */

/** A mod as recorded in a loader's own registry file. */
export interface RegistryRecord {
  name: string;
  status: boolean;
}

export interface RegistryFormat {
  parse(text: string): RegistryRecord[];
  setStatus(text: string, name: string, status: boolean): string;
  append(text: string, name: string): string;
}

/* ------------------------------------------------------- RPG Maker plugins.js */

export interface RpgPluginRecord {
  name: string;
  status: boolean;
  description?: string;
}

/**
 * plugins.js is `var $plugins = [ ... ];` - a JS array literal, not JSON.
 * Reading it with a regex avoids evaluating untrusted code from a game folder.
 */
export function parsePluginsJs(text: string): RpgPluginRecord[] {
  const records: RpgPluginRecord[] = [];
  const re = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"status"\s*:\s*(true|false)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    records.push({ name: m[1]!, status: m[2] === 'true' });
  }
  return records;
}

export function setPluginStatus(text: string, name: string, status: boolean): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("name"\\s*:\\s*"${escaped}"\\s*,\\s*"status"\\s*:\\s*)(true|false)`);
  if (!re.test(text)) return text;
  return text.replace(re, `$1${status}`);
}

export function appendPlugin(text: string, name: string): string {
  const entry = `{"name":"${name}","status":true,"description":"Added by IndieDeck","parameters":{}}`;
  const close = text.lastIndexOf(']');
  if (close < 0) return text;
  const before = text.slice(0, close).trimEnd();
  const needsComma = /[}\]]\s*$/.test(before);
  return `${before}${needsComma ? ',\n' : '\n'}${entry}\n${text.slice(close)}`;
}

/* ------------------------------------------------------------ UE4SS mods.txt */

/**
 * UE4SS keeps one mod per line: `ModName : 1` enabled, `ModName : 0` disabled.
 * A different file format from RPG Maker's plugins.js - parsing it with the
 * plugins.js regex simply found nothing, which is why the format is declared in
 * the registry rather than inferred from the disable strategy.
 */
export function parseModsTxt(text: string): RegistryRecord[] {
  const records: RegistryRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const m = /^(.+?)\s*:\s*([01])\s*$/.exec(trimmed);
    if (m) records.push({ name: m[1]!.trim(), status: m[2] === '1' });
  }
  return records;
}

export function setModsTxtStatus(text: string, name: string, status: boolean): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s*${escaped}\\s*:\\s*)[01](\\s*)$`, 'm');
  if (!re.test(text)) return text;
  return text.replace(re, `$1${status ? '1' : '0'}$2`);
}

export function appendModsTxt(text: string, name: string): string {
  const needsNewline = text.length > 0 && !text.endsWith('\n');
  return `${text}${needsNewline ? '\n' : ''}${name} : 1\n`;
}

/**
 * Registry-file formats, keyed by the `registryFormat` a modLayout declares.
 * Adding a loader with its own manifest format is one entry here.
 */
export const REGISTRY_FORMATS: Record<string, RegistryFormat> = {
  'plugins-js': { parse: parsePluginsJs, setStatus: setPluginStatus, append: appendPlugin },
  lines: { parse: parseModsTxt, setStatus: setModsTxtStatus, append: appendModsTxt },
};

function formatFor(host: ModHost): RegistryFormat {
  return REGISTRY_FORMATS[host.layout.registryFormat ?? 'plugins-js'] ?? REGISTRY_FORMATS['plugins-js']!;
}

/* ------------------------------------------------------------------- listing */

export async function listMods(reg: Registry, profile: GameProfile): Promise<ModEntry[]> {
  const out: ModEntry[] = [];

  for (const host of modHosts(reg, profile)) {
    const absDir = path.join(profile.path, host.dir);
    let names: string[];
    try {
      names = await fsp.readdir(absDir);
    } catch {
      continue;
    }

    if (host.layout.disable === 'registry-flag' && host.registryFile) {
      const registryPath = path.join(profile.path, host.registryFile);
      const text = (await pathExists(registryPath)) ? await fsp.readFile(registryPath, 'utf8') : '';
      const records = new Map(formatFor(host).parse(text).map((r) => [r.name, r.status]));
      const wanted = EXT_BY_ENTRY[host.layout.entry];

      for (const name of names) {
        const full = path.join(absDir, name);
        const stat = await fsp.stat(full).catch(() => undefined);
        if (!stat) continue;
        // A folder-entry host (UE4SS) lists directories; a js-entry host
        // (RPG Maker) lists .js files.
        if (host.layout.entry === 'folder' ? !stat.isDirectory() : !wanted.some((e) => name.toLowerCase().endsWith(e))) {
          continue;
        }
        const id = wanted.length > 0 ? name.replace(/\.[^.]+$/, '') : name;
        out.push({
          id,
          name: id,
          file: `${host.dir}/${name}`,
          enabled: records.get(id) ?? false,
          isDirectory: stat.isDirectory(),
          loaderId: host.loader.id,
          managedByIndieDeck: id.startsWith(host.layout.filePrefix ?? 'indiedeck_'),
        });
      }
      continue;
    }

    const exts = EXT_BY_ENTRY[host.layout.entry];
    const suffix = host.layout.disabledSuffix ?? '.disabled';

    for (const name of names) {
      const full = path.join(absDir, name);
      const stat = await fsp.stat(full).catch(() => undefined);
      if (!stat) continue;
      const disabled = name.toLowerCase().endsWith(suffix);
      const bare = disabled ? name.slice(0, -suffix.length) : name;

      if (stat.isDirectory()) {
        if (host.layout.entry === 'dll' || host.layout.entry === 'js' || host.layout.entry === 'rpy') continue;
        out.push({
          id: bare,
          name: bare,
          file: `${host.dir}/${name}`,
          enabled: !disabled,
          isDirectory: true,
          loaderId: host.loader.id,
          managedByIndieDeck: bare.startsWith(host.layout.filePrefix ?? 'indiedeck_'),
        });
        continue;
      }

      if (exts.length > 0 && !exts.some((e) => bare.toLowerCase().endsWith(e))) continue;
      out.push({
        id: bare.replace(/\.[^.]+$/, ''),
        name: bare,
        file: `${host.dir}/${name}`,
        enabled: !disabled,
        isDirectory: false,
        loaderId: host.loader.id,
        managedByIndieDeck: bare.startsWith(host.layout.filePrefix ?? 'indiedeck_'),
        sizeBytes: stat.size,
      });
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------- enable/disable */

export interface ToggleResult {
  mod: string;
  from: string;
  to: string;
  strategy: ModLayout['disable'];
}

export async function setModEnabled(
  reg: Registry,
  profile: GameProfile,
  modId: string,
  enabled: boolean,
  options: { dryRun?: boolean; logger?: Logger } = {},
): Promise<ToggleResult> {
  const log = options.logger ?? silentLogger;
  const mods = await listMods(reg, profile);
  const mod = mods.find((m) => m.id === modId || m.name === modId);
  if (!mod) throw new Error(`No mod named "${modId}" in ${profile.name}.`);
  if (mod.enabled === enabled) return { mod: mod.name, from: mod.file, to: mod.file, strategy: 'rename-suffix' };

  const host = modHosts(reg, profile).find((h) => h.loader.id === mod.loaderId);
  if (!host) throw new Error(`Mod host for ${mod.loaderId} is no longer available.`);

  if (host.layout.disable === 'registry-flag' && host.registryFile) {
    const registryPath = path.join(profile.path, host.registryFile);
    const text = await fsp.readFile(registryPath, 'utf8');
    const updated = formatFor(host).setStatus(text, mod.id, enabled);
    if (updated === text) throw new Error(`${mod.id} is not registered in ${host.registryFile}.`);
    if (!options.dryRun) {
      // Only the first toggle snapshots the file: overwriting the backup each
      // time would lose the pristine original after one flip.
      const backup = `${registryPath}.indiedeck.bak`;
      if (!(await pathExists(backup))) await fsp.copyFile(registryPath, backup);
      await fsp.writeFile(registryPath, updated, 'utf8');
    }
    log.info(`${enabled ? 'Enabled' : 'Disabled'} ${mod.id} in ${host.registryFile}`);
    return { mod: mod.name, from: host.registryFile, to: host.registryFile, strategy: 'registry-flag' };
  }

  if (host.layout.disable === 'move-to-disabled') {
    const disabledDir = host.layout.disabledDir ?? `${host.dir}.disabled`;
    const from = enabled ? path.join(profile.path, disabledDir, mod.name) : path.join(profile.path, mod.file);
    const to = enabled ? path.join(profile.path, host.dir, mod.name) : path.join(profile.path, disabledDir, mod.name);
    if (!options.dryRun) {
      await ensureDir(path.dirname(to));
      await fsp.rename(from, to);
    }
    return { mod: mod.name, from: path.relative(profile.path, from), to: path.relative(profile.path, to), strategy: 'move-to-disabled' };
  }

  const suffix = host.layout.disabledSuffix ?? '.disabled';
  const from = path.join(profile.path, mod.file);
  const to = enabled ? from.slice(0, -suffix.length) : `${from}${suffix}`;
  if (!options.dryRun) await fsp.rename(from, to);
  log.info(`${enabled ? 'Enabled' : 'Disabled'} ${mod.name}`);
  return { mod: mod.name, from: mod.file, to: path.relative(profile.path, to), strategy: 'rename-suffix' };
}

/* ------------------------------------------------------------------ install */

export interface InstallModOptions {
  loaderId?: string;
  dryRun?: boolean;
  logger?: Logger;
  /** Name to record in the receipt; defaults to the archive/file basename. */
  name?: string;
}

/**
 * Installs a mod from a local .zip (or a single loose file) into the right host
 * directory for the game's engine, and records a receipt so it can be removed
 * again cleanly.
 */
export async function installModFromFile(
  reg: Registry,
  profile: GameProfile,
  sourcePath: string,
  options: InstallModOptions = {},
): Promise<{ receipt?: InstallReceipt; files: string[]; host: ModHost }> {
  const log = options.logger ?? silentLogger;
  const hosts = modHosts(reg, profile);
  const host = options.loaderId ? hosts.find((h) => h.loader.id === options.loaderId) : hosts[0];
  if (!host) {
    throw new Error(
      `No mod host available for ${profile.name}. Install a loader first (${(reg.engines.find((e) => e.id === profile.engineId)?.loaders ?? []).join(', ') || 'none registered for this engine'}).`,
    );
  }

  const destDir = path.join(profile.path, host.dir);
  const name = options.name ?? path.basename(sourcePath).replace(/\.(zip|dll|js|rpy)$/i, '');
  const isZip = sourcePath.toLowerCase().endsWith('.zip');

  // Everything below runs in one transaction: a mod archive that lands on a
  // file the game (or another mod) owns backs that file up first, and any
  // failure puts the folder back exactly as it was.
  const { result, entries } = await withTransaction(
    {
      root: profile.path,
      backupDir: BACKUP_DIR,
      logger: log,
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    },
    async (tx) => {
      const written = isZip
        ? await tx.extract(sourcePath, host.dir)
        : [await tx.copyIn(sourcePath, `${host.dir}/${path.basename(sourcePath)}`)];

      // RPG Maker plugins only take effect once registered in plugins.js. That
      // file belongs to the game, so it is patched - never replaced wholesale -
      // and the original is kept for uninstall.
      if (host.layout.disable === 'registry-flag' && host.registryFile) {
        // Whatever the host's entry kind is: .js files for RPG Maker, top-level
        // folder names for UE4SS.
        const wanted = EXT_BY_ENTRY[host.layout.entry];
        const names = [
          ...new Set(
            written
              .map((entry) => entry.path.slice(host.dir.length + 1))
              .filter((rel) => rel.length > 0)
              .map((rel) => (wanted.length > 0 ? rel : rel.split('/')[0]!))
              .filter((rel) => (wanted.length > 0 ? wanted.some((e) => rel.toLowerCase().endsWith(e)) : true))
              .map((rel) => (wanted.length > 0 ? path.basename(rel, path.extname(rel)) : rel)),
          ),
        ];

        if (names.length > 0) {
          const format = formatFor(host);
          const patched = await tx.patch(host.registryFile, (text) => {
            let updated = text;
            for (const name of names) {
              if (!format.parse(updated).some((r) => r.name === name)) updated = format.append(updated, name);
            }
            return updated;
          });
          if (patched) log.info(`Registered ${names.join(', ')} in ${host.registryFile}`);
        }
      }

      return written.map((entry) => entry.path);
    },
  );

  if (options.dryRun) return { files: result, host };

  const receipt = await writeReceipt(profile.path, {
    kind: 'mod',
    componentId: name,
    version: 'local',
    entries,
  });
  return { receipt, files: result, host };
}

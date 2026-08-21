import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GameProfile, InstallReceipt, LoaderDef, Registry } from '../types.ts';
import { ensureDir, pathExists } from '../util/fsx.ts';
import type { Logger } from '../util/log.ts';
import { silentLogger } from '../util/log.ts';
import { BACKUP_DIR, writeReceipt } from '../install/apply.ts';
import { withTransaction } from '../install/transaction.ts';
import { extractZip } from '../install/unzip.ts';

export interface ModLayout {
  dir: string;
  altDir?: string;
  entry: 'dll' | 'dll-or-folder' | 'folder' | 'js' | 'rpy';
  disable: 'rename-suffix' | 'move-to-disabled' | 'registry-flag';
  disabledSuffix?: string;
  disabledDir?: string;
  registryFile?: string;
  altRegistryFile?: string;
  manifest?: string;
  extraDirs?: string[];
  filePrefix?: string;
  note?: string;
}

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
    const layout = (loader as LoaderDef & { modLayout?: ModLayout }).modLayout;
    if (!layout) continue;
    if (!engineLoaders.includes(loader.id)) continue;
    // Native hosts (RPG Maker plugins, Ren'Py game/) always apply; external
    // loaders only count once they are actually installed.
    const isNative = loader.install.kind === 'native';
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
      const records = new Map(parsePluginsJs(text).map((r) => [r.name, r.status]));
      for (const name of names.filter((n) => n.toLowerCase().endsWith('.js'))) {
        const id = name.replace(/\.js$/i, '');
        out.push({
          id,
          name: id,
          file: `${host.dir}/${name}`,
          enabled: records.get(id) ?? false,
          isDirectory: false,
          loaderId: host.loader.id,
          managedByIndieDeck: id.startsWith('indiedeck_'),
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
    const updated = setPluginStatus(text, mod.id, enabled);
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
        const jsFiles = written
          .map((entry) => entry.path)
          .filter((file) => file.toLowerCase().endsWith('.js'))
          .map((file) => path.basename(file, '.js'));

        if (jsFiles.length > 0) {
          const patched = await tx.patch(host.registryFile, (text) => {
            let updated = text;
            for (const plugin of jsFiles) {
              if (!parsePluginsJs(updated).some((r) => r.name === plugin)) updated = appendPlugin(updated, plugin);
            }
            return updated;
          });
          if (patched) log.info(`Registered ${jsFiles.join(', ')} in ${host.registryFile}`);
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

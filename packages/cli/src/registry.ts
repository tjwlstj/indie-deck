/**
 * The command table.
 *
 * One entry per command: its name, aliases, group, the summary shown in help,
 * its flags, and the function that runs it. Help is rendered from this, and so
 * is the dispatch map - so adding a command is one object here rather than
 * three edits that can drift apart.
 */

import { t } from '@indiedeck/core';
import {
  cmdCheck,
  cmdConfig,
  cmdDetect,
  cmdInfo,
  cmdInstall,
  cmdList,
  cmdMods,
  cmdPlan,
  cmdRegistry,
  cmdRoot,
  cmdScan,
  cmdStats,
  cmdUninstall,
  type Ctx,
} from './commands.ts';

export type CommandGroup = 'library' | 'translation' | 'mods' | 'registry';

export interface CommandDef {
  name: string;
  aliases?: string[];
  group: CommandGroup;
  /** Argument spec shown after the name, e.g. `<game|path>`. */
  args?: string;
  /** Catalogue key for the one-line summary; the English text is the fallback. */
  summaryKey: string;
  summary: string;
  /** Flags shown under the summary, dimmed. Not translated: they are literal. */
  flags?: string;
  run: (ctx: Ctx) => Promise<number>;
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'scan',
    group: 'library',
    args: '[path...]',
    summaryKey: 'cli.help.scan',
    summary: 'Scan roots for games and save the index',
    flags: '--depth N --deep --size --merge',
    run: cmdScan,
  },
  {
    name: 'list',
    aliases: ['ls'],
    group: 'library',
    args: '[query]',
    summaryKey: 'cli.help.list',
    summary: 'List indexed games',
    flags: '--engine unity --backend il2cpp --translated --untranslated',
    run: cmdList,
  },
  {
    name: 'info',
    group: 'library',
    args: '<game|path>',
    summaryKey: 'cli.help.info',
    summary: 'Everything detected about one game',
    run: cmdInfo,
  },
  {
    name: 'detect',
    group: 'library',
    args: '<path>',
    summaryKey: 'cli.help.detect',
    summary: 'Detect a folder without touching the library',
    run: cmdDetect,
  },
  {
    name: 'stats',
    group: 'library',
    summaryKey: 'cli.help.stats',
    summary: 'Library breakdown by engine',
    run: cmdStats,
  },
  {
    name: 'check',
    aliases: ['doctor'],
    group: 'library',
    args: '[game]',
    summaryKey: 'cli.help.check',
    summary: 'Find broken setups: wrong TMP font for the Unity version, stacked loaders, orphaned plugin files, outdated translator versions',
    flags: '--verbose --limit N',
    run: cmdCheck,
  },
  {
    name: 'root',
    group: 'library',
    args: 'add|remove|list <path>',
    summaryKey: 'cli.help.root',
    summary: 'Manage library roots',
    run: cmdRoot,
  },
  {
    name: 'plan',
    group: 'translation',
    args: '<game|path>',
    summaryKey: 'cli.help.plan',
    summary: 'Rank translator options with compatibility findings',
    flags: '--lang ko --from ja --endpoint DeepLTranslate --all --limit N',
    run: cmdPlan,
  },
  {
    name: 'install',
    group: 'translation',
    args: '<game|path>',
    summaryKey: 'cli.help.install',
    summary: 'Install the best plan (loader + translator + config)',
    flags: '--translator id --variant id --version v --dry-run --yes --allow-run',
    run: cmdInstall,
  },
  {
    name: 'config',
    group: 'translation',
    args: '<game>',
    summaryKey: 'cli.help.config',
    summary: 'Read or change translator settings by semantic id, checked against the version actually installed',
    flags: '--set id=value --dry-run --expert --reveal --providers',
    run: cmdConfig,
  },
  {
    name: 'uninstall',
    aliases: ['remove'],
    group: 'translation',
    args: '<game> [component]',
    summaryKey: 'cli.help.uninstall',
    summary: 'Remove what IndieDeck installed, restore backups',
    flags: '--dry-run',
    run: cmdUninstall,
  },
  {
    name: 'mods',
    group: 'mods',
    args: 'list|add|enable|disable <game> [mod]',
    summaryKey: 'cli.help.mods',
    summary: 'List mods across every host, install one from a file, or toggle one',
    flags: '--loader id --name id --dry-run',
    run: cmdMods,
  },
  {
    name: 'registry',
    group: 'registry',
    args: 'check|show',
    summaryKey: 'cli.help.registry',
    summary: 'Validate the registry, or list engines and what can be installed on them',
    flags: '--online  compare pinned versions against upstream releases',
    run: cmdRegistry,
  },
];

const GROUP_KEYS: Record<CommandGroup, { key: string; english: string }> = {
  library: { key: 'cli.section.library', english: 'LIBRARY' },
  translation: { key: 'cli.section.translation', english: 'TRANSLATION' },
  mods: { key: 'cli.section.mods', english: 'MODS' },
  registry: { key: 'cli.section.registry', english: 'REGISTRY' },
};

export function groupLabel(group: CommandGroup): string {
  const entry = GROUP_KEYS[group];
  return t(entry.key, undefined, entry.english);
}

/** name and every alias -> the command, for dispatch. */
export function commandMap(): Map<string, CommandDef> {
  const map = new Map<string, CommandDef>();
  for (const command of COMMANDS) {
    map.set(command.name, command);
    for (const alias of command.aliases ?? []) map.set(alias, command);
  }
  return map;
}

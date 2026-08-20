#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { loadRegistry } from '@indiedeck/core';
import { setColorEnabled } from './ansi.ts';
import { c } from './ui.ts';
import {
  cmdCheck,
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
  type Flags,
} from './commands.ts';

const VERSION = '0.1.0';

const HELP = `
${c.bold('indiedeck')} ${c.dim(`v${VERSION}`)} - one launcher for Unity and other indie games

${c.bold('LIBRARY')}
  scan [path...]              Scan roots for games and save the index
                              ${c.dim('--depth N --deep --size --merge')}
  list [query]                List indexed games
                              ${c.dim('--engine unity --backend il2cpp --translated --untranslated')}
  info <game|path>            Everything detected about one game
  detect <path>               Detect a folder without touching the library
  stats                       Library breakdown by engine
  check [game]                Find broken setups: wrong TMP font for the Unity
                              version, stacked loaders, orphaned plugin files,
                              outdated translator versions ${c.dim('--verbose --limit N')}
  root add|remove|list <path> Manage library roots

${c.bold('TRANSLATION')}
  plan <game|path>            Rank translator options with compatibility findings
                              ${c.dim('--lang ko --from ja --endpoint DeepLTranslate --all --limit N')}
  install <game|path>         Install the best plan (loader + translator + config)
                              ${c.dim('--translator id --variant id --version v --dry-run --yes --allow-run')}
  uninstall <game> [component] Remove what IndieDeck installed, restore backups
                              ${c.dim('--dry-run')}

${c.bold('MODS')}
  mods list <game>            List mods across every host for that game
  mods add <game> <file>      Install a .zip/.dll/.js mod into the right folder
  mods enable|disable <game> <mod>

${c.bold('REGISTRY')}
  registry check              Validate the registry ${c.dim('--online  compare pinned vs upstream releases')}
  registry show               Engines and what can be installed on them

${c.bold('GLOBAL')}
  --json                      Machine-readable output
  --no-color                  Disable colour (or set NO_COLOR)
  -h, --help                  This text
  -v, --version               Version

${c.dim('Data lives in ~/.indiedeck (override with INDIEDECK_HOME).')}
${c.dim('Registry lives in ./registry (override with INDIEDECK_REGISTRY).')}
`;

export function parseArgs(argv: string[]): { command: string; args: string[]; flags: Flags } {
  const flags: Flags = {};
  const args: string[] = [];
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s);
      const key = rawKey!;
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const short: Record<string, string> = { h: 'help', v: 'version', j: 'json' };
      for (const ch of token.slice(1)) flags[short[ch] ?? ch] = true;
      continue;
    }
    if (!command) command = token;
    else args.push(token);
  }
  return { command, args, flags };
}

const COMMANDS: Record<string, (ctx: Ctx) => Promise<number>> = {
  scan: cmdScan,
  list: cmdList,
  ls: cmdList,
  info: cmdInfo,
  detect: cmdDetect,
  plan: cmdPlan,
  install: cmdInstall,
  uninstall: cmdUninstall,
  remove: cmdUninstall,
  mods: cmdMods,
  root: cmdRoot,
  registry: cmdRegistry,
  stats: cmdStats,
  check: cmdCheck,
  doctor: cmdCheck,
};

export async function main(argv: string[]): Promise<number> {
  const { command, args, flags } = parseArgs(argv);

  if (flags['no-color'] === true || flags['json'] === true) setColorEnabled(false);
  else if (flags['color'] === true) setColorEnabled(true);

  if (flags['version']) {
    console.log(VERSION);
    return 0;
  }
  if (!command || flags['help'] || command === 'help') {
    console.log(HELP);
    return command && command !== 'help' ? 1 : 0;
  }

  const run = COMMANDS[command];
  if (!run) {
    console.error(`${c.red('unknown command')} "${command}" - run \`indiedeck --help\``);
    return 2;
  }

  let reg;
  try {
    reg = loadRegistry();
  } catch (err) {
    console.error(c.red((err as Error).message));
    return 3;
  }

  try {
    return await run({ reg, args, flags, json: flags['json'] === true });
  } catch (err) {
    const message = (err as Error).message;
    if (flags['json'] === true) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error(`${c.red('error:')} ${message}`);
    if (flags['trace']) console.error(err);
    return 1;
  }
}

// True when this file is the process entry point, whether run as compiled JS,
// as TypeScript via node's type stripping, or through the `indiedeck` bin shim.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const invokedDirectly = entry !== '' && path.resolve(import.meta.filename) === entry;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}

#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { loadConfig, loadRegistry, setLocale, t } from '@indiedeck/core';
import { setColorEnabled } from './ansi.ts';
import { COMMANDS, commandMap, groupLabel, type CommandGroup } from './registry.ts';
import { c, pad, width } from './ui.ts';
import type { Flags } from './commands.ts';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };

/**
 * Help is rendered from the command table, not hand-aligned - which is what
 * keeps it honest when a command is added, and lets it lay out correctly when
 * the summaries are translated into a language with double-width characters.
 */
function renderHelp(): string {
  const lines: string[] = ['', `${c.bold('indiedeck')} ${c.dim(`v${VERSION}`)} - ${t('cli.tagline', undefined, 'one launcher for Unity and other indie games')}`];

  const signature = (command: (typeof COMMANDS)[number]): string =>
    command.args ? `${command.name} ${command.args}` : command.name;
  const column = Math.max(...COMMANDS.map((command) => width(signature(command)))) + 2;
  const indent = ' '.repeat(column + 2);

  const groups: CommandGroup[] = ['library', 'translation', 'mods', 'registry'];
  for (const group of groups) {
    lines.push('', c.bold(groupLabel(group)));
    for (const command of COMMANDS.filter((x) => x.group === group)) {
      const summary = t(command.summaryKey, undefined, command.summary);
      lines.push(`  ${pad(signature(command), column)}${wrap(summary, indent)}`);
      if (command.flags) lines.push(`${indent}${c.dim(command.flags)}`);
    }
  }

  lines.push(
    '',
    c.bold(t('cli.section.global', undefined, 'GLOBAL')),
    `  ${pad('--locale <code>', column)}${t('cli.help.locale', undefined, 'Output language (en, ko). Defaults to the saved preference, then the system language.')}`,
    `  ${pad('--json', column)}${t('cli.help.json', undefined, 'Machine-readable output')}`,
    `  ${pad('--no-color', column)}${t('cli.help.noColor', undefined, 'Disable colour (or set NO_COLOR)')}`,
    `  ${pad('-h, --help', column)}${t('cli.help.help', undefined, 'This text')}`,
    `  ${pad('-v, --version', column)}${t('cli.help.version', undefined, 'Version')}`,
    '',
    c.dim(t('cli.help.dataDir', undefined, 'Data lives in ~/.indiedeck (override with INDIEDECK_HOME).')),
    c.dim(t('cli.help.registryDir', undefined, 'Registry lives in ./registry (override with INDIEDECK_REGISTRY).')),
    c.dim(t('cli.help.localesDir', undefined, 'Translations live in ./locales (override with INDIEDECK_LOCALES).')),
    '',
  );
  return lines.join('\n');
}

/** Wraps a summary at ~62 visible columns, continuing under the same indent. */
function wrap(text: string, indent: string, limit = 62): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && width(current) + width(word) + 1 > limit) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join(`\n${indent}`);
}

const valueOptions = new Set([
  'locale', 'depth', 'engine', 'backend', 'limit', 'lang', 'from', 'endpoint',
  'translator', 'variant', 'set', 'loader', 'name',
]);

function parseCommandLine(argv: string[]) {
  const flags: Flags = {};
  const args: string[] = [];
  let command = '';
  let showVersion = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s);
      const key = rawKey!;
      // After plan/install, --version takes a translator pin. Elsewhere it is a global switch.
      const translatorVersion = key === 'version' && (command === 'plan' || command === 'install');
      if (key === 'version' && !translatorVersion && inlineValue !== '') {
        showVersion = true;
        continue;
      }
      const takesValue = valueOptions.has(key) || translatorVersion;
      const next = argv[i + 1];
      let value: string | boolean = inlineValue ?? (translatorVersion ? '' : true);
      if (inlineValue === undefined && takesValue && next !== undefined && !next.startsWith('-')) {
        value = next;
        i += 1;
      }
      // Repeating a switch leaves it enabled; repeated values such as --set accumulate.
      const existing = flags[key];
      if (existing === undefined || (existing === true && value === true)) flags[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else flags[key] = [existing, value];
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const short: Record<string, string> = { h: 'help', j: 'json' };
      for (const ch of token.slice(1)) {
        if (ch === 'v') showVersion = true;
        else flags[short[ch] ?? ch] = true;
      }
      continue;
    }
    if (!command) command = token;
    else args.push(token);
  }
  if (showVersion) flags['version'] ??= true;
  return { parsed: { command, args, flags }, showVersion };
}

export function parseArgs(argv: string[]): { command: string; args: string[]; flags: Flags } {
  return parseCommandLine(argv).parsed;
}

export async function main(argv: string[]): Promise<number> {
  const { parsed: { command, args, flags }, showVersion } = parseCommandLine(argv);

  if (flags['no-color'] === true || flags['json'] === true) setColorEnabled(false);
  else if (flags['color'] === true) setColorEnabled(true);

  // Language: --locale wins, then the saved preference, then the environment.
  const localeFlag = typeof flags['locale'] === 'string' ? (flags['locale'] as string) : undefined;
  try {
    setLocale(localeFlag ?? (await loadConfig()).locale);
  } catch {
    setLocale(localeFlag);
  }

  if (showVersion) {
    console.log(VERSION);
    return 0;
  }
  if (!command || flags['help'] || command === 'help') {
    console.log(renderHelp());
    return 0;
  }
  const version = flags['version'];
  if ((command === 'plan' || command === 'install') && version !== undefined &&
      (typeof version !== 'string' || version.length === 0)) {
    console.error(t('cli.msg.translatorVersionExpected', undefined, '--version expects one translator version.'));
    return 2;
  }

  const found = commandMap().get(command);
  if (!found) {
    console.error(`${c.red(t('cli.msg.unknownCommand', undefined, 'unknown command'))} "${command}" - run \`indiedeck --help\``);
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
    return await found.run({ reg, args, flags, json: flags['json'] === true });
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

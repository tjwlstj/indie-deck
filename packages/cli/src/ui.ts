import { sgr, stripAnsi } from './ansi.ts';


const code = sgr;

export const c = {
  bold: code(1, 22),
  dim: code(2, 22),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  magenta: code(35, 39),
  cyan: code(36, 39),
  gray: code(90, 39),
};

/** Visible width, counting CJK/emoji as two columns and ignoring ANSI. */
export function width(text: string): number {
  const plain = stripAnsi(text);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}

export function pad(text: string, target: number): string {
  const diff = target - width(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text;
  let out = '';
  for (const ch of text) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export interface Column {
  header: string;
  key: string;
  max?: number;
  align?: 'left' | 'right';
}

export function table(rows: Record<string, string>[], columns: Column[]): string {
  if (rows.length === 0) return c.dim('  (nothing to show)');
  const widths = columns.map((col) => {
    const cells = [col.header, ...rows.map((r) => r[col.key] ?? '')];
    const natural = Math.max(...cells.map(width));
    return col.max ? Math.min(natural, col.max) : natural;
  });

  const line = (cells: string[]) =>
    '  ' +
    cells
      .map((cell, i) => {
        const w = widths[i]!;
        const text = truncate(cell, w);
        return columns[i]!.align === 'right' ? ' '.repeat(Math.max(0, w - width(text))) + text : pad(text, w);
      })
      .join('  ')
      .trimEnd();

  const head = c.bold(line(columns.map((col) => col.header)));
  const rule = c.dim('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  return [head, rule, ...rows.map((r) => line(columns.map((col) => r[col.key] ?? '')))].join('\n');
}

export function heading(text: string): string {
  return `\n${c.bold(text)}`;
}

export function bullet(text: string, tone: 'ok' | 'warn' | 'err' | 'info' = 'info'): string {
  const mark = { ok: c.green('✓'), warn: c.yellow('!'), err: c.red('×'), info: c.blue('•') }[tone];
  return `  ${mark} ${text}`;
}

export function severityTone(severity: string): 'ok' | 'warn' | 'err' | 'info' {
  if (severity === 'block') return 'err';
  if (severity === 'warn') return 'warn';
  return 'info';
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function engineBadge(engineId: string): string {
  const tone: Record<string, (t: string) => string> = {
    unity: c.cyan,
    renpy: c.magenta,
    'rpgmaker-mv': c.yellow,
    'rpgmaker-mz': c.yellow,
    'rpgmaker-rgss': c.yellow,
    'wolf-rpg': c.yellow,
    godot: c.blue,
    unreal: c.blue,
    gamemaker: c.green,
  };
  return (tone[engineId] ?? c.gray)(engineId);
}

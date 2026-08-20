/**
 * Minimal INI reader/writer that preserves comments, ordering and unknown keys.
 * XUnity.AutoTranslator regenerates AutoTranslatorConfig.ini on launch and
 * documents every option with a trailing `;` comment - clobbering that file
 * with a re-serialised dictionary would throw all of it away, so edits are
 * applied line by line instead.
 */

export type IniData = Record<string, Record<string, string>>;

export function parseIni(text: string): IniData {
  const out: IniData = {};
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+?)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.trim();
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).split(';')[0]!.trim();
    out[section] ??= {};
    out[section]![key] = value;
  }
  return out;
}

/**
 * Applies `changes` to `text`, keeping every other byte intact.
 * Missing sections and keys are appended; existing ones are rewritten in place
 * with their inline comment preserved.
 */
export function applyIni(text: string, changes: IniData): string {
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const pending = new Map<string, Map<string, string>>();
  for (const [section, kv] of Object.entries(changes)) {
    pending.set(section.toLowerCase(), new Map(Object.entries(kv)));
  }

  let current = '';
  const sectionEnd = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const sec = /^\[(.+?)\]$/.exec(trimmed);
    if (sec) {
      current = sec[1]!.trim().toLowerCase();
      sectionEnd.set(current, i);
      continue;
    }
    if (trimmed) sectionEnd.set(current, i);
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const wanted = pending.get(current);
    if (!wanted) continue;
    const match = [...wanted.keys()].find((k) => k.toLowerCase() === key.toLowerCase());
    if (match === undefined) continue;
    const rest = line.slice(eq + 1);
    const commentAt = rest.indexOf(';');
    const comment = commentAt >= 0 ? rest.slice(commentAt) : '';
    lines[i] = `${key}=${wanted.get(match)}${comment ? ` ${comment.trim()}` : ''}`;
    wanted.delete(match);
  }

  // Insert leftovers: into an existing section if it exists, else append one.
  for (const [section, kv] of [...pending.entries()].reverse()) {
    if (kv.size === 0) continue;
    const at = sectionEnd.get(section);
    const additions = [...kv.entries()].map(([k, v]) => `${k}=${v}`);
    if (at === undefined) {
      const original = Object.keys(changes).find((s) => s.toLowerCase() === section) ?? section;
      lines.push('', `[${original}]`, ...additions);
    } else {
      lines.splice(at + 1, 0, ...additions);
    }
  }

  return lines.join(eol);
}

export function stringifyIni(data: IniData): string {
  const out: string[] = [];
  for (const [section, kv] of Object.entries(data)) {
    out.push(`[${section}]`);
    for (const [k, v] of Object.entries(kv)) out.push(`${k}=${v}`);
    out.push('');
  }
  return out.join('\r\n');
}

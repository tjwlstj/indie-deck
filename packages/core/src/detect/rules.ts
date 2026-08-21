import path from 'node:path';
import type { DetectionRule, EngineDef, EngineMatch } from '../types.ts';
import { tRegistry } from '../i18n/index.ts';
import { FsProbe, matchesGlob } from '../util/fsx.ts';

/** Expands `$capture` references inside a rule path. Returns undefined when unresolved. */
function resolveRef(value: string, captures: Record<string, string>): string | undefined {
  if (!value.startsWith('$')) return value;
  return captures[value.slice(1)];
}

function asArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function matchDirGlob(probe: FsProbe, pattern: string): string | undefined {
  const segments = pattern.split('/').filter(Boolean);
  let candidates = [''];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of candidates) {
      if (segment.includes('*')) {
        for (const name of probe.namesIn(base)) {
          const rel = base ? `${base}/${name}` : name;
          if (matchesGlob(name, segment) && probe.hasDir(rel)) next.push(rel);
        }
      } else {
        const rel = base ? `${base}/${segment}` : segment;
        if (probe.hasDir(rel)) next.push(rel);
      }
    }
    if (next.length === 0) return undefined;
    candidates = next;
  }
  return candidates[0];
}

function matchFileGlobRecursive(probe: FsProbe, pattern: string, maxDepth: number): string | undefined {
  const queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!;
    for (const name of probe.namesIn(rel)) {
      const child = rel ? `${rel}/${name}` : name;
      if (probe.hasDir(child)) {
        if (depth < maxDepth) queue.push({ rel: child, depth: depth + 1 });
      } else if (matchesGlob(name, pattern)) {
        return child;
      }
    }
  }
  return undefined;
}

/** Evaluates one rule; returns the matched path when it hits. */
export function evaluateRule(
  probe: FsProbe,
  rule: DetectionRule,
  captures: Record<string, string>,
  exeNames: string[],
): string | undefined {
  switch (rule.kind) {
    case 'file': {
      const rel = String(rule.value);
      return probe.hasFile(rel) ? rel : undefined;
    }
    case 'fileAny':
      return asArray(rule.value).find((v) => probe.hasFile(v));
    case 'fileGlob': {
      const pattern = String(rule.value);
      if (rule.recursive) return matchFileGlobRecursive(probe, pattern, 3);
      return probe.namesIn('').find((n) => matchesGlob(n, pattern) && probe.hasFile(n));
    }
    case 'fileUnder': {
      const dir = resolveRef(rule.dir ?? '', captures);
      if (dir === undefined) return undefined;
      const rel = path.posix.join(dir.replace(/\\/g, '/'), String(rule.value));
      return probe.hasFile(rel) ? rel : undefined;
    }
    case 'dir': {
      const rel = String(rule.value);
      return probe.hasDir(rel) ? rel : undefined;
    }
    case 'dirAny':
      return asArray(rule.value).find((v) => probe.hasDir(v));
    case 'dirGlob':
      return matchDirGlob(probe, String(rule.value));
    case 'dirSuffix': {
      const suffix = String(rule.value).toLowerCase();
      return probe.namesIn('').find((n) => n.toLowerCase().endsWith(suffix) && probe.hasDir(n));
    }
    case 'extRoot': {
      const ext = String(rule.value).toLowerCase();
      return probe.namesIn('').find((n) => n.toLowerCase().endsWith(ext) && probe.hasFile(n));
    }
    case 'extUnder': {
      const dir = resolveRef(rule.dir ?? '', captures);
      if (dir === undefined) return undefined;
      const ext = String(rule.value).toLowerCase();
      const hit = probe.namesIn(dir).find((n) => n.toLowerCase().endsWith(ext));
      return hit ? `${dir}/${hit}` : undefined;
    }
    case 'exeSiblingExt': {
      const ext = String(rule.value).toLowerCase();
      for (const exe of exeNames) {
        const base = exe.replace(/\.exe$/i, '');
        if (probe.hasFile(base + ext)) return base + ext;
      }
      return undefined;
    }
    case 'exeSiblingSuffix': {
      const suffix = String(rule.value).toLowerCase();
      for (const exe of exeNames) {
        const base = exe.replace(/\.exe$/i, '');
        if (probe.hasFile(base + suffix)) return base + suffix;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Scores a single engine definition against a folder. */
export function scoreEngine(probe: FsProbe, engine: EngineDef, exeNames: string[]): EngineMatch {
  const captures: Record<string, string> = {};
  const matched: EngineMatch['matched'] = [];
  let score = 0;

  for (const rule of engine.rules) {
    const hit = evaluateRule(probe, rule, captures, exeNames);
    if (hit === undefined) continue;
    score += rule.score;
    matched.push({ rule: rule.kind, value: hit, score: rule.score });
    if (rule.capture) captures[rule.capture] = hit;
  }

  return {
    engineId: engine.id,
    name: tRegistry(`registry.engines.${engine.id}.name`, engine.displayName ?? engine.name),
    score,
    matched,
    captures,
  };
}

/** Ranks every engine definition; highest score first, `priority` breaks ties. */
export function rankEngines(probe: FsProbe, engines: EngineDef[], exeNames: string[]): EngineMatch[] {
  const priority = new Map(engines.map((e) => [e.id, e.priority]));
  return engines
    .map((e) => scoreEngine(probe, e, exeNames))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || (priority.get(b.engineId) ?? 0) - (priority.get(a.engineId) ?? 0));
}

import path from 'node:path';
import process from 'node:process';
import {
  addRoot,
  applyPlan,
  auditGame,
  auditLibrary,
  summariseAudit,
  readGameConfig,
  planConfigChanges,
  redactConfigPlan,
  writeGameConfig,
  type ConfigSchema,
  createLogger,
  defaultCacheDir,
  defaultDataDir,
  detectGame,
  findGames,
  installModFromFile,
  latestReleaseTag,
  libraryStats,
  isNativeLoader,
  localiseProfile,
  listMods,
  loadConfig,
  loadLibrary,
  loadRegistry,
  modHosts,
  readReceipts,
  refreshLibrary,
  removeRoot,
  resolveGameArg,
  resolvePlans,
  summarisePlans,
  uninstallReceipt,
  validateRegistry,
  type GameProfile,
  type Registry,
  type ResolveOptions,
  type TranslatorPlan,
} from '@indiedeck/core';
import { t } from '@indiedeck/core';
import { CSI } from './ansi.ts';
import { bullet, c, engineBadge, formatBytes, heading, severityTone, table } from './ui.ts';

const CLEAR_LINE = `${CSI}K`;

export interface Flags {
  [key: string]: string | boolean | (string | boolean)[] | undefined;
}

export interface Ctx {
  reg: Registry;
  args: string[];
  flags: Flags;
  json: boolean;
}

const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === 'string' ? (flags[key] as string) : undefined);
const bool = (flags: Flags, key: string): boolean => flags[key] === true;

function out(ctx: Ctx, data: unknown, render: () => void): void {
  if (ctx.json) console.log(JSON.stringify(data, null, 2));
  else render();
}

async function resolveOptions(ctx: Ctx): Promise<ResolveOptions> {
  const config = await loadConfig();
  const options: ResolveOptions = {
    targetLanguage: str(ctx.flags, 'lang') ?? config.defaults.targetLanguage,
    sourceLanguage: str(ctx.flags, 'from') ?? config.defaults.sourceLanguage,
    endpoint: str(ctx.flags, 'endpoint') ?? config.defaults.endpoint,
    allowPrerelease: !bool(ctx.flags, 'stable-only'),
    includeNonViable: bool(ctx.flags, 'all'),
  };
  const translator = str(ctx.flags, 'translator');
  const variant = str(ctx.flags, 'variant');
  const version = str(ctx.flags, 'version');
  if (translator) options.translatorId = translator;
  if (variant) options.variantId = variant;
  if (version) options.version = version;
  return options;
}

/* -------------------------------------------------------------------- scan */

export async function cmdScan(ctx: Ctx): Promise<number> {
  const config = await loadConfig();
  const roots = ctx.args.length > 0 ? ctx.args : config.roots;
  if (roots.length === 0) {
    console.error(
      `${c.red(t('cli.msg.noRoots', undefined, 'No roots to scan.'))} ${t('cli.msg.passPath', undefined, 'Pass a path, or register one with `indiedeck root add <path>`.')}`,
    );
    return 2;
  }

  const depth = Number(str(ctx.flags, 'depth') ?? config.scanDepth);
  let seen = 0;
  const started = Date.now();

  const index = await refreshLibrary(ctx.reg, {
    roots,
    depth,
    deep: bool(ctx.flags, 'deep'),
    measureSize: bool(ctx.flags, 'size'),
    merge: bool(ctx.flags, 'merge'),
    onProgress: (current) => {
      seen += 1;
      if (!ctx.json && process.stderr.isTTY && seen % 10 === 0) {
        process.stderr.write(`\r${c.dim(`scanning ${seen} folders… ${path.basename(current).slice(0, 40)}`)}${CLEAR_LINE}`);
      }
    },
  });
  if (!ctx.json && process.stderr.isTTY) process.stderr.write(`\r${CLEAR_LINE}`);

  out(ctx, index, () => {
    const stats = libraryStats(index);
    console.log(
      c.green(
        t(
          'cli.msg.scanned',
          {
            roots: roots.length,
            seconds: ((Date.now() - started) / 1000).toFixed(1),
            count: stats.total,
            path: path.join(defaultDataDir(), 'library.json'),
          },
          'Scanned {roots} root(s) in {seconds}s - {count} games found, saved to {path}',
        ),
      ),
    );
    console.log(heading(t('cli.heading.byEngine', undefined, 'By engine')));
    console.log(
      table(
        stats.byEngine.map((e) => ({ engine: engineBadge(e.engineId), name: e.engineName, count: String(e.count) })),
        [
          { header: t('cli.column.id', undefined, 'ID'), key: 'engine', max: 18 },
          { header: t('cli.column.engine', undefined, 'ENGINE'), key: 'name', max: 28 },
          { header: t('cli.column.games', undefined, 'GAMES'), key: 'count', align: 'right' },
        ],
      ),
    );
    console.log(
      `\n  ${c.dim(t('cli.msg.scanSummary', { translated: stats.withTranslator, loaders: stats.withLoader }, 'translator installed: {translated}  mod loader installed: {loaders}'))}` +
        (stats.byBackend['il2cpp'] || stats.byBackend['mono']
          ? `  ${c.dim(t('cli.msg.unityBackends', { mono: stats.byBackend['mono'] ?? 0, il2cpp: stats.byBackend['il2cpp'] ?? 0 }, 'unity mono/il2cpp: {mono}/{il2cpp}'))}`
          : ''),
    );
  });
  return 0;
}

/* -------------------------------------------------------------------- list */

export async function cmdList(ctx: Ctx): Promise<number> {
  const saved = await loadLibrary();
  const index = { ...saved, games: saved.games.map((g) => localiseProfile(ctx.reg, g)) };
  if (index.games.length === 0) {
    console.error(
      `${c.yellow(t('cli.msg.emptyLibrary', undefined, 'Library is empty.'))} ${t('cli.msg.runScanFirst', undefined, 'Run `indiedeck scan <path>` first.')}`,
    );
    return 2;
  }

  let games = index.games;
  const engine = str(ctx.flags, 'engine');
  const backend = str(ctx.flags, 'backend');
  const query = ctx.args[0];
  if (engine) games = games.filter((g) => g.engineId === engine || g.engineName.toLowerCase().includes(engine.toLowerCase()));
  if (backend) games = games.filter((g) => g.unity?.backend === backend);
  if (bool(ctx.flags, 'untranslated')) games = games.filter((g) => g.installedTranslators.length === 0);
  if (bool(ctx.flags, 'translated')) games = games.filter((g) => g.installedTranslators.length > 0);
  if (query) games = findGames({ ...index, games }, query);

  out(ctx, games, () => {
    console.log(
      table(
        games.map((g) => ({
          name: g.title && g.title !== g.name ? `${g.name} ${c.dim(`(${g.title})`)}` : g.name,
          engine: engineBadge(g.engineId),
          detail: [g.unity?.backend !== undefined && g.unity.backend !== 'unknown' ? g.unity.backend : '', g.unity?.version ?? g.engineVersion ?? '']
            .filter(Boolean)
            .join(' '),
          arch: g.arch === 'unknown' ? '' : g.arch,
          loader: g.installedLoaders
            .map((l) => l.loaderId)
            .filter((l) => !isNativeLoader(ctx.reg, l))
            .join(', '),
          translator: g.installedTranslators
            .map((t) => `${t.translatorId.replace('xunity-autotranslator', 'XUAT')}${t.version ? `@${t.version}` : ''}`)
            .join(', '),
        })),
        [
          { header: t('cli.column.game', undefined, 'GAME'), key: 'name', max: 44 },
          { header: t('cli.column.engine', undefined, 'ENGINE'), key: 'engine', max: 16 },
          { header: t('cli.column.runtime', undefined, 'RUNTIME'), key: 'detail', max: 20 },
          { header: t('cli.column.arch', undefined, 'ARCH'), key: 'arch', max: 6 },
          { header: t('cli.column.loader', undefined, 'LOADER'), key: 'loader', max: 18 },
          { header: t('cli.column.translator', undefined, 'TRANSLATOR'), key: 'translator', max: 26 },
        ],
      ),
    );
    console.log(c.dim(`\n  ${t('cli.msg.shownOfTotal', { shown: games.length, total: index.games.length }, '{shown} of {total} games')}`));
  });
  return 0;
}

/* -------------------------------------------------------------------- info */

export async function cmdInfo(ctx: Ctx): Promise<number> {
  const target = ctx.args[0];
  if (!target) {
    console.error('usage: indiedeck info <game|path>');
    return 2;
  }
  const profile = await resolveGameArg(ctx.reg, target, { deep: true });
  const receipts = await readReceipts(profile.path);
  const hosts = modHosts(ctx.reg, profile);

  out(ctx, { profile, receipts, modHosts: hosts.map((h) => ({ loader: h.loader.id, dir: h.dir })) }, () => {
    console.log(heading(profile.title ? `${profile.name}  ${c.dim(profile.title)}` : profile.name));
    console.log(c.dim(`  ${profile.path}`));
    console.log();
    console.log(bullet(`Engine     ${c.bold(profile.engineName)} ${c.dim(`(${profile.engineId}, confidence ${profile.confidence}%)`)}`));
    if (profile.unity) {
      console.log(
        bullet(
          `Unity      ${profile.unity.version ?? 'unknown version'} ${c.dim(`via ${profile.unity.versionSource ?? 'n/a'}`)} - backend ${c.bold(profile.unity.backend)}`,
        ),
      );
      const traits = [
        profile.unity.usesTextMeshPro === undefined ? '' : `TextMeshPro: ${profile.unity.usesTextMeshPro ? 'yes' : 'no'}`,
        profile.unity.usesNewInputSystem === undefined ? '' : `new Input System: ${profile.unity.usesNewInputSystem ? 'yes' : 'no'}`,
      ].filter(Boolean);
      if (traits.length > 0) console.log(bullet(`           ${c.dim(traits.join('  |  '))}`));
    } else if (profile.engineVersion) {
      console.log(bullet(`Version    ${profile.engineVersion}`));
    }
    console.log(bullet(`Executable ${profile.executable ?? c.dim('none found')} ${c.dim(`[${profile.arch}]`)}`));
    if (profile.sizeBytes) console.log(bullet(`Size       ${formatBytes(profile.sizeBytes)}`));

    console.log(heading(t('cli.heading.installed', undefined, 'Installed')));
    if (profile.installedLoaders.length === 0) console.log(bullet(t('cli.msg.noLoader', undefined, 'no mod loader'), 'info'));
    for (const l of profile.installedLoaders) {
      console.log(bullet(`loader      ${c.bold(l.loaderId)}${l.version ? ` ${l.version}` : ''} ${c.dim(l.markers[0] ?? '')}`, 'ok'));
    }
    for (const t of profile.installedTranslators) {
      console.log(
        bullet(
          `translator  ${c.bold(t.translatorId)}${t.version ? ` ${t.version}` : ''}${t.variantId ? c.dim(` (${t.variantId})`) : ''}${t.configPath ? c.dim(` cfg:${t.configPath}`) : ''}`,
          'ok',
        ),
      );
    }
    for (const f of profile.installedFontBundles) console.log(bullet(`font        ${f}`, 'ok'));
    if (profile.installedFontBundles.length > 1) {
      console.log(
        bullet(
          c.yellow(
            t(
              'cli.msg.severalFonts',
              undefined,
              'several TMP font bundles are present - only the one matching this Unity line will render',
            ),
          ),
          'warn',
        ),
      );
    }

    if (hosts.length > 0) {
      console.log(heading(t('cli.heading.modHosts', undefined, 'Mod hosts')));
      for (const h of hosts) console.log(bullet(`${h.loader.name} ${c.dim(`-> ${h.dir}`)}`));
    }
    if (receipts.length > 0) {
      console.log(heading(t('cli.heading.receipts', undefined, 'IndieDeck receipts')));
      for (const r of receipts) console.log(bullet(`${r.kind} ${r.componentId} ${r.version} ${c.dim(`${r.entries.length} files, ${r.installedAt.slice(0, 10)}`)}`));
    }
    for (const note of profile.notes) console.log(bullet(c.dim(note), 'info'));
  });
  return 0;
}

/* -------------------------------------------------------------------- plan */

function renderPlan(plan: TranslatorPlan, index: number): void {
  const status = plan.viable ? c.green('OK   ') : c.red('BLOCK');
  const loader = plan.loader
    ? `${plan.loader.name} ${plan.loader.version}${plan.loader.alreadyInstalled ? c.green(' [installed]') : ''}${plan.loader.channel !== 'stable' ? c.yellow(` [${plan.loader.channel}]`) : ''}`
    : c.dim('no loader needed');
  console.log(
    `\n ${status} ${c.dim(`#${index + 1}`)} ${c.bold(plan.translatorName)} ${c.bold(plan.version)} ${c.dim(`(${plan.variantName})`)}  score ${plan.score}`,
  );
  console.log(`        loader: ${loader}`);
  if (plan.fontBundle) {
    console.log(`        font:   ${plan.fontBundle.file} ${c.dim(`(${plan.fontBundle.confidence})`)}`);
  }
  for (const f of plan.findings) {
    console.log(`        ${bullet(`${c.dim(`[${f.confidence}]`)} ${f.message}`, severityTone(f.severity)).trim()}`);
  }
}

export async function cmdPlan(ctx: Ctx): Promise<number> {
  const target = ctx.args[0];
  if (!target) {
    console.error('usage: indiedeck plan <game|path> [--lang ko] [--from ja] [--endpoint DeepLTranslate] [--all]');
    return 2;
  }
  const profile = await resolveGameArg(ctx.reg, target, { deep: true });
  const options = await resolveOptions(ctx);
  const all = resolvePlans(ctx.reg, profile, options);
  const plans = bool(ctx.flags, 'all') ? all : summarisePlans(all).filter((p) => p.viable);

  out(ctx, { profile, options, plans }, () => {
    console.log(heading(`${profile.name}  ${c.dim(`${profile.engineName}${profile.unity ? ` / ${profile.unity.backend} ${profile.unity.version ?? ''}` : ''} ${profile.arch}`)}`));
    console.log(c.dim(`  target ${options.targetLanguage} <- ${options.sourceLanguage} via ${options.endpoint}`));
    if (plans.length === 0) {
      console.log(
        bullet(
          t('cli.msg.noViablePlan', undefined, 'No viable translator for this game. Try --all to see why each option was rejected.'),
          'warn',
        ),
      );
      return;
    }
    plans.slice(0, Number(str(ctx.flags, 'limit') ?? 8)).forEach(renderPlan);
    const best = plans.find((p) => p.viable);
    if (best) {
      console.log(
        `\n  ${c.dim(t('cli.msg.installWith', undefined, 'install it with:'))} indiedeck install ${JSON.stringify(profile.name)} --translator ${best.translatorId} --variant ${best.variantId} --version ${best.version}`,
      );
    }
  });
  return 0;
}

/* ----------------------------------------------------------------- install */

export async function cmdInstall(ctx: Ctx): Promise<number> {
  const target = ctx.args[0];
  if (!target) {
    console.error('usage: indiedeck install <game|path> [--translator id] [--variant id] [--version v] [--dry-run]');
    return 2;
  }
  const profile = await resolveGameArg(ctx.reg, target, { deep: true });
  const options = await resolveOptions(ctx);
  const plans = summarisePlans(resolvePlans(ctx.reg, profile, options));
  const plan = plans.find((p) => p.viable);

  if (!plan) {
    console.error(c.red(`No viable translator plan for ${profile.name}.`) + ' Run `indiedeck plan --all` to see the blockers.');
    return 1;
  }

  const dryRun = bool(ctx.flags, 'dry-run');
  const blocking = plan.findings.filter((f) => f.severity === 'warn');
  if (!ctx.json) {
    renderPlan(plan, 0);
    console.log();
    if (blocking.length > 0 && !bool(ctx.flags, 'yes') && !dryRun) {
      console.log(
        bullet(
          c.yellow(
            t(
              'cli.msg.warningsPresent',
              { count: blocking.length },
              '{count} warning(s) above. Re-run with --yes to proceed, or --dry-run to preview.',
            ),
          ),
          'warn',
        ),
      );
      return 1;
    }
  }

  const result = await applyPlan(plan, {
    dryRun,
    allowRun: bool(ctx.flags, 'allow-run'),
    logger: createLogger(ctx.json ? 'silent' : 'info', c.dim('  |')),
  });

  out(ctx, { plan, result }, () => {
    console.log(heading(dryRun ? t('cli.heading.dryRun', undefined, 'Dry run') : t('cli.heading.installed', undefined, 'Installed')));
    for (const step of result.performed) {
      const tone = step.status === 'done' ? 'ok' : step.status === 'pending-user' ? 'warn' : 'info';
      console.log(bullet(`${step.step.description} ${c.dim(step.detail ? `- ${step.detail}` : `- ${step.status}`)}`, tone));
    }
    if (result.pendingUserActions.length > 0) {
      console.log(heading(t('cli.heading.stillNeedsYou', undefined, 'Still needs you')));
      for (const action of result.pendingUserActions) console.log(bullet(action, 'warn'));
    }
    if (!dryRun) {
      console.log(
        `\n  ${c.green(t('cli.msg.filesWritten', { count: result.filesWritten.length }, '{count} files written'))}, ${t('cli.msg.receipts', { list: result.receipts.map((r) => `${r.kind}/${r.componentId}`).join(', ') || t('cli.msg.none', undefined, 'none') }, 'receipts: {list}')}`,
      );
    }
  });
  return 0;
}

/* --------------------------------------------------------------- uninstall */

export async function cmdUninstall(ctx: Ctx): Promise<number> {
  const [target, component] = ctx.args;
  if (!target) {
    console.error('usage: indiedeck uninstall <game|path> [componentId] [--dry-run]');
    return 2;
  }
  const profile = await resolveGameArg(ctx.reg, target);
  const receipts = await readReceipts(profile.path);
  if (receipts.length === 0) {
    console.error(
      `${c.yellow(t('cli.msg.noReceipts', { name: profile.name }, 'No IndieDeck receipts in {name}.'))} ${t('cli.msg.onlyIndieDeck', undefined, 'Only components installed through IndieDeck can be removed automatically.')}`,
    );
    return 1;
  }

  const selected = component ? receipts.filter((r) => r.componentId === component || r.kind === component) : receipts;
  if (selected.length === 0) {
    console.error(`No receipt for "${component}". Present: ${receipts.map((r) => r.componentId).join(', ')}`);
    return 1;
  }

  const dryRun = bool(ctx.flags, 'dry-run');
  const results: ({ receipt: string } & Awaited<ReturnType<typeof uninstallReceipt>>)[] = [];
  for (const receipt of selected) {
    results.push({ receipt: receipt.componentId, ...(await uninstallReceipt(receipt, { dryRun })) });
  }

  out(ctx, results, () => {
    for (const r of results) {
      console.log(bullet(`${r.receipt}: removed ${r.removed.length}, restored ${r.restored.length}, missing ${r.missing.length}`, 'ok'));
    }
    if (dryRun) console.log(c.dim(`  ${t('cli.msg.dryRunNothing', undefined, '(dry run - nothing was deleted)')}`));
  });
  return 0;
}

/* -------------------------------------------------------------------- mods */

export async function cmdMods(ctx: Ctx): Promise<number> {
  const [sub, target, ...rest] = ctx.args;
  if (!sub || !target) {
    console.error('usage: indiedeck mods <list|add|enable|disable> <game|path> [mod]');
    return 2;
  }
  const profile = await resolveGameArg(ctx.reg, target);

  if (sub === 'list') {
    const mods = await listMods(ctx.reg, profile);
    const hosts = modHosts(ctx.reg, profile);
    out(ctx, { mods, hosts: hosts.map((h) => ({ loader: h.loader.id, dir: h.dir })) }, () => {
      console.log(heading(`${profile.name} - mods`));
      if (hosts.length === 0) {
        console.log(
          bullet(t('cli.msg.noModHost', undefined, 'No mod host for this game. Install a loader first (see `indiedeck plan`).'), 'warn'),
        );
        return;
      }
      for (const h of hosts) console.log(c.dim(`  host: ${h.loader.name} -> ${h.dir}`));
      console.log();
      console.log(
        table(
          mods.map((m) => ({
            state: m.enabled ? c.green('on ') : c.dim('off'),
            name: m.name,
            kind: m.isDirectory ? 'folder' : 'file',
            loader: m.loaderId,
            size: formatBytes(m.sizeBytes),
          })),
          [
            { header: '', key: 'state', max: 4 },
            { header: t('cli.column.mod', undefined, 'MOD'), key: 'name', max: 46 },
            { header: t('cli.column.kind', undefined, 'KIND'), key: 'kind', max: 8 },
            { header: t('cli.column.host', undefined, 'HOST'), key: 'loader', max: 18 },
            { header: t('cli.column.size', undefined, 'SIZE'), key: 'size', align: 'right' },
          ],
        ),
      );
    });
    return 0;
  }

  if (sub === 'add') {
    const source = rest[0];
    if (!source) {
      console.error('usage: indiedeck mods add <game|path> <file.zip|file.dll>');
      return 2;
    }
    const loaderId = str(ctx.flags, 'loader');
    const installOptions: Parameters<typeof installModFromFile>[3] = { dryRun: bool(ctx.flags, 'dry-run') };
    if (loaderId) installOptions.loaderId = loaderId;
    const name = str(ctx.flags, 'name');
    if (name) installOptions.name = name;
    const result = await installModFromFile(ctx.reg, profile, source, installOptions);
    out(ctx, result, () => {
      console.log(
        bullet(t('cli.msg.installedInto', { dir: result.host.dir, count: result.files.length }, 'Installed into {dir} ({count} files)'), 'ok'),
      );
      for (const f of result.files.slice(0, 12)) console.log(c.dim(`    ${f}`));
    });
    return 0;
  }

  if (sub === 'enable' || sub === 'disable') {
    const modId = rest[0];
    if (!modId) {
      console.error(`usage: indiedeck mods ${sub} <game|path> <mod>`);
      return 2;
    }
    const { setModEnabled } = await import('@indiedeck/core');
    const result = await setModEnabled(ctx.reg, profile, modId, sub === 'enable', { dryRun: bool(ctx.flags, 'dry-run') });
    out(ctx, result, () => console.log(bullet(`${sub}d ${result.mod} (${result.strategy})`, 'ok')));
    return 0;
  }

  console.error(`unknown mods subcommand "${sub}"`);
  return 2;
}

/* -------------------------------------------------------------------- root */

export async function cmdRoot(ctx: Ctx): Promise<number> {
  const [sub, target] = ctx.args;
  const config = await loadConfig();

  if (!sub || sub === 'list') {
    out(ctx, config.roots, () => {
      console.log(heading(t('cli.heading.roots', undefined, 'Library roots')));
      if (config.roots.length === 0) console.log(bullet(t('ui.sidebar.noRoots', undefined, 'none configured'), 'warn'));
      for (const r of config.roots) console.log(bullet(r));
      console.log(c.dim(`\n  ${t('cli.msg.configAt', { path: path.join(defaultDataDir(), 'config.json') }, 'config: {path}')}`));
    });
    return 0;
  }
  if (!target) {
    console.error(`usage: indiedeck root ${sub} <path>`);
    return 2;
  }
  const updated = sub === 'add' ? await addRoot(target) : sub === 'remove' ? await removeRoot(target) : undefined;
  if (!updated) {
    console.error(`unknown root subcommand "${sub}"`);
    return 2;
  }
  out(ctx, updated.roots, () => console.log(bullet(`roots: ${updated.roots.join(', ') || 'none'}`, 'ok')));
  return 0;
}

/* ---------------------------------------------------------------- registry */

export async function cmdRegistry(ctx: Ctx): Promise<number> {
  const sub = ctx.args[0] ?? 'check';

  if (sub === 'check') {
    const issues = validateRegistry(ctx.reg);
    const online: { component: string; pinned: string; latest: string; stale: boolean }[] = [];

    if (bool(ctx.flags, 'online')) {
      const repos = new Map<string, string>();
      for (const t of ctx.reg.translators) if (t.repo && t.versions.length > 0) repos.set(t.repo, t.versions[0]!.version);
      for (const l of ctx.reg.loaders) {
        const gh = l.versions.find((v) => v.assets['x64']?.type === 'github-release')?.assets['x64'];
        if (gh?.repo) repos.set(gh.repo, l.versions[0]!.version);
      }
      for (const [repo, pinned] of repos) {
        try {
          const latest = await latestReleaseTag(repo);
          const clean = latest.tag.replace(/^v/, '');
          online.push({ component: repo, pinned, latest: clean, stale: !clean.startsWith(pinned) && !pinned.startsWith(clean) });
        } catch (err) {
          online.push({ component: repo, pinned, latest: `error: ${(err as Error).message}`, stale: false });
        }
      }
    }

    out(ctx, { issues, online, updated: ctx.reg.meta.updated }, () => {
      console.log(heading(t('cli.heading.registryCheck', undefined, 'Registry self-check')));
      console.log(
        bullet(
          t(
            'cli.msg.registryCounts',
            {
              engines: ctx.reg.engines.length,
              loaders: ctx.reg.loaders.length,
              translators: ctx.reg.translators.length,
              rules: ctx.reg.compat.rules.length,
              fonts: ctx.reg.fonts.bundles.length,
            },
            '{engines} engines, {loaders} loaders, {translators} translators, {rules} compat rules, {fonts} font bundles',
          ),
        ),
      );
      if (issues.length === 0) console.log(bullet(t('cli.msg.noStructuralIssues', undefined, 'no structural issues'), 'ok'));
      for (const i of issues) console.log(bullet(`${i.where}: ${i.message}`, i.level === 'error' ? 'err' : 'warn'));

      if (online.length > 0) {
        console.log(heading(t('cli.heading.upstream', undefined, 'Upstream releases')));
        console.log(
          table(
            online.map((o) => ({
              repo: o.component,
              pinned: o.pinned,
              latest: o.stale ? c.yellow(o.latest) : o.latest,
              state: o.stale ? c.yellow('behind') : c.green('current'),
            })),
            [
              { header: t('cli.column.repo', undefined, 'REPO'), key: 'repo', max: 40 },
              { header: t('cli.column.pinned', undefined, 'PINNED'), key: 'pinned', max: 16 },
              { header: t('cli.column.latest', undefined, 'LATEST'), key: 'latest', max: 20 },
              { header: '', key: 'state', max: 10 },
            ],
          ),
        );
      }
    });
    return issues.some((i) => i.level === 'error') ? 1 : 0;
  }

  if (sub === 'show') {
    out(ctx, ctx.reg, () => {
      console.log(heading(t('cli.heading.engines', undefined, 'Engines')));
      console.log(
        table(
          ctx.reg.engines.map((e) => ({
            id: engineBadge(e.id),
            name: e.name,
            loaders: e.loaders.join(', ') || c.dim('-'),
            translators: e.translators.join(', '),
          })),
          [
            { header: t('cli.column.id', undefined, 'ID'), key: 'id', max: 16 },
            { header: t('cli.column.engine', undefined, 'ENGINE'), key: 'name', max: 26 },
            { header: t('cli.column.loaders', undefined, 'LOADERS'), key: 'loaders', max: 40 },
            { header: t('cli.column.translators', undefined, 'TRANSLATORS'), key: 'translators', max: 46 },
          ],
        ),
      );
    });
    return 0;
  }

  console.error(`unknown registry subcommand "${sub}"`);
  return 2;
}

/* ------------------------------------------------------------------- stats */

export async function cmdStats(ctx: Ctx): Promise<number> {
  const saved = await loadLibrary();
  const index = { ...saved, games: saved.games.map((g) => localiseProfile(ctx.reg, g)) };
  const stats = libraryStats(index);
  out(ctx, stats, () => {
    console.log(heading(t('cli.heading.library', undefined, 'Library')));
    console.log(
      bullet(
        t(
          'cli.msg.scannedAt',
          { count: stats.total, when: index.scannedAt ? index.scannedAt.slice(0, 16).replace('T', ' ') : t('cli.msg.never', undefined, 'never') },
          '{count} games, scanned {when}',
        ),
      ),
    );
    console.log(
      table(
        stats.byEngine.map((e) => ({ engine: engineBadge(e.engineId), count: String(e.count), bar: '█'.repeat(Math.round((e.count / stats.total) * 30)) })),
        [
          { header: t('cli.column.engine', undefined, 'ENGINE'), key: 'engine', max: 20 },
          { header: t('cli.column.n', undefined, 'N'), key: 'count', align: 'right' },
          { header: '', key: 'bar', max: 30 },
        ],
      ),
    );
    console.log(
      bullet(t('cli.msg.scanSummary', { translated: stats.withTranslator, loaders: stats.withLoader }, 'translator installed: {translated}  mod loader installed: {loaders}')),
    );
    console.log(c.dim(`  ${t('cli.msg.cacheAt', { path: defaultCacheDir() }, 'cache: {path}')}`));
  });
  return 0;
}

/* ------------------------------------------------------------------ detect */

export async function cmdDetect(ctx: Ctx): Promise<number> {
  const target = ctx.args[0];
  if (!target) {
    console.error('usage: indiedeck detect <path>');
    return 2;
  }
  const profile: GameProfile | undefined = detectGame(ctx.reg, target, { deep: true, measureSize: bool(ctx.flags, 'size') });
  if (!profile) {
    console.error(c.red(`No known engine detected in ${path.resolve(target)}`));
    return 1;
  }
  return cmdInfo({ ...ctx, args: [profile.path] });
}

/* ------------------------------------------------------------------- check */

export async function cmdCheck(ctx: Ctx): Promise<number> {
  const options = await resolveOptions(ctx);
  const auditOptions = { targetLanguage: options.targetLanguage, endpoint: options.endpoint };
  const target = ctx.args[0];

  if (target) {
    const profile = await resolveGameArg(ctx.reg, target, { deep: true });
    const audit = auditGame(ctx.reg, profile, auditOptions);
    out(ctx, audit, () => {
      console.log(heading(t('cli.heading.issues', { name: profile.name, count: audit.issues.length }, '{name} - {count} issue(s)')));
      if (audit.issues.length === 0) console.log(bullet(t('cli.msg.nothingToFix', undefined, 'nothing to fix'), 'ok'));
      for (const i of audit.issues) {
        console.log(bullet(`${c.dim(`[${i.code}]`)} ${i.message}`, severityTone(i.severity)));
        if (i.fix) console.log(c.dim(`      -> ${i.fix}`));
      }
    });
    return audit.issues.some((i) => i.severity === 'block') ? 1 : 0;
  }

  const index = await loadLibrary();
  if (index.games.length === 0) {
    console.error(
      `${c.yellow(t('cli.msg.emptyLibrary', undefined, 'Library is empty.'))} ${t('cli.msg.runScanFirst', undefined, 'Run `indiedeck scan <path>` first.')}`,
    );
    return 2;
  }
  const audits = auditLibrary(ctx.reg, index.games, auditOptions);
  const summary = summariseAudit(audits);

  out(ctx, { summary, audits }, () => {
    console.log(
      heading(
        t(
          'cli.heading.libraryCheck',
          { count: summary.gamesWithIssues, total: index.games.length },
          'Library check - {count} of {total} games need attention',
        ),
      ),
    );
    console.log(
      table(
        summary.byCode.map((b) => ({ code: b.code, count: String(b.count), sev: b.severity })),
        [
          { header: t('cli.column.issue', undefined, 'ISSUE'), key: 'code', max: 32 },
          { header: t('cli.column.games', undefined, 'GAMES'), key: 'count', align: 'right' },
          { header: t('cli.column.severity', undefined, 'SEVERITY'), key: 'sev', max: 10 },
        ],
      ),
    );
    const limit = Number(str(ctx.flags, 'limit') ?? 15);
    for (const audit of audits.slice(0, limit)) {
      console.log(heading(audit.name));
      for (const i of audit.issues) {
        console.log(bullet(`${c.dim(`[${i.code}]`)} ${i.message}`, severityTone(i.severity)));
        if (i.fix && bool(ctx.flags, 'verbose')) console.log(c.dim(`      -> ${i.fix}`));
      }
    }
    if (audits.length > limit) console.log(c.dim(`\n  ${t('cli.msg.andMore', { count: audits.length - limit }, '... and {count} more (--limit N)')}`));
  });
  return 0;
}

/* ------------------------------------------------------------------ config */

function tierBadge(tier: string[]): string {
  if (tier.includes('official')) return c.green('official API');
  if (tier.includes('local')) return c.cyan('local');
  if (tier.includes('free')) return c.yellow('free') + (tier.includes('unofficial') ? c.dim(' / unofficial') : '');
  return c.dim(tier.join(', '));
}

export async function cmdConfig(ctx: Ctx): Promise<number> {
  const target = ctx.args[0];
  if (!target) {
    console.error('usage: indiedeck config <game|path> [--set id=value ...] [--dry-run] [--expert] [--reveal] [--providers]');
    return 2;
  }

  const profile = await resolveGameArg(ctx.reg, target, { deep: true });
  const schemas = ctx.reg.configSchemas as Map<string, ConfigSchema>;
  const translatorId =
    str(ctx.flags, 'translator') ??
    profile.installedTranslators.find((t) => schemas.has(t.translatorId))?.translatorId ??
    'xunity-autotranslator';

  const schema = schemas.get(translatorId);
  if (!schema) {
    console.error(c.red('error:') + ' no config schema for "' + translatorId + '".');
    return 1;
  }

  const config = await readGameConfig(ctx.reg, schemas, profile, translatorId, {
    revealSecrets: bool(ctx.flags, 'reveal'),
  });

  if (bool(ctx.flags, 'providers')) {
    out(ctx, config.providers, () => {
      console.log(heading(t('cli.heading.engineList', { translator: config.translatorName }, '{translator} - translation engines')));
      console.log(
        table(
          config.providers.map((p) => ({
            sel: p.selected ? c.green('*') : ' ',
            id: p.provider.id,
            label: p.provider.label,
            tier: tierBadge(p.provider.tier),
            needs: p.provider.fields.filter((f) => f.required).map((f) => f.label).join(', ') || c.dim(t('cli.msg.nothing', undefined, 'nothing')),
          })),
          [
            { header: '', key: 'sel', max: 2 },
            { header: t('cli.column.id', undefined, 'ID'), key: 'id', max: 26 },
            { header: t('cli.column.engine', undefined, 'ENGINE'), key: 'label', max: 28 },
            { header: t('cli.column.kind', undefined, 'KIND'), key: 'tier', max: 22 },
            { header: t('cli.column.requires', undefined, 'REQUIRES'), key: 'needs', max: 30 },
          ],
        ),
      );
      for (const p of config.providers) {
        if (!p.provider.languages) continue;
        console.log(c.dim('  ' + p.provider.label + ': ' + p.provider.languages.source.join('/') + ' -> ' + p.provider.languages.target.join('/')));
      }
    });
    return 0;
  }

  const rawSets = Array.isArray(ctx.flags['set']) ? ctx.flags['set'] : [ctx.flags['set']];
  const sets = rawSets
    .filter((v): v is string => typeof v === 'string')
    .map((pair) => {
      const at = pair.indexOf('=');
      if (at < 0) throw new Error('--set expects id=value, got "' + pair + '"');
      return { id: pair.slice(0, at).trim(), value: pair.slice(at + 1) };
    });

  if (sets.length === 0) {
    out(ctx, config, () => {
      console.log(heading(profile.name + ' - ' + config.translatorName));
      const version = config.detected.version ?? 'unknown';
      console.log(
        c.dim(
          '  ' +
            t(
              'cli.msg.versionFrom',
              { version, source: config.detected.source, confidence: config.detected.confidence },
              'version {version} (from {source}, {confidence})',
            ) +
            '  ·  ' +
            config.location.path +
            (config.location.exists ? '' : ' ' + c.yellow(t('cli.msg.notCreatedYet', undefined, '[not created yet]'))),
        ),
      );
      console.log(
        c.dim(
          '  ' +
            t(
              'cli.msg.schemaDescribes',
              { described: config.coverage.described, total: config.coverage.total },
              'schema describes {described} of {total} keys in the file',
            ),
        ),
      );
      for (const warning of config.warnings) console.log(bullet(warning.text, 'warn'));

      let category = '';
      for (const value of config.values) {
        if (value.category !== category) {
          category = value.category;
          const label = schema.categories.find((x) => x.id === category)?.label ?? category;
          console.log(heading(label));
        }
        const marker = value.isDefault ? c.dim(' ' + t('cli.msg.default', undefined, '(default)')) : '';
        const flags = [value.assumed ? c.yellow('assumed') : '', value.deprecated ? c.dim('deprecated') : '']
          .filter(Boolean)
          .join(' ');
        const shown = value.value === '' ? c.dim('(empty)') : value.value;
        console.log('  ' + c.dim(value.id.padEnd(38)) + ' ' + shown.padEnd(24) + marker + (flags ? ' ' + flags : ''));
      }

      const selected = config.providers.find((p) => p.selected);
      if (selected && selected.fields.length > 0) {
        console.log(heading(t('cli.heading.credentials', { provider: selected.provider.label }, '{provider} credentials')));
        for (const field of selected.fields) {
          const shown = field.value === '' ? c.dim('(empty)') : field.value;
          const missing = field.required && !field.value ? c.red('  required') : '';
          console.log('  ' + c.dim(('provider:' + selected.provider.id + ':' + field.key).padEnd(38)) + ' ' + shown + missing);
        }
        if (selected.provider.note) console.log(c.dim('  ' + selected.provider.note));
      }

      if (bool(ctx.flags, 'expert') && config.unknown.length > 0) {
        console.log(heading(t('cli.heading.undescribed', { count: config.unknown.length }, 'Keys IndieDeck does not describe ({count})')));
        console.log(c.dim('  ' + t('cli.msg.preservedNote', undefined, 'These are preserved exactly as they are on every write.')));
        for (const entry of config.unknown) console.log('  ' + c.dim('[' + entry.section + ']') + ' ' + entry.key + '=' + entry.value);
      } else if (config.unknown.length > 0) {
        console.log(c.dim('\n  ' + t('cli.msg.furtherKeys', { count: config.unknown.length }, '{count} further keys are preserved untouched (--expert to list them)')));
      }
      console.log(c.dim('\n  ' + t('cli.msg.changeHint', undefined, 'change one with: indiedeck config <game> --set xunity.targetLanguage=ko')));
    });
    return 0;
  }

  const plan = planConfigChanges(schema, config, sets, { fontBundles: profile.installedFontBundles });
  const publicPlan = redactConfigPlan(plan);
  const dryRun = bool(ctx.flags, 'dry-run');

  if (!ctx.json) {
    console.log(heading(dryRun ? t('cli.heading.plannedChanges', undefined, 'Planned changes') : t('cli.heading.changes', undefined, 'Changes')));
    for (const change of plan.changes) {
      const from = change.from === '' ? c.dim('(empty)') : change.from;
      const to = change.to === '' ? '(empty)' : change.to;
      console.log('  ' + c.dim('[' + change.section + ']') + ' ' + change.key + ': ' + from + ' ' + c.dim('->') + ' ' + c.bold(to));
    }
    for (const issue of plan.issues) {
      const tone = issue.severity === 'error' ? 'err' : issue.severity === 'warn' ? 'warn' : 'info';
      console.log(bullet(issue.message, tone));
    }
  }

  if (!plan.valid) {
    if (ctx.json) console.log(JSON.stringify({ plan: publicPlan, written: false }, null, 2));
    return 1;
  }
  if (plan.issues.some((i) => i.severity === 'warn') && !bool(ctx.flags, 'yes') && !dryRun) {
    console.log(bullet(c.yellow(t('cli.msg.reRunWithYes', undefined, 'Re-run with --yes to write these anyway, or --dry-run to preview.')), 'warn'));
    return 1;
  }

  const result = await writeGameConfig(profile, config, plan, { dryRun });
  out(ctx, { plan: publicPlan, result }, () => {
    if (dryRun) {
      console.log(c.dim('\n  ' + t('cli.msg.dryRunUntouched', { path: config.location.path }, 'dry run - {path} was not touched')));
      return;
    }
    console.log('\n  ' + c.green(t('cli.msg.configWritten', { count: result.changed }, '{count} setting(s) written')) + ' -> ' + result.path);
    if (result.backup) console.log(c.dim('  ' + t('cli.msg.backedUp', { path: result.backup }, 'original backed up to {path}')));
  });
  return 0;
}

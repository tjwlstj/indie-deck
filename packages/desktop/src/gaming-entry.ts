import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const GAME_ID = /^[0-9a-f]{16}$/;
const DESCRIPTION = 'IndieDeck managed gaming shortcut v1';
export const GAMING_SETTINGS = Object.freeze({
  xboxMode: 'ms-settings:gaming-fullscreen',
  gameMode: 'ms-settings:gaming-gamemode',
  gameBar: 'ms-settings:gaming-gamebar',
});
export type GamingSettingsAction = keyof typeof GAMING_SETTINGS;

export interface GamingEntry {
  valid: boolean; fullscreen: boolean; launchGameId?: string; reason?: 'invalid-arguments';
}
export interface GamingArgumentContext { packaged: boolean; executable: string; appPath?: string }

/** Parse only application arguments. Main must separately resolve a game id
 * against its current library and apply its normal launch/security gates. */
export function parseGamingEntryArgs(argv: unknown, context: GamingArgumentContext): GamingEntry {
  const invalid = (): GamingEntry => ({ valid: false, fullscreen: false, reason: 'invalid-arguments' });
  if (!Array.isArray(argv) || argv.length > 12 || argv.some(value => typeof value !== 'string' || value.length > 32767 || /[\u0000-\u001f\u007f]/u.test(value)) ||
      typeof context?.executable !== 'string' || !context.executable || argv.length === 0) return invalid();
  // process.argv[0] is the executable. Do not treat any renderer/user-supplied
  // first argument as an executable or use it to construct a process command.
  const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (!samePath(argv[0], context.executable)) return invalid();
  let offset = 1;
  if (!context.packaged) {
    if (!context.appPath || typeof argv[1] !== 'string' || !samePath(argv[1], context.appPath)) return invalid();
    offset = 2;
  }
  let fullscreen = false, launchGameId: string | undefined, updated = false;
  const args = argv.slice(offset) as string[];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--fullscreen' && !fullscreen) fullscreen = true;
    else if (args[i] === '--launch-game' && launchGameId === undefined && GAME_ID.test(args[i + 1] ?? '')) launchGameId = args[++i];
    // NSIS and electron-updater use this metadata flag after installation.
    // Accept it once without converting it into any game-launch authority.
    else if (args[i] === '--updated' && !updated) updated = true;
    else return invalid();
  }
  return { valid: true, fullscreen, ...(launchGameId ? { launchGameId } : {}) };
}

/** Windows CommandLineToArgvW / CRT-compatible quoting, including trailing
 * backslashes before a closing quote. No shell syntax is executed. */
export function quoteWindowsArgument(value: string): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid gaming argument.');
  if (value && !/[\s"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"';
}

export interface GamingRegistration { executable: string; args: string[]; argumentLine: string; shortcutName: string }
export function gamingRegistration(executable: string, gameId?: unknown): GamingRegistration {
  if (typeof executable !== 'string' || !path.win32.isAbsolute(executable) || /^\\\\[?.]\\/u.test(executable) ||
      !/\.exe$/iu.test(executable) || executable.length > 32767 || /[\u0000-\u001f\u007f"]/u.test(executable) ||
      gameId !== undefined && (typeof gameId !== 'string' || !GAME_ID.test(gameId))) throw new Error('Invalid gaming registration.');
  const args = ['--fullscreen', ...(typeof gameId === 'string' ? ['--launch-game', gameId] : [])];
  return { executable, args, argumentLine: args.map(quoteWindowsArgument).join(' '),
    shortcutName: typeof gameId === 'string' ? `IndieDeck-${gameId}.lnk` : 'IndieDeck-Fullscreen.lnk' };
}

export function gamingSettingsUrl(action: unknown): string {
  if (typeof action !== 'string' || !Object.hasOwn(GAMING_SETTINGS, action)) throw new Error('Invalid gaming settings action.');
  return GAMING_SETTINGS[action as GamingSettingsAction];
}

export interface GamingShortcutShell {
  writeShortcutLink(shortcutPath: string, operation: 'create', options: { target: string; cwd: string; args: string; description: string }): boolean;
  readShortcutLink(shortcutPath: string): { target: string; cwd?: string; args?: string; description?: string };
}

async function ordinaryDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  let current = root;
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid shortcut directory.');
  }
}

/** Main supplies a native folder-picker result and app.getPath('exe'). Create
 * only a launcher-owned shortcut; never modify Xbox/Steam private databases. */
export async function exportGamingShortcut(directory: string, registration: GamingRegistration, shell: GamingShortcutShell): Promise<{ created: true; path: string }> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Invalid shortcut directory.');
  const expected = gamingRegistration(registration.executable, registration.args.includes('--launch-game') ? registration.args.at(-1) : undefined);
  if (registration.argumentLine !== expected.argumentLine || registration.shortcutName !== expected.shortcutName ||
      JSON.stringify(registration.args) !== JSON.stringify(expected.args)) throw new Error('Invalid gaming registration.');
  await ordinaryDirectory(directory);
  const target = path.join(directory, expected.shortcutName);
  try { await fs.lstat(target); throw new Error('Gaming shortcut already exists.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.indiedeck-${crypto.randomUUID()}.lnk`);
  let made = false;
  try {
    made = true;
    if (!shell.writeShortcutLink(temporary, 'create', { target: expected.executable, cwd: path.win32.dirname(expected.executable), args: expected.argumentLine, description: DESCRIPTION })) throw new Error('Could not create gaming shortcut.');
    const written = await fs.lstat(temporary);
    if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1 || written.size > 65536) throw new Error('Invalid gaming shortcut.');
    const link = shell.readShortcutLink(temporary);
    if (link.target !== expected.executable || link.args !== expected.argumentLine || link.description !== DESCRIPTION ||
        link.cwd !== path.win32.dirname(expected.executable)) throw new Error('Invalid gaming shortcut.');
    await ordinaryDirectory(directory);
    // Exclusive publication: an existing foreign shortcut cannot be replaced,
    // including a file that appears after the initial existence check.
    await fs.link(temporary, target);
    return { created: true, path: target };
  } finally { if (made) await fs.unlink(temporary).catch(() => {}); }
}

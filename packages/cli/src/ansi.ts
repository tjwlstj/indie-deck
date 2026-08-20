/** ANSI helpers kept in one place so escape bytes never leak into other sources. */

export const ESC = '\u001B';
export const CSI = `${ESC}[`;

function detectColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '0') return true;
  return process.stdout.isTTY === true;
}

let colorEnabled = detectColor();

/** Lets `--no-color` / `--color` override the auto-detected default. */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

export function sgr(open: number, close: number): (text: string) => string {
  return (text: string) => (colorEnabled ? `${CSI}${open}m${text}${CSI}${close}m` : text);
}

export const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

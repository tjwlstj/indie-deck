/** Do not pass the launcher's API credentials or Node/Electron runtime controls
 * to a game or external tool. This is an environment boundary, not a sandbox:
 * it cannot identify credentials stored under arbitrary names or in files. */
export function gameProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => {
    if (!name || /[\u0000=]/.test(name) || typeof value !== 'string' || value.includes('\0')) return false;
    const folded = name.toUpperCase();
    const compact = folded.replace(/[^A-Z0-9]/g, '');
    if (/^(?:NODE|ELECTRON)(?:_|$)/.test(folded)) return false;
    if (/TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|PRIVATEKEY|CREDENTIAL|AUTHORIZATION|AUTHENTICATION|ACCESSKEY/.test(compact)) return false;
    return true;
  }));
}

import { isIP } from 'node:net';

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

/** IPC authority belongs to this exact top-level application document. An
 * otherwise identical URL in another WebContents or subframe is insufficient. */
export function isTrustedAppSender(event: unknown, webContents: unknown, expectedDocumentURL: string): boolean {
  try {
    if (!object(event) || !object(webContents) || event.sender !== webContents || typeof expectedDocumentURL !== 'string') return false;
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return false;
    const expected = new URL(expectedDocumentURL);
    if (expected.protocol !== 'file:' || expected.search || expected.hash || expected.username || expected.password) return false;
    const frame = event.senderFrame;
    if (!object(frame) || frame !== webContents.mainFrame || frame.detached === true) return false;
    if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return false;
    return frame.url === expected.href;
  } catch {
    // Electron frame access can throw during navigation or destruction.
    return false;
  }
}

/** Canonical public hostname syntax only. DNS and external browser behavior
 * remain under the OS; the fixed declared-URL allowlist is the trust boundary. */
function canonicalExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 ||
    /[\u0000-\u0020\u007f-\u009f\\]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return undefined;
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  // Reject even an explicit default port or an empty userinfo delimiter. URL
  // canonicalization would otherwise erase those parts before validation.
  if (!authority || authority.includes('@') || authority.includes(':')) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.endsWith('.') || isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 ||
    !hostname.includes('.') || hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  const reserved = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'test', 'invalid', 'example', 'onion'];
  if (reserved.some((name) => hostname === name || hostname.endsWith(`.${name}`))) return undefined;
  return url.href;
}

/** Only URLs declared by the main-owned registry/help policy can leave the
 * renderer. Canonical path, query and fragment all participate in the match. */
export function safeExternalUrl(value: unknown, declaredUrls: Iterable<string>): string | undefined {
  const target = canonicalExternalUrl(value);
  if (!target || typeof declaredUrls === 'string') return undefined;
  try {
    let inspected = 0;
    for (const declared of declaredUrls) {
      if (++inspected > 4096) return undefined;
      if (canonicalExternalUrl(declared) === target) return target;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Firefox Promise APIs and Chromium/Whale callbacks, without exposing errors
 * that can contain a private page URL to product UI. */
export function browserCall(api, owner, method, args = [], promiseApi = Boolean(globalThis.browser)) {
  if (typeof owner?.[method] !== 'function') return Promise.reject(new Error('Browser capability unavailable'));
  if (promiseApi) {
    try { return Promise.resolve(owner[method](...args)); }
    catch { return Promise.reject(new Error('Browser operation failed')); }
  }
  return new Promise((resolve, reject) => {
    try {
      const result = owner[method](...args, value => {
        if (api.runtime?.lastError) reject(new Error('Browser operation failed'));
        else resolve(value);
      });
      if (result?.then) result.then(resolve, () => reject(new Error('Browser operation failed')));
    } catch { reject(new Error('Browser operation failed')); }
  });
}

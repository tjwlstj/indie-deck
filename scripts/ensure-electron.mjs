import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// Retry the pinned Electron package's own installer on transient download
// errors. It still fetches and verifies the same official release artifacts.
const require = createRequire(import.meta.url);
const installer = path.join(path.dirname(require.resolve('electron')), 'install.js');
for (let attempt = 1; attempt <= 3; attempt += 1) {
  console.log(`[electron-install] official pinned binary attempt ${attempt}/3`);
  const child = spawn(process.execPath, [installer], { stdio: 'inherit', windowsHide: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timeout));
  if (code === 0 && !timedOut) process.exit(0);
  if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
}
throw new Error('Unable to install the pinned Electron binary after three attempts.');

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** CI overrides may not redirect Electron or disable TLS. Values stay local to
 * this child process and no credential or environment value is logged. */
export function sanitizedBuilderEnvironment(environment) {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled.');
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (/^(?:(?:npm_config_|npm_package_config_)?electron_(?:mirror|nightly_?mirror|custom_?(?:dir|filename|version)|use_?remote_?checksums|override_?dist_?path|builder_binaries_(?:mirror|allow_http))|node_options)$/i.test(key)) delete clean[key];
  }
  return clean;
}

/** Keep the regular YAML config and narrow the CI-only change to the pinned
 * Electron checksums. The builder must still perform its own hash validation. */
export function makeBuilderOptions({ environment, platform, arch, rootManifest, lockfile, electronManifest, checksums, yamlConfig }) {
  if (environment?.GITHUB_ACTIONS !== 'true' || platform !== 'win32' || arch !== 'x64') throw new Error('Windows release wrapper is restricted to GitHub Actions on x64 Windows.');
  const version = rootManifest?.devDependencies?.electron;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || electronManifest?.version !== version ||
      lockfile?.packages?.['']?.devDependencies?.electron !== version || lockfile?.packages?.['node_modules/electron']?.version !== version) {
    throw new Error('Electron dependency is not pinned consistently.');
  }
  if (!yamlConfig || typeof yamlConfig !== 'object' || Array.isArray(yamlConfig) || rootManifest?.build != null ||
      yamlConfig.electronDownload != null || yamlConfig.electronDist != null ||
      (yamlConfig.electronVersion != null && yamlConfig.electronVersion !== version)) {
    throw new Error('Unexpected Electron builder configuration; review CI checksum wiring.');
  }
  const filename = `electron-v${version}-win32-x64.zip`;
  if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums) ||
      typeof checksums[filename] !== 'string' || !/^[0-9a-f]{64}$/.test(checksums[filename])) {
    throw new Error('Pinned Electron checksum is missing.');
  }
  return { win: ['nsis', 'portable'], x64: true, publish: 'never',
    config: { electronDownload: { force: false, checksums } } };
}

async function main() {
  // Fail before loading build tools or issuing any network request locally.
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows release wrapper is restricted to GitHub Actions on x64 Windows.');
  const clean = sanitizedBuilderEnvironment(process.env);
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
  const electronDir = path.dirname(require.resolve('electron'));
  const rootManifest = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
  const lockfile = JSON.parse(await fs.readFile(path.resolve('package-lock.json'), 'utf8'));
  const electronManifest = JSON.parse(await fs.readFile(path.join(electronDir, 'package.json'), 'utf8'));
  const checksums = JSON.parse(await fs.readFile(path.join(electronDir, 'checksums.json'), 'utf8'));
  const yamlConfig = require('js-yaml').load(await fs.readFile(path.resolve('electron-builder.yml'), 'utf8'));
  const options = makeBuilderOptions({ environment: process.env, platform: process.platform, arch: process.arch,
    rootManifest, lockfile, electronManifest, checksums, yamlConfig });
  const { build } = require('electron-builder');
  await build(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[ci-build] ${error.message}`); process.exitCode = 1; });
}

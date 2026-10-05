import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { extractFile, listPackage } from '@electron/asar';
import yaml from 'js-yaml';

const archive = path.resolve(
  process.argv.slice(2).find((arg) => arg !== '--runtime-only') ?? path.join('release', 'win-unpacked', 'resources', 'app.asar'),
);

if (!fs.existsSync(archive)) {
  console.error(`[package] missing packaged ASAR: ${archive}`);
  process.exit(1);
}

const required = [
  '\\packages\\desktop\\dist\\main.js',
  '\\packages\\desktop\\dist\\operations.js',
  '\\packages\\desktop\\dist\\receipt-guard.js',
  '\\packages\\desktop\\dist\\font-guard.js',
  '\\packages\\desktop\\dist\\mtool.js',
  '\\packages\\desktop\\dist\\translator-maintenance.js',
  '\\packages\\desktop\\dist\\game-archives.js',
  '\\packages\\desktop\\dist\\launcher-updates.js',
  '\\packages\\desktop\\dist\\library-roots.js',
  '\\packages\\desktop\\dist\\library-scan.js',
  '\\packages\\desktop\\preload.cjs',
  '\\packages\\desktop\\renderer\\index.html',
  '\\packages\\desktop\\renderer\\state-model.js',
  '\\packages\\desktop\\renderer\\font-options.js',
  '\\packages\\desktop\\renderer\\mtool-model.js',
  '\\packages\\desktop\\renderer\\panels\\mtool.js',
  '\\packages\\desktop\\renderer\\maintenance-model.js',
  '\\packages\\desktop\\renderer\\archive-model.js',
  '\\packages\\desktop\\renderer\\update-model.js',
  '\\packages\\desktop\\renderer\\scan-model.js',
  '\\packages\\desktop\\renderer\\panels\\maintenance.js',
  '\\packages\\desktop\\renderer\\panels\\archives.js',
  '\\packages\\desktop\\renderer\\panels\\updates.js',
  '\\node_modules\\@indiedeck\\core\\dist\\index.js',
  '\\node_modules\\@indiedeck\\core\\dist\\detect\\rules.js',
  '\\node_modules\\@indiedeck\\core\\dist\\util\\fsx.js',
  '\\node_modules\\electron-updater\\out\\main.js',
  '\\registry\\engines.json',
  '\\registry\\configs\\xunity-autotranslator.json',
  '\\locales\\en.json',
  '\\locales\\ko.json',
];

let contents;
try {
  contents = new Set(listPackage(archive, {}));
} catch (error) {
  console.error(`[package] could not inspect ${archive}: ${error.message}`);
  process.exit(1);
}

const missing = required.filter((entry) => !contents.has(entry));
if (missing.length > 0) {
  for (const entry of missing) console.error(`[package] missing ${entry}`);
  process.exit(1);
}

console.log(`[package] ${required.length} required runtime entries found in ${archive}`);

const currentRuntime = [
  ['packages/desktop/dist/main.js', 'packages/desktop/dist/main.js'],
  ['packages/desktop/dist/operations.js', 'packages/desktop/dist/operations.js'],
  ['packages/desktop/dist/receipt-guard.js', 'packages/desktop/dist/receipt-guard.js'],
  ['packages/desktop/dist/translator-maintenance.js', 'packages/desktop/dist/translator-maintenance.js'],
  ['packages/desktop/dist/game-archives.js', 'packages/desktop/dist/game-archives.js'],
  ['packages/desktop/dist/launcher-updates.js', 'packages/desktop/dist/launcher-updates.js'],
  ['packages/desktop/dist/library-roots.js', 'packages/desktop/dist/library-roots.js'],
  ['packages/desktop/dist/library-scan.js', 'packages/desktop/dist/library-scan.js'],
  ['packages/desktop/dist/font-guard.js', 'packages/desktop/dist/font-guard.js'],
  ['packages/desktop/dist/mtool.js', 'packages/desktop/dist/mtool.js'],
  ['packages/desktop/preload.cjs', 'packages/desktop/preload.cjs'],
  ['packages/desktop/renderer/panels/settings.js', 'packages/desktop/renderer/panels/settings.js'],
  ['packages/desktop/renderer/app.js', 'packages/desktop/renderer/app.js'],
  ['packages/desktop/renderer/store.js', 'packages/desktop/renderer/store.js'],
  ['packages/desktop/renderer/index.html', 'packages/desktop/renderer/index.html'],
  ['packages/desktop/renderer/style.css', 'packages/desktop/renderer/style.css'],
  ['packages/desktop/renderer/panels/index.js', 'packages/desktop/renderer/panels/index.js'],
  ['packages/desktop/renderer/panels/detail.js', 'packages/desktop/renderer/panels/detail.js'],
  ['packages/desktop/renderer/font-options.js', 'packages/desktop/renderer/font-options.js'],
  ['packages/desktop/renderer/mtool-model.js', 'packages/desktop/renderer/mtool-model.js'],
  ['packages/desktop/renderer/panels/mtool.js', 'packages/desktop/renderer/panels/mtool.js'],
  ['packages/desktop/renderer/maintenance-model.js', 'packages/desktop/renderer/maintenance-model.js'],
  ['packages/desktop/renderer/archive-model.js', 'packages/desktop/renderer/archive-model.js'],
  ['packages/desktop/renderer/update-model.js', 'packages/desktop/renderer/update-model.js'],
  ['packages/desktop/renderer/scan-model.js', 'packages/desktop/renderer/scan-model.js'],
  ['packages/desktop/renderer/panels/maintenance.js', 'packages/desktop/renderer/panels/maintenance.js'],
  ['packages/desktop/renderer/panels/archives.js', 'packages/desktop/renderer/panels/archives.js'],
  ['packages/desktop/renderer/panels/updates.js', 'packages/desktop/renderer/panels/updates.js'],
  ['packages/desktop/renderer/panels/library.js', 'packages/desktop/renderer/panels/library.js'],
  ['node_modules/@indiedeck/core/dist/detect/index.js', 'packages/core/dist/detect/index.js'],
  ['node_modules/@indiedeck/core/dist/index.js', 'packages/core/dist/index.js'],
  ['node_modules/@indiedeck/core/dist/detect/rules.js', 'packages/core/dist/detect/rules.js'],
  ['node_modules/@indiedeck/core/dist/util/fsx.js', 'packages/core/dist/util/fsx.js'],
  ['node_modules/@indiedeck/core/dist/resolve/index.js', 'packages/core/dist/resolve/index.js'],
  ['node_modules/@indiedeck/core/dist/install/apply.js', 'packages/core/dist/install/apply.js'],
  ['node_modules/@indiedeck/core/dist/health/index.js', 'packages/core/dist/health/index.js'],
  ['node_modules/@indiedeck/core/dist/library/index.js', 'packages/core/dist/library/index.js'],
  ['locales/en.json', 'locales/en.json'],
  ['locales/ko.json', 'locales/ko.json'],
];
for (const [packagedPath, sourcePath] of currentRuntime) {
  const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash(extractFile(archive, path.normalize(packagedPath))) !== hash(fs.readFileSync(sourcePath))) {
    console.error(`[package] stale runtime content: ${packagedPath}`);
    process.exit(1);
  }
}
console.log(`[package] ${currentRuntime.length} critical runtime files match the current build by SHA-256`);

const version = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const packagedVersion = JSON.parse(extractFile(archive, 'package.json').toString('utf8')).version;
if (packagedVersion !== version) {
  console.error(`[package] packaged version ${packagedVersion} does not match source version ${version}`);
  process.exit(1);
}
// Unpacked development previews have no installer/update metadata. This opt-in
// mode verifies only their runtime and version; release checks stay strict.
if (process.argv.includes('--runtime-only')) {
  console.log(`[package] runtime-only preview verified at ${version}; distribution/update metadata not checked`);
  process.exit(0);
}
const resourcesDir = path.dirname(archive);
const outputDir = path.dirname(path.dirname(resourcesDir));
const updateConfigPath = path.join(resourcesDir, 'app-update.yml');
const latestPath = path.join(outputDir, 'latest.yml');
const expectedArtifacts = [
  `IndieDeck-Setup-${version}-x64.exe`,
  `IndieDeck-Setup-${version}-x64.exe.blockmap`,
  `IndieDeck-Portable-${version}-x64.exe`,
];

for (const file of [updateConfigPath, latestPath, ...expectedArtifacts.map((name) => path.join(outputDir, name))]) {
  if (!fs.existsSync(file)) {
    console.error(`[package] missing updater/distribution file: ${file}`);
    process.exit(1);
  }
}

const installerName = expectedArtifacts[0];
const installerPath = path.join(outputDir, installerName);
const updateConfig = yaml.load(fs.readFileSync(updateConfigPath, 'utf8'));
if (
  !updateConfig ||
  updateConfig.provider !== 'github' ||
  updateConfig.owner !== 'tjwlstj' ||
  updateConfig.repo !== 'indie-deck' ||
  updateConfig.releaseType !== 'release'
) {
  console.error('[package] app-update.yml does not exactly target the stable tjwlstj/indie-deck GitHub channel');
  process.exit(1);
}

const installerSize = fs.statSync(installerPath).size;
const installerSha512 = crypto
  .createHash('sha512')
  .update(fs.readFileSync(installerPath))
  .digest('base64');

const latest = yaml.load(fs.readFileSync(latestPath, 'utf8'));
const updaterFile = latest?.files?.[0];
if (
  !latest ||
  latest.version !== version ||
  latest.path !== installerName ||
  latest.sha512 !== installerSha512 ||
  !Array.isArray(latest.files) ||
  latest.files.length !== 1 ||
  updaterFile?.url !== installerName ||
  updaterFile?.size !== installerSize ||
  updaterFile?.sha512 !== installerSha512
) {
  console.error('[package] latest.yml does not exactly match the version, name, size and SHA-512 of the NSIS installer');
  process.exit(1);
}

console.log(`[package] updater metadata targets the verified ${installerName} on GitHub Releases`);

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { extractFile, listPackage } from '@electron/asar';
import yaml from 'js-yaml';

const archive = path.resolve(
  process.argv[2] ?? path.join('release', 'win-unpacked', 'resources', 'app.asar'),
);

if (!fs.existsSync(archive)) {
  console.error(`[package] missing packaged ASAR: ${archive}`);
  process.exit(1);
}

const required = [
  '\\packages\\desktop\\dist\\main.js',
  '\\packages\\desktop\\preload.cjs',
  '\\packages\\desktop\\renderer\\index.html',
  '\\node_modules\\@indiedeck\\core\\dist\\index.js',
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

const version = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const packagedVersion = JSON.parse(extractFile(archive, 'package.json').toString('utf8')).version;
if (packagedVersion !== version) {
  console.error(`[package] packaged version ${packagedVersion} does not match source version ${version}`);
  process.exit(1);
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

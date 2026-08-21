import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifests = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/desktop/package.json',
];

const packages = manifests.map((relative) => ({
  relative,
  value: JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')),
}));
const expected = packages[0].value.version;
const failures = [];
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expected)) {
  failures.push(`root version ${expected} is not a stable semantic version`);
}

for (const entry of packages) {
  if (entry.value.version !== expected) {
    failures.push(`${entry.relative} has version ${entry.value.version}; expected ${expected}`);
  }
}

if (lock.version !== expected) {
  failures.push(`package-lock.json has version ${lock.version}; expected ${expected}`);
}

const lockPackages = [
  ['', 'package.json'],
  ['packages/core', 'packages/core/package.json'],
  ['packages/cli', 'packages/cli/package.json'],
  ['packages/desktop', 'packages/desktop/package.json'],
];
for (const [key, label] of lockPackages) {
  const entry = lock.packages?.[key];
  if (entry?.version !== expected) {
    failures.push(`package-lock.json entry for ${label} has version ${entry?.version ?? 'missing'}; expected ${expected}`);
  }
  const core = entry?.dependencies?.['@indiedeck/core'];
  if (core !== undefined && core !== expected) {
    failures.push(`package-lock.json entry for ${label} depends on @indiedeck/core ${core}; expected ${expected}`);
  }
}

for (const entry of packages) {
  const core = entry.value.dependencies?.['@indiedeck/core'];
  if (core !== undefined && core !== expected) {
    failures.push(`${entry.relative} depends on @indiedeck/core ${core}; expected ${expected}`);
  }
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${expected}`) {
  failures.push(`tag ${tag} does not match package version v${expected}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[release] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`[release] manifests${tag ? ` and tag ${tag}` : ''} agree on ${expected}`);
}

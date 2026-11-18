'use strict';

const fs = require('node:fs/promises');

// node-gyp 12.4.0 only looks for non-hidden solution and make files directly
// in build/. Keep this dependency scoped to that exact upstream version.
const suffixes = new Map([['build/*.sln', '.sln'], ['build/*.mk', '.mk']]);

async function glob(pattern, options) {
  const suffix = suffixes.get(pattern);
  if (!suffix || !options || options.expandDirectories !== false || Object.keys(options).length !== 1) {
    throw new TypeError('Unsupported node-gyp file lookup. Review the pinned build dependency.');
  }

  let entries;
  try {
    entries = await fs.readdir('build', { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }

  const matches = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.name.endsWith(suffix)) continue;
    const file = 'build/' + entry.name;
    if (entry.isFile()) matches.push(file);
    else if (entry.isSymbolicLink()) {
      // Like the original file-only lookup, follow links to ordinary files.
      try { if ((await fs.stat(file)).isFile()) matches.push(file); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }
  return matches;
}

module.exports = { glob };

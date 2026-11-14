import fs from 'node:fs';
import path from 'node:path';

export function discoverScriptTests(root) {
  return ['scripts', path.join('ai', 'scripts')]
    .flatMap((directory) => walk(path.join(root, directory), root))
    .sort();
}

function walk(directory, root) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) return walk(absolute, root);
    if (entry.isFile() && entry.name.endsWith('.test.mjs')) return [path.relative(root, absolute)];
    return [];
  });
}

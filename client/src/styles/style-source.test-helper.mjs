import fs from 'node:fs';

const LOCAL_CSS_IMPORT = /^@import\s+["'](\.\/[^"']+\.css)["'];\s*$/gm;

export function readStyleSource(url = new URL('./index.css', import.meta.url), visited = new Set()) {
  const key = url.href;
  if (visited.has(key)) return '';
  visited.add(key);

  const source = fs.readFileSync(url, 'utf8');
  return source.replace(LOCAL_CSS_IMPORT, (_statement, relativePath) => (
    readStyleSource(new URL(relativePath, url), visited)
  ));
}

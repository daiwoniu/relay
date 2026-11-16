import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

test('真实Tailwind扫描保留运行文件，排除测试与构建策略文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-style-sources-'));
  try {
    const base = path.join(root, 'client'), styles = path.join(base, 'src', 'styles');
    fs.mkdirSync(styles, { recursive: true });
    const files = {
      'src/feature.tsx': 'p-[101px]', 'public/offline.js': 'm-[102px]', 'index.html': 'text-[103px]',
      'src/feature.test.mjs': 'w-[2001px]', 'src/feature.spec.tsx': 'h-[2002px]',
      'src/__tests__/fixture.ts': 'z-[2003]', 'scripts/check-build-budget.mjs': 'gap-[2004px]',
    };
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true }); fs.writeFileSync(path.join(base, name), content);
    }
    const source = fs.readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');
    const head = source.split('\n').filter(line => line.startsWith('@source ') || line.startsWith('@import "tailwindcss"')).join('\n');
    const compiler = await compile(head, { base: styles, onDependency: () => {},
      customCssResolver: async id => id === 'tailwindcss' ? fileURLToPath(new URL('../node_modules/tailwindcss/index.css', import.meta.url)) : undefined });
    const candidates = new Scanner({ sources: [{ base, pattern: '**/*', negated: false }, ...compiler.sources] }).scan();
    for (const name of ['src/feature.tsx', 'public/offline.js', 'index.html']) assert(candidates.includes(files[name]), name);
    for (const name of ['src/feature.test.mjs', 'src/feature.spec.tsx', 'src/__tests__/fixture.ts', 'scripts/check-build-budget.mjs']) assert(!candidates.includes(files[name]), name);
    assert.match(compiler.build(candidates), /101px/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

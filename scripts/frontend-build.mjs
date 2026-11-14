import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activatePreparedFrontendBuild, prepareFrontendBuild } from './lib/frontend-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = prepareFrontendBuild({ root, onProgress: (line) => console.log(line) });
console.log(`${result.reused ? '复用' : '完成'}前端生产构建：${result.buildId}`);
if (process.argv.includes('--activate')) {
  activatePreparedFrontendBuild(root);
  console.log(`已激活前端生产构建：${result.buildId}`);
}

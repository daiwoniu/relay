import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const rootPackage = JSON.parse(read('package.json'));
const clientPackage = JSON.parse(read('client/package.json'));
const clientLock = JSON.parse(read('client/package-lock.json'));
const serverPackage = JSON.parse(read('server/package.json'));
const serverLock = JSON.parse(read('server/package-lock.json'));

test('Relay 产品版本以根 package.json 为唯一运行时来源', () => {
  assert.match(rootPackage.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.match(read('client/vite.config.ts'), /path\.resolve\(__dirname, '\.\.', 'package\.json'\)/);
  assert.match(read('client/src/components/layout/UserMenu.tsx'), /Relay v\{__RELAY_VERSION__\}/);
  assert.match(read('scripts/lib/help.mjs'), /new URL\('\.\.\/\.\.\/package\.json', import\.meta\.url\)/);
  assert.doesNotMatch(read('client/src/components/layout/UserMenu.tsx'), /Relay v\d+\.\d+\.\d+/);
});

test('根产品版本属于 production 前端构建指纹', () => {
  assert.match(read('scripts/lib/frontend-build.mjs'), /path\.join\(root, 'package\.json'\)/);
});

test('私有前后端子工程不声明独立版本', () => {
  for (const [name, manifest, lockfile] of [
    ['client', clientPackage, clientLock],
    ['server', serverPackage, serverLock],
  ]) {
    assert.equal(manifest.private, true, `${name} 必须保持 private`);
    assert.equal(Object.hasOwn(manifest, 'version'), false, `${name}/package.json 不得声明 version`);
    assert.equal(Object.hasOwn(lockfile, 'version'), false, `${name}/package-lock.json 顶层不得声明 version`);
    assert.equal(Object.hasOwn(lockfile.packages[''], 'version'), false, `${name} lockfile 根包不得声明 version`);
  }
});

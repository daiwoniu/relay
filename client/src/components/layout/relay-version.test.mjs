import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const rootPackage = JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'));
const viteConfig = fs.readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
const typeDeclarations = fs.readFileSync(new URL('../../vite-env.d.ts', import.meta.url), 'utf8');
const userMenu = fs.readFileSync(new URL('UserMenu.tsx', import.meta.url), 'utf8');

test('用户菜单 Relay 版本由根 package.json 在构建时注入', () => {
  assert.equal(typeof rootPackage.version, 'string');
  assert.match(viteConfig, /package\.json/);
  assert.match(viteConfig, /__RELAY_VERSION__:\s*JSON\.stringify\(relayVersion\)/);
  assert.match(typeDeclarations, /declare const __RELAY_VERSION__: string/);
  assert.match(userMenu, /Relay v\{__RELAY_VERSION__\}/);
  assert.doesNotMatch(userMenu, /Relay v\d+\.\d+\.\d+/);
});

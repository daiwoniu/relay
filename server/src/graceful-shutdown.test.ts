import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

test('后端关闭先等待受管应用与存储释放，不强制提前退出', () => {
  const entry = fs.readFileSync(new URL('./managed-entry.ts', import.meta.url), 'utf8');
  assert.match(source, /import '\.\/managed-entry\.js'/);
  assert.match(entry, /const shutdown=\(\)=>\{/);
  assert.match(entry, /if\(listener\)await listener\.close\(\);else if\(prepared\)await prepared\.close\(\);else if\(!ownerHandedOff\)await initialized\?\.owner\.release\(\)/);
  assert.doesNotMatch(entry, /process\.exit\(/);
});

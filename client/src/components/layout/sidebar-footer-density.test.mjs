import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('侧栏底部使用紧凑留白并保留账号按钮点击高度', () => {
  const sidebar = fs.readFileSync(new URL('Sidebar.tsx', import.meta.url), 'utf8');
  const userMenu = fs.readFileSync(new URL('UserMenu.tsx', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('../../styles/global-base.css', import.meta.url), 'utf8');

  assert.match(sidebar, /className="border-t border-\[var\(--color-border\)\] px-3 py-2"/);
  assert.match(sidebar, /className="flex items-center gap-1 rounded-xl px-1"/);
  assert.match(userMenu, /className="user-menu__trigger"/);
  assert.match(styles, /\.user-menu__trigger \{[\s\S]*?min-height: 2\.5rem/);
});

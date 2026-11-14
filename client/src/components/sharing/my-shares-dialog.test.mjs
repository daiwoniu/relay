import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const dialog = fs.readFileSync(new URL('MySharesDialog.tsx', import.meta.url), 'utf8');
const sidebar = fs.readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');

test('取消或删除分享时保留现有列表并后台刷新', () => {
  assert.match(dialog, /hasLoaded\.current = true;\s+setItems\(response\.items\)/);
  assert.match(dialog, /loading && !hasLoaded\.current \?/);
  assert.match(dialog, /await action\(\); await load\(page\)/);
});

test('分享操作进行中禁用对应条目的操作按钮', () => {
  assert.match(dialog, /const \[mutatingId, setMutatingId\] = useState<string \| null>\(null\)/);
  assert.equal((dialog.match(/disabled=\{mutatingId !== null\}/g) ?? []).length, 2);
  assert.match(dialog, /finally \{ setMutatingId\(null\); \}/);
});

test('分享管理使用统一内容面板骨架和固定分页操作区', () => {
  assert.match(dialog, /<PanelShell/);
  assert.match(dialog, /size="content"/);
  assert.match(dialog, /footer=\{total > SHARE_PAGE_SIZE/);
  assert.match(dialog, /mobile=\{mobile\}/);
  assert.match(sidebar, /<MySharesDialog open=\{mySharesOpen\}[\s\S]*?mobile=\{isMobile\}/);
});

test('分享管理复用共享列表状态与分页并提供加载失败重试', () => {
  assert.match(dialog, /import \{ ListPagination, ListState \} from '\.\.\/ui\/ListControls'/);
  assert.match(dialog, /<ListPagination/);
  assert.match(dialog, /<ListState kind="loading"/);
  assert.match(dialog, /<ListState kind="error"[\s\S]*?onRetry=/);
  assert.match(dialog, /<ListState kind="empty"/);
});

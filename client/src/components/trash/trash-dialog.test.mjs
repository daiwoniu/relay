import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getValidTrashOffset } from './trash-pagination.ts';

const dialog = fs.readFileSync(new URL('TrashDialog.tsx', import.meta.url), 'utf8');
const userMenu = fs.readFileSync(new URL('../layout/UserMenu.tsx', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../../styles/authorization.css', import.meta.url), 'utf8');

test('回收站入口紧跟我的分享且位于个人区分隔线之前', () => {
  const shares = userMenu.indexOf('>我的分享</span>');
  const trash = userMenu.indexOf('>回收站</span>');
  const management = userMenu.indexOf('aria-label="系统管理"');
  assert.ok(shares >= 0 && trash > shares && management > trash);
});

test('回收站包含双页签、移动端全屏和管理员永久删除门禁', () => {
  assert.match(dialog, /\['sessions', 'projects'\]/);
  assert.match(dialog, /<PanelShell[\s\S]*?size="content"/);
  assert.doesNotMatch(styles, /\.trash-dialog \{/);
  assert.match(dialog, /\{admin && <button/);
  assert.match(dialog, /confirmationName !== action\.item\.name/);
});

test('永久删除提示附件分享影响但明确保留用户文件和 Codex JSONL', () => {
  assert.match(dialog, /Relay 托管附件/);
  assert.match(dialog, /用户源文件、项目目录和 Codex JSONL 不会删除/);
  assert.match(dialog, /cleanupPending/);
});

test('项目展开接入十条加载更多并保留失败重试', () => {
  assert.match(dialog, /useTrashProjectPages/);
  assert.match(dialog, /projectPages\.loadMore\(project\.id\)/);
  assert.match(dialog, /加载更多（10条）/);
  assert.match(dialog, /'重试'/);
  assert.doesNotMatch(dialog, /仅显示前|位于前 100 条之外/);
});

test('操作后后台刷新并恢复列表滚动位置', () => {
  assert.match(dialog, /const scrollTop = preserveScroll \? bodyRef\.current\?\.scrollTop \?\? 0 : null/);
  assert.match(dialog, /await load\(tab, offset\[tab\], true\)/);
  assert.match(dialog, /bodyRef\.current\.scrollTop = scrollTop/);
});

test('切换项目与会话页签时清空上一页签的成功提示', () => {
  assert.match(dialog, /const selectTab = \(value: Tab\) => \{/);
  assert.match(dialog, /if \(value === tab\) return;/);
  assert.match(dialog, /setNotice\(null\);\s*setTab\(value\);/);
  assert.match(dialog, /onClick=\{\(\) => selectTab\(value\)\}/);
});

test('打开回收站时同时加载项目和会话页签的实际数量', () => {
  assert.match(dialog, /const loadTotal = useCallback\(async \(targetTab: Tab\) => \{/);
  assert.match(dialog, /listTrashProjects\(1, 0\)/);
  assert.match(dialog, /listTrashSessions\(1, 0\)/);
  assert.match(dialog, /setTotal\(\(value\) => \(\{ \.\.\.value, \[targetTab\]: response\.total \}\)\)/);
  assert.match(dialog, /if \(open\) void loadTotal\(tab === 'projects' \? 'sessions' : 'projects'\)/);
});

test('移动端列表不横向滚动且项目使用展开箭头', () => {
  assert.match(styles, /\.trash-dialog__body \{[^}]*overflow-x: hidden/);
  assert.match(styles, /\.trash-dialog__list \{[^}]*grid-template-columns: minmax\(0,1fr\)[^}]*min-width: 0/);
  assert.match(styles, /\.trash-dialog__card \{[^}]*width: 100%[^}]*min-width: 0/);
  assert.match(styles, /\.trash-dialog__row \{[^}]*width: 100%[^}]*min-width: 0/);
  assert.match(styles, /\.trash-dialog__item \{[^}]*min-width: 0[^}]*flex: 1/);
  assert.match(styles, /\.trash-dialog__actions \{[^}]*flex: 0 0 auto/);
  assert.match(styles, /@media \(max-width: 399px\)/);
  assert.match(styles, /\.trash-dialog__restore, \.trash-dialog__delete \{[^}]*white-space: nowrap/);
  assert.match(dialog, /trash-dialog__expand-icon--expanded/);
  assert.doesNotMatch(dialog, /\? '−' : '\+'/);
});

test('回收站复用共享列表状态与分页且保留业务操作', () => {
  assert.match(dialog, /import \{ ListPagination, ListState \} from '\.\.\/ui\/ListControls'/);
  assert.match(dialog, /<ListPagination/);
  assert.match(dialog, /<ListState kind="loading"/);
  assert.match(dialog, /<ListState kind="error"[\s\S]*?onRetry=/);
  assert.match(dialog, /<ListState kind="empty"/);
  assert.match(dialog, /prepareDelete/);
  assert.match(dialog, /finishMutation/);
  assert.doesNotMatch(styles, /\.trash-dialog__pagination button/);
  assert.doesNotMatch(styles, /\.trash-dialog__(?:state|empty)(?:\s|\{|__)/);
});

test('最后一页收缩后回退到最后有效 offset', () => {
  assert.equal(getValidTrashOffset(30, 30, 30), 0);
  assert.equal(getValidTrashOffset(60, 60, 30), 30);
  assert.equal(getValidTrashOffset(35, 30, 30), 30);
  assert.equal(getValidTrashOffset(0, 30, 30), 0);
  assert.match(dialog, /const validOffset = getValidTrashOffset\(response\.total, targetOffset, TRASH_PAGE_SIZE\)/);
  assert.match(dialog, /if \(validOffset !== targetOffset\)[\s\S]*?setOffset/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./SidebarNavigationItems.tsx', import.meta.url), 'utf8');
const sidebarSource = await readFile(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const projectBlockStart = source.indexOf('function ProjectBlock(');
const projectBlockEnd = source.indexOf('\nfunction MoreIcon(', projectBlockStart);
const projectBlock = source.slice(projectBlockStart, projectBlockEnd);

test('项目拖拽：标题行统一承载 sortable 测量与 transform，会话列表不参与变换', () => {
  assert.match(projectBlock, /<div className="sidebar-project relative mb-1">/);
  assert.match(projectBlock, /<div\s+ref=\{setNodeRef\}\s+style=\{sortableStyle\}\s+className=\{`sidebar-project-row[\s\S]*?sidebar-resource-row--dragging/s);
  assert.doesNotMatch(projectBlock, /<div[^>]*className="sidebar-project[^>]*style=\{sortableStyle\}/);
});

test('项目拖拽：标题按钮使用规范 activator ref 并排除侧栏滑动手势', () => {
  assert.match(projectBlock, /<button\s+ref=\{setActivatorNodeRef\}[\s\S]*?data-no-sidebar-swipe[\s\S]*?\{\.\.\.\(dragDisabled \? \{\} : listeners\)\}/);
});

test('项目拖拽：阻止移动端系统长按菜单抢占排序手势', () => {
  assert.match(projectBlock, /onContextMenu=\{\(event\) => \{ if \(isMobile\) event\.preventDefault\(\); \}\}/);
});

test('项目拖拽：不再用 touch-action none 阻断侧栏纵向滚动', async () => {
  const styles = await readFile(new URL('../../styles/global-base.css', import.meta.url), 'utf8');
  const mobileRules = styles.slice(styles.indexOf('@media (max-width: 1023px)'));
  assert.doesNotMatch(mobileRules, /\.sidebar-project-row__trigger \{ touch-action: none; \}/);
  assert.match(styles, /\.sidebar-drag-activator \{[\s\S]*?touch-action: manipulation;/);
});

test('项目拖拽：拖拽生命周期不再折叠和重建项目会话树', () => {
  assert.doesNotMatch(sidebarSource, /projectDragActive/);
  assert.match(sidebarSource, /expanded=\{searchMode \? true : isSidebarGroupExpanded\(expandedGroups, `p-\$\{project\.id\}`\)\}/);
});

test('项目拖拽：与会话统一使用单一拖拽源，不再叠加项目专属 DragOverlay', async () => {
  const styles = await readFile(new URL('../../styles/global-base.css', import.meta.url), 'utf8');
  const draggingRule = styles.match(/\.sidebar-resource-row--dragging \{([\s\S]*?)\}/)?.[1] ?? '';
  assert.doesNotMatch(sidebarSource, /\bDragOverlay\b/);
  assert.doesNotMatch(sidebarSource, /activeDragProject/);
  assert.doesNotMatch(draggingRule, /\btranslate\s*:/);
  assert.doesNotMatch(draggingRule, /\bscale\s*:/);
});

test('会话拖拽同样排除侧栏滑动，避免两套触摸状态机竞争', () => {
  const sessionBlock = source.slice(source.indexOf('function SessionRow('));
  assert.match(sessionBlock, /<button[\s\S]*?data-no-sidebar-swipe[\s\S]*?sidebar-session-row__trigger/);
});

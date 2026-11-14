import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sidebar = fs.readFileSync(new URL('SidebarNavigationItems.tsx', import.meta.url), 'utf8');
const engineBadge = fs.readFileSync(new URL('../chat/SessionEngineBadge.tsx', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../../styles/global-base.css', import.meta.url), 'utf8');
const sessionRow = sidebar.slice(sidebar.indexOf('function SessionRow'));

test('会话打开按钮覆盖整行非操作区域', () => {
  assert.match(
    sessionRow,
    /sidebar-session-row group relative flex items-center gap-0 rounded-lg/,
  );
  assert.match(
    sessionRow,
    /sidebar-session-row__trigger flex min-w-0 flex-1 flex-col justify-center rounded-md pl-3 pr-2 text-left/,
  );
});

test('长会话标题只占剩余宽度且不会撑宽侧栏行', () => {
  assert.match(styles, /\.sidebar-session-row \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.sidebar-session-row__trigger > div \{ width: 100%; min-width: 0; \}/);
  assert.match(sessionRow, /className="min-w-0 truncate"/);
  assert.match(styles, /\.sidebar-session-row__trigger > div > span\[class~='min-w-0'\] \{ flex: 1 1 0%; \}/);
});

test('会话右侧操作区继续独立于打开按钮', () => {
  assert.match(
    sessionRow,
    /<\/button>[\s\S]*data-session-controls[\s\S]*?className="sidebar-session-row__tail ml-auto flex shrink-0 items-center gap-1"/,
  );
});

test('桌面端悬停状态图标时仍显示会话操作按钮', () => {
  assert.match(
    sessionRow,
    /sidebar-resource-actions sidebar-session-actions[\s\S]*?transition-opacity \$\{actionsVisible \? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'\}/,
  );
  assert.doesNotMatch(sessionRow, /statusHovered/);
});

test('打开会话将焦点移到输入框时不会清除真实悬停状态', () => {
  assert.match(sessionRow, /const \[rowHovered, setRowHovered\] = useState\(false\)/);
  assert.match(sessionRow, /const \[rowFocused, setRowFocused\] = useState\(false\)/);
  assert.match(sessionRow, /isMobile \|\| contextMenuActive \|\| rowHovered \|\| rowFocused/);
  assert.match(sessionRow, /onBlurCapture=\{\(event\) => \{[\s\S]*setRowFocused\(false\)/);
  assert.doesNotMatch(sessionRow, /onBlurCapture=\{\(event\) => \{[\s\S]*setRowHovered\(false\)/);
});

test('拖拽或重命名切换会清除残留交互状态并隐藏桌面操作区', () => {
  assert.match(
    sessionRow,
    /useLayoutEffect\(\(\) => \{[\s\S]*setRowHovered\(false\);[\s\S]*setRowFocused\(false\);[\s\S]*\}, \[dragging, isRenaming\]\)/,
  );
  assert.match(
    sessionRow,
    /const actionsVisible = !dragging && !isRenaming && \(isMobile \|\| contextMenuActive \|\| rowHovered \|\| rowFocused\)/,
  );
  assert.match(sessionRow, /if \(!isMobile && !dragging && !isRenaming\) setRowHovered\(true\)/);
  assert.match(sessionRow, /if \(!dragging && !isRenaming\) setRowFocused\(true\)/);
});

test('引擎徽标显示在会话标题左侧并使用品牌背景色', () => {
  assert.match(
    sessionRow,
    /<SessionEngineBadge engine=\{session\.engine\} \/>[\s\S]*SessionSearchTitle/,
  );
  assert.match(engineBadge, /border-white\/25/);
  assert.match(engineBadge, /style=\{\{ backgroundColor: presentation\.badgeColor \}\}/);
  assert.doesNotMatch(
    sessionRow,
    /SessionSearchTitle[\s\S]*rounded-full[\s\S]*session\.engine === 'codebuddy'/,
  );
});

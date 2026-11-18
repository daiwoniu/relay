import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('侧栏从任务工作台或页面托管创建新会话时返回聊天空会话', async () => {
  const source = await readFile(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  assert.match(source, /useLocation/);
  assert.match(source, /location\.pathname === '\/admin\/task-workbench'/);
  assert.ok(/if \(isWorkspaceConsole \|\| location\.pathname === '\/admin\/page-hosting'\) navigate\('\/'\)/.test(source), '两种管理页均应在新建或选择会话时返回聊天页');
});

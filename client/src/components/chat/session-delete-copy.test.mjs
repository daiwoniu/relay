import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('会话和项目删除使用后端权威影响摘要，不按引擎或侧栏分页数据猜测', () => {
  const chatView = [
    'ChatView.tsx',
    'ChatViewPresentation.tsx',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  const sidebar = fs.readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');

  assert.match(chatView, /getSessionDeletionImpact\(target\.id\)/);
  assert.match(chatView, /deleteTarget\.impact\?\.hasLinkedCodexThread/);
  assert.match(chatView, /confirmDisabled=\{deleteTarget\?\.impactStatus !== 'ready'\}/);
  assert.match(sidebar, /getProjectDeletionImpact\(project\.id\)/);
  assert.match(sidebar, /getSessionDeletionImpact\(session\.id\)/);
  assert.match(sidebar, /deleteConfirm\.impact\.linkedCodexSessionCount > 0/);
  assert.match(sidebar, /confirmDisabled=\{deleteConfirm\?\.impactStatus !== 'ready'\}/);
  assert.doesNotMatch(chatView, /deleteTarget\?\.engine === 'codex'/);
  assert.doesNotMatch(sidebar, /deleteConfirm\.session\.engine === 'codex'/);
  assert.doesNotMatch(sidebar, /codexSessionCount/);
  assert.doesNotMatch(sidebar, /各会话关联的 Codex 原始会话保留，归档状态不变/);
  assert.equal((chatView.match(/关联的 Codex 原始会话保留，归档状态不变/g) ?? []).length, 1);
  assert.equal((sidebar.match(/关联的 Codex 原始会话保留，归档状态不变/g) ?? []).length, 2);
});

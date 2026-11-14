import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('侧栏与消息标题入口复用同一详情面板和会话详情内容', () => {
  const sidebar = fs.readFileSync(new URL('Sidebar.tsx', import.meta.url), 'utf8');
  const chatView = [
    '../chat/ChatView.tsx',
    '../chat/ChatViewPresentation.tsx',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  const chatHeader = fs.readFileSync(new URL('../chat/ChatHeader.tsx', import.meta.url), 'utf8');
  const sessionMenuItems = fs.readFileSync(new URL('../chat/session-menu-items.tsx', import.meta.url), 'utf8');
  const chatInput = [
    '../chat/ChatInput.tsx',
    '../chat/ChatInputMetadataBar.tsx',
    '../chat/ChatInputDialogs.tsx',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  const projectDetails = fs.readFileSync(new URL('ProjectDetailsContent.tsx', import.meta.url), 'utf8');
  const sessionDetails = fs.readFileSync(new URL('SessionDetailsContent.tsx', import.meta.url), 'utf8');
  const dialog = fs.readFileSync(new URL('DetailsDialog.tsx', import.meta.url), 'utf8');
  const uploads = fs.readFileSync(new URL('../projects/ProjectUploadsDialog.tsx', import.meta.url), 'utf8');

  assert.match(sidebar, /<DetailsDialog/);
  assert.match(chatView, /<DetailsDialog/);
  assert.match(chatInput, /<DetailsDialog/);
  assert.match(sidebar, /<SessionDetailsContent/);
  assert.match(chatView, /<SessionDetailsContent/);
  assert.match(chatView, /sessionDetails: currentSessionDetails/);
  assert.match(chatHeader, /content=\{sessionDetails\}/);
  assert.doesNotMatch(chatHeader, /ID：\{currentSession\.id\}/);
  assert.match(sidebar, /<ProjectDetailsContent/);
  assert.match(chatInput, /<ProjectDetailsContent/);
  assert.match(projectDetails, /会话数：\{sessionCount\}/);
  assert.match(projectDetails, /复制完整项目路径/);
  assert.match(sessionDetails, /引擎：\{session\.engine \? engineLabel\(session\.engine\) : '尚未选择'\}/);
  assert.match(sessionDetails, /引擎会话 ID/);
  assert.doesNotMatch(sessionDetails, /Codex Thread ID/);
  assert.doesNotMatch(sessionDetails, /CodeBuddy Session ID/);
  assert.match(sessionDetails, /尚未绑定/);
  assert.match(sessionDetails, /状态：\{presentation\.label\}/);
  assert.match(sessionMenuItems, /label: '查看详情'/);
  assert.match(sidebar, /onDetails: \(\) => openSessionDetails\(menuSession\)/);
  assert.match(sidebar, /void getSession\(session\.id\)/);
  assert.match(sidebar, /onSelect: \(\) => setMobileDetails\(\{ type: 'project' as const, project: menuProject \}\)/);
  assert.doesNotMatch(sidebar, /onDetails: isMobile \?/);
  assert.doesNotMatch(sidebar, /\.\.\.\(isMobile \? \[\{\s*id: 'details'/);
  assert.match(chatView, /onDetails: \(\) => setMobileDetailsOpen\(true\)/);
  assert.match(chatView, /onSelectMessages:/);
  assert.match(chatInput, /if \(currentProject\?\.path\) onOpenMobileDetails\('project'\)/);
  assert.match(chatInput, /mobileDetails === 'project' \? '项目详情'/);
  assert.doesNotMatch(chatInput, /import Modal from/);
  assert.match(dialog, /info-panel-surface info-panel-surface--dialog/);
  assert.match(dialog, /presentation = 'info'/);
  assert.match(dialog, /details-dialog-surface--\$\{presentation\}/);
  assert.match(dialog, /info-panel__header/);
  assert.match(dialog, /info-panel__body/);
  assert.match(uploads, /<DetailsDialog[^>]*presentation="task"/);
  assert.match(dialog, />\{title\}<\/div>/);
});

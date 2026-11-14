import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function readComponentSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) sources.push(...await readComponentSources(url));
    else if (entry.name.endsWith('.tsx')) sources.push(await readFile(url, 'utf8'));
  }
  return sources;
}

const sidebar = await readFile(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');
const chatView = (await Promise.all([
  '../chat/ChatView.tsx',
  '../chat/ChatViewPresentation.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
const chatInput = (await Promise.all([
  '../chat/ChatInput.tsx',
  '../chat/ChatInputDialogs.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
const uploads = await readFile(new URL('../projects/ProjectUploadsDialog.tsx', import.meta.url), 'utf8');
const maintenance = await readFile(new URL('../system/ServiceMaintenanceDialog.tsx', import.meta.url), 'utf8');
const confirmDialog = await readFile(new URL('ConfirmDialog.tsx', import.meta.url), 'utf8');
const allComponentSources = (await readComponentSources(new URL('../', import.meta.url))).join('\n');

test('业务组件不使用浏览器原生确认框', () => {
  assert.doesNotMatch(allComponentSources, /(?:window|globalThis)\.confirm\s*\(/);
});

test('删除项目和会话突出操作对象与实际影响', () => {
  assert.match(sidebar, /subject=\{deleteSubject\}/);
  assert.match(sidebar, /deleteConfirm\.impact\.sessionCount/);
  assert.match(sidebar, /将从当前 Relay 列表隐藏/);
  assert.match(sidebar, /项目、会话、磁盘工作目录和已上传文件均会保留/);
  assert.match(sidebar, /Relay 数据会移入回收站，可从回收站恢复/);
  assert.match(sidebar, /impacts=\{deleteImpacts\}/);
  assert.match(chatView, /subject=\{deleteTarget \?/);
  assert.match(chatView, /关联的 Codex 原始会话保留，归档状态不变/);
  assert.match(chatView, /Relay 数据会移入回收站，可从回收站恢复/);
  assert.doesNotMatch(`${sidebar}\n${chatView}`, /当前版本暂不提供恢复入口/);
  assert.doesNotMatch(`${sidebar}\n${chatView}`, /此操作不可撤销/);
  assert.match(confirmDialog, /onClick=\{onCancel\}[\s\S]*?disabled=\{pending\}[\s\S]*?onClick=\{\(\) => void handleConfirm\(\)\}[\s\S]*?disabled=\{pending \|\| confirmDisabled\}/);
});

test('上传清理突出项目、数量和大小', () => {
  assert.match(uploads, /subject=\{project \?/);
  assert.match(uploads, /selected\.size/);
  assert.match(uploads, /selectedCleanupStats\.releasableBytes/);
  assert.match(uploads, /allCleanupStats\.releasableBytes/);
  assert.match(uploads, /data\.files\.length/);
  assert.doesNotMatch(uploads, /formatBytes\(data\?\.usage\.usedBytes \|\| 0\)/);
  assert.match(uploads, /历史消息仍会保留附件摘要/);
});

test('停止、退出登录和服务维护使用符合风险的语义层级', () => {
  assert.match(chatInput, /tone="warning"/);
  assert.match(chatInput, /已经生成的内容会保留/);
  assert.match(sidebar, /title="退出登录"[\s\S]*?tone="neutral"/);
  assert.match(sidebar, /仅当前设备的登录状态会失效/);
  assert.match(maintenance, /function confirmationPresentation/);
  assert.match(maintenance, /activeTaskCount/);
  assert.match(maintenance, /tone=\{pendingPresentation\?\.tone/);
  assert.match(maintenance, /subject=\{pendingPresentation\?\.subject/);
  assert.match(maintenance, /impacts=\{pendingPresentation\?\.impacts/);
  assert.match(maintenance, /notice=\{pendingPresentation\?\.notice/);
});

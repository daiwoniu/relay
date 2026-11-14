import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  formatChangedFileSize,
  getChangedFilePresentation,
  getChangedFilesTitle,
  resolveChangedFilePreviewPath,
  resolveProjectFilePath,
  splitChangedFilePath,
} from './changed-files-view.ts';

const summarySource = fs.readFileSync(new URL('./ChangedFilesSummary.tsx', import.meta.url), 'utf8');
const assistantSource = fs.readFileSync(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');
const incompleteNoticeSource = fs.readFileSync(new URL('./ChangedFilesIncompleteNotice.tsx', import.meta.url), 'utf8');

test('变更文件标题使用不偏向单一操作的重叠文件图标', () => {
  assert.match(summarySource, /data-icon="file-stack"/);
  assert.doesNotMatch(summarySource, /M5\.8 9\.2h4\.4M8 7v4\.4/);
});

test('根据单一或混合变更类型生成准确标题', () => {
  assert.equal(getChangedFilesTitle([{ changeType: 'added' }], 'completed'), '此次新增了 1 个文件');
  assert.equal(getChangedFilesTitle([{ changeType: 'modified' }, { changeType: 'modified' }], 'completed'), '此次修改了 2 个文件');
  assert.equal(getChangedFilesTitle([{ changeType: 'deleted' }], 'completed'), '此次删除了 1 个文件');
  assert.equal(getChangedFilesTitle([{ changeType: 'added' }, { changeType: 'modified' }], 'completed'), '此次变更了 2 个文件');
});

test('异常终态统一显示处理期间变更文件', () => {
  assert.equal(getChangedFilesTitle([{ changeType: 'added' }, { changeType: 'deleted' }], 'failed'), '处理期间变更了 2 个文件');
  assert.equal(getChangedFilesTitle([{ changeType: 'modified' }], 'stopped'), '处理期间变更了 1 个文件');
});

test('拆分文件名和目录并解析桌面与 Unix 项目路径', () => {
  assert.deepEqual(splitChangedFilePath('client/src/App.tsx'), { name: 'App.tsx', directory: 'client/src' });
  assert.deepEqual(splitChangedFilePath('README.md'), { name: 'README.md', directory: '' });
  assert.equal(resolveProjectFilePath('G:\\AI\\relay', 'client/src/App.tsx'), 'G:\\AI\\relay\\client\\src\\App.tsx');
  assert.equal(resolveProjectFilePath('/srv/relay/', 'client/src/App.tsx'), '/srv/relay/client/src/App.tsx');
  assert.throws(() => resolveProjectFilePath('/srv/relay', '../secret.txt'), /不在当前项目内/);
  assert.throws(() => resolveProjectFilePath('/srv/relay', 'C:\\secret.txt'), /不在当前项目内/);
});

test('外部文件直接使用绝对路径，项目内文件继续拼接项目根目录', () => {
  assert.equal(resolveChangedFilePreviewPath(
    { path: 'client/src/App.tsx', changeType: 'modified' },
    'G:\\AI\\relay',
  ), 'G:\\AI\\relay\\client\\src\\App.tsx');
  assert.equal(resolveChangedFilePreviewPath(
    { path: 'E:\\office\\outside.txt', changeType: 'modified', external: true },
    'G:\\AI\\relay',
  ), 'E:\\office\\outside.txt');
  assert.throws(() => resolveChangedFilePreviewPath(
    { path: 'E:\\office\\outside.txt', changeType: 'modified' },
    'G:\\AI\\relay',
  ), /不在当前项目内/);
  assert.throws(() => resolveChangedFilePreviewPath(
    { path: 'outside.txt', changeType: 'modified', external: true },
    'G:\\AI\\relay',
  ), /外部文件路径无效/);
});

test('修改类型同时提供文字与符号语义', () => {
  assert.deepEqual(getChangedFilePresentation('added'), { marker: '+', label: '新增', tone: 'added' });
  assert.deepEqual(getChangedFilePresentation('modified'), { marker: 'M', label: '修改', tone: 'modified' });
  assert.deepEqual(getChangedFilePresentation('deleted'), { marker: '−', label: '已删除', tone: 'deleted' });
});

test('文件大小按可读单位显示，缺失大小保持空白', () => {
  assert.equal(formatChangedFileSize(undefined), '');
  assert.equal(formatChangedFileSize(0), '0 B');
  assert.equal(formatChangedFileSize(999), '999 B');
  assert.equal(formatChangedFileSize(1536), '1.5 KB');
  assert.equal(formatChangedFileSize(2 * 1024 * 1024), '2.0 MB');
});

test('文件列表右侧只显示已有大小，不重复显示变更类型', () => {
  assert.match(summarySource, /const sizeLabel = formatChangedFileSize\(file\.size\)/);
  assert.match(summarySource, /\{sizeLabel && <span className="changed-file-row__size">\{sizeLabel\}<\/span>\}/);
  assert.doesNotMatch(summarySource, /changed-file-row__type/);
  assert.doesNotMatch(summarySource, />\{presentation\.label\}<\/span>/);
});

test('文件回执明确提示不完整状态并在移动端显示当前数量与总数', () => {
  assert.match(incompleteNoticeSource, /文件列表可能不完整/);
  assert.match(incompleteNoticeSource, /border-\[var\(--color-notice-attention-border\)\]/);
  assert.match(incompleteNoticeSource, /bg-\[var\(--color-notice-attention-bg\)\]/);
  assert.match(incompleteNoticeSource, /text-\[var\(--color-status-warning\)\]/);
  assert.match(summarySource, /<ChangedFilesIncompleteNotice \/>/);
  assert.match(assistantSource, /<ChangedFilesIncompleteNotice \/>/);
  assert.doesNotMatch(assistantSource, /文件列表可能不完整：本轮有普通写命令未提供结构化文件回执。/);
  assert.match(summarySource, /当前显示 \{visibleFiles\.length\} \/ \{files\.length\} 个/);
  assert.match(summarySource, /changedFilesIncomplete/);
  assert.ok(
    summarySource.indexOf('{changedFilesIncomplete && (') < summarySource.indexOf('{displayExpanded && ('),
    '不完整提示必须位于折叠内容之外',
  );
});

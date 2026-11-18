import test from 'node:test';
import assert from 'node:assert/strict';
import { getProcessFileResources, areProcessFilesEqual } from './process-file-resources.ts';

const context = { projectPath: 'D:/project' };
const step = (type, details, status = 'completed') => ({ id: 's', type, status, details });
test('步骤仅更新时间时文件清单保持等价，真实状态/顺序/路径变化仍刷新', () => {
  const original = step('fileChange', { changes: [{ path: 'a.png', changeType: 'added' }, { path: 'b.png', changeType: 'modified' }] });
  const previous = getProcessFileResources(original, context);
  const next = getProcessFileResources({ ...original, details: { ...original.details, completedObservedAt: 20 } }, context);
  assert.notEqual(previous, next);
  assert.equal(areProcessFilesEqual(previous, next), true);
  for (const update of [{ path: 'D:/project/c.png' }, { action: '删除', deleted: true }, { thumbnailAllowed: false }]) {
    assert.equal(areProcessFilesEqual(previous, [{ ...next[0], ...update }, next[1]]), false);
  }
  assert.equal(areProcessFilesEqual(previous, [...next].reverse()), false);
  assert.equal(areProcessFilesEqual(previous, next.slice(0, 1)), false);
});
test('文件按步骤cwd解析、规范化去重，逐文件保留删除标记', () => {
  const files = getProcessFileResources(step('fileChange', { cwd: 'src/', changes: [
    { path: '../assets/a.png', kind: { type: 'add' } },
    { path: 'D:\\project\\assets\\A.png', changeType: 'modified' },
    { path: '../old.txt', changeType: 'delete' },
  ] }), context);
  assert.equal(files.length, 2);
  assert.equal(files[0].path.toLowerCase(), 'd:/project/assets/a.png');
  assert.equal(files[0].thumbnailAllowed, true);
  assert.equal(files[1].deleted, true);
});
test('成功上报可展示；失败、截断参数、远程工具、任意命令均不猜文件', () => {
  const arguments_ = JSON.stringify({ reportedFileChanges: [{ path: 'a.png', changeType: 'added' }] });
  const details = { tool: 'relay_report_file_changes', success: true, arguments: arguments_ };
  assert.equal(getProcessFileResources(step('dynamicToolCall', details), context).length, 1);
  for (const d of [{ ...details, success: false }, { ...details, arguments: '{' }, { ...details, server: 'remote' }]) {
    assert.deepEqual(getProcessFileResources(step('dynamicToolCall', d), context), []);
  }
  for (const type of ['commandExecution', 'mcpToolCall']) assert.deepEqual(getProcessFileResources(step(type, { ...details, path: 'a.png', command: 'cat a.png' }), context), []);
});

test('有结构化上报清单时不依赖截断参数，不重复合并同一份文件', () => {
  const details = { tool: 'relay_report_file_changes', success: true, arguments: '{truncated', fileChanges: [{ path: 'a.png', changeType: 'added' }, { path: 'b.png', changeType: 'deleted' }] };
  const files = getProcessFileResources(step('dynamicToolCall', details), context);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'D:/project/a.png');
  assert.equal(files[1].deleted, true);
  assert.deepEqual(getProcessFileResources(step('dynamicToolCall', { ...details, success: false }), context), []);
});
test('外部文件不自动加载缩略图，URI/目录/变量路径被排除，公开分享不输出文件', () => {
  const outside = getProcessFileResources(step('imageView', { path: '../other/a.png' }), context);
  assert.equal(outside[0].path, 'D:/other/a.png');
  assert.equal(outside[0].thumbnailAllowed, false);
  for (const path of ['https://a/a.png', 'file:///a.png', 'D:relative.png', '$HOME/a.png', 'assets/']) {
    assert.deepEqual(getProcessFileResources(step('imageView', { path }), context), []);
  }
  assert.deepEqual(getProcessFileResources(step('imageView', { path: 'a.png' }), { ...context, readOnly: true }), []);
  assert.deepEqual(getProcessFileResources(step('imageView', { path: 'a.png' }), {}), []);
});
test('图片生成仅使用当前步骤明确保存路径，不使用result或其他轮文件；本地Read支持file_path', () => {
  assert.equal(getProcessFileResources(step('imageGeneration', { savedPath: 'out.png' }), context)[0].path, 'D:/project/out.png');
  assert.deepEqual(getProcessFileResources(step('imageGeneration', { result: 'out.png' }), context), []);
  assert.deepEqual(getProcessFileResources(step('imageGeneration', { savedPath: 'out.png' }, 'incomplete'), context), []);
  assert.equal(getProcessFileResources(step('dynamicToolCall', { tool: 'Read', input: { file_path: 'a.ts' } }), context)[0].path, 'D:/project/a.ts');
});
test('UNC、POSIX和驱动器根目录保持正确；不同POSIX大小写路径不合并', () => {
  assert.equal(getProcessFileResources(step('imageView', { path: '\\\\host\\share\\a.png' }), context)[0].path, '//host/share/a.png');
  assert.equal(getProcessFileResources(step('imageView', { path: 'a.png' }), { projectPath: '/' })[0].path, '/a.png');
  assert.equal(getProcessFileResources(step('imageView', { path: 'a.png' }), { projectPath: 'D:/' })[0].path, 'D:/a.png');
  assert.equal(getProcessFileResources(step('fileChange', { changes: [{ path: 'A.png' }, { path: 'a.png' }] }), { projectPath: '/project' }).length, 2);
});

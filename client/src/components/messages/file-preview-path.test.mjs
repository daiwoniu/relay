import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFilePreviewPath } from './file-preview-path.ts';
import { resolveCodexFileReferencePathResult } from './codex-file-directives.ts';

const context = {
  activeSessionId: 'session-a',
  currentProjectId: 'project-b',
  sessions: [{ id: 'session-a', project_id: 'project-a' }],
  projects: [
    { id: 'project-a', path: 'D:\\projects\\sample-workspace' },
    { id: 'project-b', path: '/other-project' },
  ],
};

test('相对文件路径按会话项目补全，兼容混合分隔符和 ./ 前缀', () => {
  const file = 'tasks/task-a/output/report-20261120.csv';
  assert.deepEqual(resolveFilePreviewPath(file, context), {
    ok: true,
    path: `${context.projects[0].path}\\${file.replaceAll('/', '\\')}`,
  });
  assert.deepEqual(resolveFilePreviewPath('./output\\report.csv', context), {
    ok: true, path: `${context.projects[0].path}\\output\\report.csv`,
  });
});

test('消息指定项目优先；无会话时使用当前项目', () => {
  assert.deepEqual(resolveFilePreviewPath('output/report.csv', context, '/message-project'), {
    ok: true, path: '/message-project/output/report.csv',
  });
  assert.deepEqual(resolveFilePreviewPath('report.csv', { ...context, activeSessionId: null }), {
    ok: true, path: '/other-project/report.csv',
  });
});

test('绝对路径保留；缺失会话项目不会误用其他项目或服务目录', () => {
  for (const path of ['D:\\output\\report.csv', '/tmp/report.csv', '\\\\host\\share\\report.csv']) {
    assert.deepEqual(resolveFilePreviewPath(path, context), { ok: true, path });
  }
  assert.equal(resolveFilePreviewPath('report.csv', { ...context, sessions: [] }).ok, false);
  assert.equal(resolveFilePreviewPath('../report.csv', context).ok, false);
  assert.equal(resolveFilePreviewPath('https://example.com/report.csv', context).ok, false);
});

test('刷新仅接受已补全路径，不按新项目重新解释错误标签中的相对路径', () => {
  const initial = resolveFilePreviewPath('output/report.csv', context);
  assert.equal(initial.ok, true);
  assert.deepEqual(resolveCodexFileReferencePathResult(initial.path), initial);
  assert.equal(resolveCodexFileReferencePathResult('output/report.csv').ok, false);
  assert.equal(resolveCodexFileReferencePathResult('../report.csv').ok, false);
});

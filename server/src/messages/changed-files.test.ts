import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectChangedFiles, hasIncompleteChangedFilesReport } from './changed-files.js';
import { RELAY_FILE_CHANGE_REPORT_TOOL_SPEC } from './file-change-report.js';

test('Relay 文件回执工具明确要求每次非 apply_patch 写入后重新报告', () => {
  assert.match(RELAY_FILE_CHANGE_REPORT_TOOL_SPEC.description, /必须调用/);
  assert.match(RELAY_FILE_CHANGE_REPORT_TOOL_SPEC.description, /每次后续写入都必须重新报告/);
});

test('高置信度写命令缺少后续结构化报告时标记文件列表可能不完整', () => {
  assert.equal(hasIncompleteChangedFilesReport([{
    type: 'commandExecution', status: 'completed', exitCode: 0,
    command: "Move-Item -LiteralPath 'old' -Destination 'new'",
  }]), true);
  assert.equal(hasIncompleteChangedFilesReport([{
    type: 'commandExecution', status: 'completed', exitCode: 0,
    command: 'python scripts/task_registry.py generate',
  }]), true);
  assert.equal(hasIncompleteChangedFilesReport([{
    type: 'commandExecution', status: 'completed', exitCode: 1,
    command: "Set-Content -LiteralPath 'a.txt' -Value x",
  }]), false);
  assert.equal(hasIncompleteChangedFilesReport([{
    type: 'commandExecution', status: 'completed', exitCode: 0,
    command: "Get-Content -LiteralPath 'a.txt'",
  }]), false);
  assert.equal(hasIncompleteChangedFilesReport([{
    type: 'commandExecution', status: 'completed', exitCode: 0,
    command: 'node -e "console.log(1 > 0)"',
  }]), false);
  assert.equal(hasIncompleteChangedFilesReport([{
    type: 'commandExecution', status: 'completed', exitCode: 0,
    command: "rg 'a > b' src",
  }]), false);
  assert.equal(hasIncompleteChangedFilesReport([{
    type: 'commandExecution', status: 'completed', exitCode: 0,
    command: 'echo result > output.txt',
  }]), true);
});

test('后续 Relay 结构化报告清除写命令的未报告状态', () => {
  assert.equal(hasIncompleteChangedFilesReport([
    {
      type: 'commandExecution', status: 'completed', exitCode: 0,
      command: "Add-Content -LiteralPath 'a.txt' -Value x",
    },
    {
      type: 'dynamicToolCall', status: 'completed', success: true, namespace: null,
      tool: 'relay_report_file_changes',
      arguments: { version: 1, reportedFileChanges: [{ path: 'a.txt', changeType: 'modified' }] },
    },
  ]), false);
  assert.equal(hasIncompleteChangedFilesReport([
    {
      type: 'commandExecution', status: 'completed', exitCode: 0,
      command: "Set-Content -LiteralPath 'a.txt' -Value x",
    },
    {
      type: 'dynamicToolCall', status: 'completed', success: true, namespace: null,
      tool: 'relay_report_file_changes',
      arguments: { version: 1, reportedFileChanges: [{ path: 'a.txt', changeType: 'modified' }] },
    },
    {
      type: 'commandExecution', status: 'completed', exitCode: 0,
      command: "Remove-Item -LiteralPath 'b.txt'",
    },
  ]), true);
});

test('图片生成回执不会清除先前普通写命令的未报告状态', () => {
  assert.equal(hasIncompleteChangedFilesReport([
    {
      type: 'commandExecution', status: 'completed', exitCode: 0,
      command: "Set-Content -LiteralPath 'a.txt' -Value x",
    },
    {
      type: 'imageGeneration', status: 'completed', savedPath: 'generated.png',
    },
  ]), true);
});

test('结构化报告只有全部路径通过项目最终状态校验时才清除未报告状态', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-incomplete-report-'));
  try {
    fs.writeFileSync(path.join(projectRoot, 'confirmed.txt'), 'ok');
    const write = {
      type: 'commandExecution', status: 'completed', exitCode: 0,
      command: "Set-Content -LiteralPath 'confirmed.txt' -Value ok",
    };
    const report = (filePath: string) => ({
      type: 'dynamicToolCall', status: 'completed', success: true, namespace: null,
      tool: 'relay_report_file_changes',
      arguments: { version: 1, reportedFileChanges: [{ path: filePath, changeType: 'modified' }] },
    });
    assert.equal(hasIncompleteChangedFilesReport([write, report('missing.txt')], projectRoot), true);
    assert.equal(hasIncompleteChangedFilesReport([write, report('../outside.txt')], projectRoot), true);
    assert.equal(hasIncompleteChangedFilesReport([write, report('confirmed.txt')], projectRoot), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

const PROJECT_ROOT = 'G:\\AI\\relay\\workspace';

test('从 fileChange 和 apply_patch 提取项目内文件并保持首次出现顺序', () => {
  assert.deepEqual(collectChangedFiles([
    {
      id: 'change-1',
      type: 'fileChange',
      status: 'completed',
      changes: [
        { path: 'src/app.ts', kind: { type: 'update', move_path: null }, diff: '' },
        { path: 'src/new.ts', kind: { type: 'add' }, diff: '' },
      ],
    },
    {
      id: 'patch-1',
      type: 'dynamicToolCall',
      toolName: 'apply_patch',
      arguments: { patch: '*** Update File: G:\\AI\\relay\\workspace\\src\\app.ts\n*** Delete File: src/old.ts' },
    },
  ], PROJECT_ROOT), [
    { path: 'src/app.ts', changeType: 'modified' },
    { path: 'src/new.ts', changeType: 'added' },
    { path: 'src/old.ts', changeType: 'deleted' },
  ]);
});

test('按真实 Codex 协议识别删除和移动操作', () => {
  assert.deepEqual(collectChangedFiles([
    {
      id: 'change-1',
      type: 'fileChange',
      status: 'completed',
      changes: [
        { path: 'src/old.ts', kind: { type: 'delete' }, diff: '' },
        { path: 'src/before.ts', kind: { type: 'update', move_path: 'src/after.ts' }, diff: '' },
      ],
    },
  ], PROJECT_ROOT), [
    { path: 'src/old.ts', changeType: 'deleted' },
    { path: 'src/before.ts', changeType: 'deleted' },
    { path: 'src/after.ts', changeType: 'added' },
  ]);
});

test('拒绝、失败和未完成的文件操作不进入修改回执', () => {
  assert.deepEqual(collectChangedFiles([
    { id: 'declined', type: 'fileChange', status: 'declined', changes: [{ path: 'src/declined.ts', kind: { type: 'add' }, diff: '' }] },
    { id: 'failed', type: 'fileChange', status: 'failed', changes: [{ path: 'src/failed.ts', kind: { type: 'delete' }, diff: '' }] },
    { id: 'running', type: 'fileChange', status: 'inProgress', changes: [{ path: 'src/running.ts', kind: { type: 'update', move_path: null }, diff: '' }] },
    { id: 'tool-failed', type: 'dynamicToolCall', tool: 'apply_patch', status: 'failed', success: false, arguments: { patch: '*** Add File: src/tool-failed.ts' } },
    { id: 'completed', type: 'fileChange', status: 'completed', changes: [{ path: 'src/completed.ts', kind: { type: 'add' }, diff: '' }] },
  ], PROJECT_ROOT), [
    { path: 'src/completed.ts', changeType: 'added' },
  ]);
});

test('按最终生命周期聚合并移除新增后删除的临时文件', () => {
  assert.deepEqual(collectChangedFiles([
    { id: 'add-temp', type: 'fileChange', path: 'tmp/check.mjs', changeType: 'add' },
    { id: 'edit-temp', type: 'fileChange', path: 'tmp/check.mjs', changeType: 'update' },
    { id: 'delete-temp', type: 'fileChange', path: 'tmp/check.mjs', changeType: 'delete' },
    { id: 'edit-existing', type: 'fileChange', path: 'src/existing.ts', changeType: 'update' },
    { id: 'delete-existing', type: 'fileChange', path: 'src/existing.ts', changeType: 'delete' },
    { id: 'delete-replaced', type: 'fileChange', path: 'src/replaced.ts', changeType: 'delete' },
    { id: 'add-replaced', type: 'fileChange', path: 'src/replaced.ts', changeType: 'add' },
  ], PROJECT_ROOT), [
    { path: 'src/existing.ts', changeType: 'deleted' },
    { path: 'src/replaced.ts', changeType: 'modified' },
  ]);
});

test('支持 fileChanges 对象并拒绝越界、目录和读取类工具', () => {
  assert.deepEqual(collectChangedFiles([
    {
      id: 'approval',
      type: 'fileChange',
      details: {
        fileChanges: {
          'src/a.ts': { type: 'update' },
          'src/b.ts': { type: 'create' },
        },
      },
    },
    { id: 'outside', type: 'fileChange', path: '..\\secret.txt', changeType: 'update' },
    { id: 'control', type: 'fileChange', path: "src/broken\nname.ts", changeType: 'update' },
    { id: 'directory', type: 'fileChange', path: 'src/', changeType: 'update' },
    { id: 'read', type: 'dynamicToolCall', toolName: 'read_file', arguments: 'src/ignored.ts' },
  ], PROJECT_ROOT), [
    { path: 'src/a.ts', changeType: 'modified' },
    { path: 'src/b.ts', changeType: 'added' },
  ]);
});

test('没有项目根目录时只接受安全相对路径', () => {
  assert.deepEqual(collectChangedFiles([
    { id: 'relative', type: 'fileChange', path: '.\\src\\app.ts', changeType: 'update' },
    { id: 'absolute', type: 'fileChange', path: 'G:\\outside\\secret.ts', changeType: 'update' },
  ]), [
    { path: 'src/app.ts', changeType: 'modified' },
  ]);
});

test('可信原生 fileChange 保留项目外绝对路径并标记外部文件', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-project-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-outside-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'inside.txt'), 'inside');
    const outsideFile = path.join(outsideRoot, 'outside.txt');
    const deletedOutsideFile = path.join(outsideRoot, 'deleted.txt');
    fs.writeFileSync(outsideFile, 'outside');

    assert.deepEqual(collectChangedFiles([{
      type: 'fileChange',
      status: 'completed',
      changes: [
        { path: path.join(projectRoot, 'src', 'inside.txt'), kind: { type: 'update' } },
        { path: outsideFile, kind: { type: 'update' } },
        { path: deletedOutsideFile, kind: { type: 'delete' } },
      ],
    }], projectRoot), [
      { path: 'src/inside.txt', changeType: 'modified', size: 6 },
      { path: path.normalize(outsideFile), changeType: 'modified', size: 7, external: true },
      { path: path.normalize(deletedOutsideFile), changeType: 'deleted', external: true },
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('项目根目录为链接时按真实路径识别项目内文件', () => {
  const realProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-real-project-'));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-link-parent-'));
  const linkedProjectRoot = path.join(linkParent, 'project-link');
  try {
    fs.mkdirSync(path.join(realProjectRoot, 'src'));
    const filePath = path.join(realProjectRoot, 'src', 'app.txt');
    fs.writeFileSync(filePath, 'project file');
    fs.symlinkSync(realProjectRoot, linkedProjectRoot, process.platform === 'win32' ? 'junction' : 'dir');

    assert.deepEqual(collectChangedFiles([{
      type: 'fileChange', status: 'completed', path: filePath, changeType: 'update',
    }], linkedProjectRoot), [{
      path: 'src/app.txt', changeType: 'modified', size: 12,
    }]);
  } finally {
    fs.rmSync(linkedProjectRoot, { recursive: true, force: true });
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(realProjectRoot, { recursive: true, force: true });
  }
});

test('项目内以两个点开头的合法文件名不会被误判为越界', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dot-prefix-project-'));
  try {
    const filePath = path.join(projectRoot, '..config');
    fs.writeFileSync(filePath, 'config');

    assert.deepEqual(collectChangedFiles([{
      type: 'fileChange', status: 'completed', path: filePath, changeType: 'update',
    }], projectRoot), [{
      path: '..config', changeType: 'modified', size: 6,
    }]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('项目内链接跳到外部时按真实目标标记外部文件', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-linked-project-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-linked-outside-'));
  const linkedOutside = path.join(projectRoot, 'linked-outside');
  try {
    const outsideFile = path.join(outsideRoot, 'outside.txt');
    const deletedOutsideFile = path.join(outsideRoot, 'deleted.txt');
    fs.writeFileSync(outsideFile, 'outside');
    fs.symlinkSync(outsideRoot, linkedOutside, process.platform === 'win32' ? 'junction' : 'dir');

    assert.deepEqual(collectChangedFiles([{
      type: 'fileChange',
      status: 'completed',
      changes: [
        { path: path.join(linkedOutside, 'outside.txt'), kind: { type: 'update' } },
        { path: path.join(linkedOutside, 'deleted.txt'), kind: { type: 'delete' } },
      ],
    }], projectRoot), [
      { path: path.normalize(outsideFile), changeType: 'modified', size: 7, external: true },
      { path: path.normalize(deletedOutsideFile), changeType: 'deleted', external: true },
    ]);
  } finally {
    fs.rmSync(linkedOutside, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('新增和修改文件记录本轮结束时大小，删除与符号链接不记录', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-changed-size-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'added.txt'), '新增内容');
    fs.writeFileSync(path.join(projectRoot, 'src', 'modified.txt'), 'modified');
    const items: unknown[] = [
      { type: 'fileChange', status: 'completed', path: 'src/added.txt', changeType: 'add' },
      { type: 'fileChange', status: 'completed', path: 'src/modified.txt', changeType: 'update' },
      { type: 'fileChange', status: 'completed', path: 'src/deleted.txt', changeType: 'delete' },
    ];
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(projectRoot, 'src', 'added.txt'), path.join(projectRoot, 'src', 'linked.txt'));
      items.push({ type: 'fileChange', status: 'completed', path: 'src/linked.txt', changeType: 'add' });
    }

    assert.deepEqual(collectChangedFiles(items, projectRoot), [
      { path: 'src/added.txt', changeType: 'added', size: Buffer.byteLength('新增内容') },
      { path: 'src/modified.txt', changeType: 'modified', size: 8 },
      { path: 'src/deleted.txt', changeType: 'deleted' },
      ...(process.platform === 'win32' ? [] : [{ path: 'src/linked.txt', changeType: 'added' as const }]),
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('从 Relay 自有动态工具和图片 savedPath 提取文件回执', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reported-files-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'output'));
    fs.mkdirSync(path.join(projectRoot, 'clips'));
    fs.writeFileSync(path.join(projectRoot, 'output', 'cover.png'), 'png');
    fs.writeFileSync(path.join(projectRoot, 'clips', 'demo.mp4'), 'clip');

    assert.deepEqual(collectChangedFiles([
      {
        type: 'dynamicToolCall',
        status: 'completed',
        success: true,
        namespace: null,
        tool: 'relay_report_file_changes',
        arguments: {
          version: 1,
          reportedFileChanges: [
            { path: 'output/cover.png', changeType: 'added' },
            { path: 'tmp/old.txt', changeType: 'deleted' },
          ],
        },
      },
      {
        type: 'imageGeneration',
        status: 'completed',
        savedPath: path.join(projectRoot, 'clips', 'demo.mp4'),
      },
    ], projectRoot), [
      { path: 'output/cover.png', changeType: 'added', size: 3 },
      { path: 'tmp/old.txt', changeType: 'deleted' },
      { path: 'clips/demo.mp4', changeType: 'added', size: 4 },
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('结构化文件报告只接受完成的 Relay 自有工具、版本 1 和项目内最终文件', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reported-files-safe-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'valid'));
    fs.mkdirSync(path.join(projectRoot, 'directory'));
    fs.writeFileSync(path.join(projectRoot, 'valid', 'kept.txt'), 'kept');
    const argumentsValue = {
      version: 1,
      reportedFileChanges: [{ path: 'valid/kept.txt', changeType: 'modified' }],
    };

    assert.deepEqual(collectChangedFiles([
      { type: 'dynamicToolCall', status: 'failed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: argumentsValue },
      { type: 'dynamicToolCall', status: 'cancelled', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: argumentsValue },
      { type: 'dynamicToolCall', status: 'completed', success: false, namespace: null, tool: 'relay_report_file_changes', arguments: argumentsValue },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: 'other', tool: 'relay_report_file_changes', arguments: argumentsValue },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'other_tool', arguments: argumentsValue },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: { ...argumentsValue, version: 2 } },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: { reportedFileChanges: argumentsValue.reportedFileChanges } },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: { version: 1, reportedFileChanges: [{ path: path.resolve(projectRoot, '..', 'outside.txt'), changeType: 'modified' }] } },
      { type: 'mcpToolCall', status: 'completed', result: { structuredContent: argumentsValue } },
      { type: 'commandExecution', status: 'completed', output: argumentsValue },
      { type: 'reasoning', status: 'completed', arguments: argumentsValue },
      { type: 'imageGeneration', status: 'failed', savedPath: path.join(projectRoot, 'valid', 'kept.txt') },
      { type: 'imageGeneration', status: 'completed', savedPath: path.join(projectRoot, '..', 'outside.png') },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: { version: 1, reportedFileChanges: [{ path: 'valid/kept.txt', changeType: 'updated' }] } },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: { version: 1, reportedFileChanges: [{ path: '../outside.txt', changeType: 'modified' }] } },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: { version: 1, reportedFileChanges: [{ path: 'directory/', changeType: 'added' }] } },
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: { version: 1, reportedFileChanges: [{ path: 'valid/missing.txt', changeType: 'added' }] } },
    ], projectRoot), []);

    assert.deepEqual(collectChangedFiles([
      { type: 'dynamicToolCall', status: 'completed', success: true, namespace: null, tool: 'relay_report_file_changes', arguments: argumentsValue },
    ]), []);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('结构化文件报告与原生编辑记录共用生命周期合并', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reported-files-merge-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'existing.ts'), 'updated');

    assert.deepEqual(collectChangedFiles([
      { type: 'fileChange', status: 'completed', path: 'tmp/generated.txt', changeType: 'add' },
      {
        type: 'dynamicToolCall',
        status: 'completed',
        success: true,
        namespace: null,
        tool: 'relay_report_file_changes',
        arguments: {
          version: 1,
          reportedFileChanges: [{ path: 'tmp/generated.txt', changeType: 'deleted' }],
        },
      },
      {
        type: 'dynamicToolCall',
        status: 'completed',
        toolName: 'apply_patch',
        arguments: { patch: '*** Update File: src/existing.ts' },
      },
    ], projectRoot), [
      { path: 'src/existing.ts', changeType: 'modified', size: 7 },
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('结构化删除报告只在目标最终不存在且父路径未越界时接受', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reported-delete-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reported-delete-outside-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'still-there.txt'), '保留');
    const items: unknown[] = [{
      type: 'dynamicToolCall',
      status: 'completed',
      success: true,
      namespace: null,
      tool: 'relay_report_file_changes',
      arguments: {
        version: 1,
        reportedFileChanges: [
          { path: 'src/still-there.txt', changeType: 'deleted' },
          { path: 'src/gone.txt', changeType: 'deleted' },
        ],
      },
    }];
    if (process.platform !== 'win32') {
      fs.symlinkSync(outsideRoot, path.join(projectRoot, 'outside-link'), 'dir');
      fs.symlinkSync(path.join(outsideRoot, 'missing-target'), path.join(projectRoot, 'dangling-link'), 'dir');
      (items[0] as any).arguments.reportedFileChanges.push({
        path: 'outside-link/gone.txt',
        changeType: 'deleted',
      });
      (items[0] as any).arguments.reportedFileChanges.push({
        path: 'dangling-link/gone.txt',
        changeType: 'deleted',
      });
    }

    assert.deepEqual(collectChangedFiles(items, projectRoot), [
      { path: 'src/gone.txt', changeType: 'deleted' },
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('编辑类动态工具按 input.file_path 提取修改回执', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-edit-tool-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-edit-tool-outside-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'reports'));
    fs.writeFileSync(path.join(projectRoot, 'reports', 'yhc-source-records.md'), '内容');
    fs.writeFileSync(path.join(outsideRoot, 'external.md'), '内容');

    assert.deepEqual(collectChangedFiles([
      {
        // 真实 ZCode 落库形态：details.toolName + details.input.file_path
        id: 'call-edit-1',
        type: 'dynamicToolCall',
        status: 'completed',
        details: {
          toolName: 'Edit',
          title: 'Edit',
          input: {
            file_path: path.join(projectRoot, 'reports', 'yhc-source-records.md'),
            old_string: '旧',
            new_string: '新',
          },
        },
      },
      {
        // 顶层形态（CodeBuddy/其他适配器）：toolName + input
        id: 'call-write-1',
        type: 'dynamicToolCall',
        status: 'completed',
        toolName: 'Write',
        input: { file_path: 'src/generated.ts' },
      },
      { id: 'call-read', type: 'dynamicToolCall', status: 'completed', details: { toolName: 'Read', input: { file_path: 'src/app.ts' } } },
      { id: 'call-bash', type: 'dynamicToolCall', status: 'completed', details: { toolName: 'Bash', input: { command: 'echo hi > out.txt' } } },
      { id: 'edit-failed', type: 'dynamicToolCall', status: 'failed', details: { toolName: 'Edit', input: { file_path: 'src/failed.ts' } } },
      {
        id: 'edit-outside',
        type: 'dynamicToolCall',
        status: 'completed',
        details: { toolName: 'Edit', input: { file_path: path.join(outsideRoot, 'external.md') } },
      },
    ], projectRoot), [
      { path: 'reports/yhc-source-records.md', changeType: 'modified', size: 6 },
      { path: 'src/generated.ts', changeType: 'modified' },
      { path: path.join(outsideRoot, 'external.md'), changeType: 'modified', external: true, size: 6 },
    ]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

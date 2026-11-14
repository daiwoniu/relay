import assert from 'node:assert/strict';
import test from 'node:test';

test('普通与异步提问显示问题标题而不是授权权限用途', () => {
  for (const kind of ['user_input', 'async_question']) {
    assert.deepEqual(getApprovalPresentation({kind,fallbackTitle:'Which environment?',details:{}}),{typeLabel:'提问',purpose:'Which environment?'});
  }
});
import { getApprovalPresentation } from './approval-presentation.ts';

test('命令授权优先显示去除询问包装后的中文目的', () => {
  assert.deepEqual(getApprovalPresentation({
    kind: 'command_approval',
    fallbackTitle: '需要授权执行命令',
    details: { reason: ' 是否允许我通过项目只读脚本核查数据库索引？ ' },
  }), {
    typeLabel: '命令',
    purpose: '通过项目只读脚本核查数据库索引',
  });
});

test('没有中文目的时回退当前默认描述', () => {
  assert.deepEqual(getApprovalPresentation({
    kind: 'command_approval',
    fallbackTitle: '执行命令需要确认',
    details: { reason: 'Run npm test?' },
  }), {
    typeLabel: '命令',
    purpose: '执行命令需要确认',
  });
});

test('收起目的隐藏内联命令和疑似完整参数', () => {
  assert.deepEqual(getApprovalPresentation({
    kind: 'command_approval',
    fallbackTitle: '需要授权执行命令',
    details: { reason: '是否允许运行 `npm test -- --token=secret` 验证前端？' },
  }), {
    typeLabel: '命令',
    purpose: '运行相关命令验证前端',
  });
  assert.deepEqual(getApprovalPresentation({
    kind: 'file_approval',
    fallbackTitle: '需要授权修改文件',
    details: { reason: '是否允许修改 G:\\AI\\relay\\config\\relay.conf 并使用 --force？' },
  }), {
    typeLabel: '文件',
    purpose: '需要授权修改文件',
  });
  assert.deepEqual(getApprovalPresentation({
    kind: 'command_approval',
    fallbackTitle: '需要授权执行命令',
    details: { reason: '是否允许执行 SELECT id, name FROM users 验证数据？' },
  }), {
    typeLabel: '命令',
    purpose: '需要授权执行命令',
  });
  assert.deepEqual(getApprovalPresentation({
    kind: 'command_approval',
    fallbackTitle: '需要授权执行命令',
    details: { reason: '是否允许使用 Get-Content \\\\server\\share\\relay.conf 检查配置？' },
  }), {
    typeLabel: '命令',
    purpose: '需要授权执行命令',
  });
});

test('网络目的不直接展示完整访问地址', () => {
  assert.deepEqual(getApprovalPresentation({
    kind: 'permissions_approval',
    fallbackTitle: '需要授予额外权限',
    details: {
      reason: '是否允许访问 https://registry.example.com/private?token=secret？',
      networkApprovalContext: { host: 'registry.example.com' },
    },
  }), {
    typeLabel: '网络',
    purpose: '需要授权访问网络',
  });
});

test('权限授权根据真实网络字段区分网络和普通权限', () => {
  assert.deepEqual(getApprovalPresentation({
    kind: 'permissions_approval',
    fallbackTitle: '需要授予额外权限',
    details: { reason: '是否允许访问 npm 软件源？', networkApprovalContext: { host: 'registry.npmjs.org' } },
  }), {
    typeLabel: '网络',
    purpose: '访问 npm 软件源',
  });
  assert.deepEqual(getApprovalPresentation({
    kind: 'permissions_approval',
    fallbackTitle: '需要授予额外权限',
    details: {},
  }), {
    typeLabel: '权限',
    purpose: '需要授予额外权限',
  });
});

test('文件授权保留有意义的继续和只读限定词', () => {
  assert.deepEqual(getApprovalPresentation({
    kind: 'file_approval',
    fallbackTitle: '需要授权修改文件',
    details: { reason: '是否允许继续只读查看配置文件？' },
  }), {
    typeLabel: '文件',
    purpose: '继续只读查看配置文件',
  });
});

test('MCP 待处理请求使用独立类型和补充信息语义', () => {
  assert.deepEqual(getApprovalPresentation({
    kind: 'mcp_elicitation',
    fallbackTitle: '工具需要补充信息',
    details: { message: '请选择发布环境', serverName: 'release-helper' },
  }), {
    typeLabel: 'MCP',
    purpose: '请选择发布环境',
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCodeBuddyReleaseOverview } from './codebuddy-release-overview.js';

test('CodeBuddy 功能版统计三级标题、改进主题和列表修复', () => {
  assert.deepEqual(extractCodeBuddyReleaseOverview(`
# 🚀 CodeBuddy Code v2.142.0 发布

## ✨ 新功能
### 本地模型运行支持
支持本地模型下载和设备能力匹配。
### Web UI 固定路径前缀
方便反向代理环境使用。

## 🔧 改进优化
### 智能体启动与恢复体验
历史会话恢复后可继续连接。
### 插件启动与管理
插件 Host 支持重载。

## 🐛 问题修复
- **沙箱工作目录稳定性**：相对路径仍以原项目目录为准。
- **上下文超限恢复空转**：重试耗尽后正确显示错误。

## 📝 文档更新
- **CLI 文档归档**：同步最新使用指南。
  `), {
    sourceStatus: 'available',
    counts: { features: 2, improvements: 2, fixes: 2, documentation: 1, chores: 0 },
    topics: ['models_providers', 'terminal_ui', 'tasks_sessions'],
  });
});

test('CodeBuddy 主题优先反映新功能和改进而不是修复章节命中顺序', () => {
  assert.deepEqual(extractCodeBuddyReleaseOverview(`
## ✨ 新功能
### 本地模型运行支持
### Web UI 固定路径前缀
## 🔧 改进优化
### 并发任务与资源管理
## 🐛 问题修复
- **沙箱写入修复**：修复权限问题。
- **敏感工具审批修复**：避免重复审批。
- **MCP 资源恢复**：连接失败后恢复。
  `).topics, ['models_providers', 'terminal_ui', 'tasks_sessions']);
});

test('CodeBuddy 纯修复版保持维护版本语义', () => {
  assert.deepEqual(extractCodeBuddyReleaseOverview(`
## 🐛 问题修复
- **上下文压缩后续跑**：压缩完成后正确恢复对话。
- **安全删除链路加固**：危险删除命令优先拦截。
- **命令分页体验优化**：自动化场景不再等待输入。
  `), {
    sourceStatus: 'available',
    counts: { features: 0, improvements: 0, fixes: 3, documentation: 0, chores: 0 },
    topics: ['permissions_security', 'context_compaction', 'terminal_ui'],
  });
});

test('CodeBuddy 空正文和未知格式不生成推测性概览', () => {
  const emptyCounts = { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 };
  assert.deepEqual(extractCodeBuddyReleaseOverview(''), {
    sourceStatus: 'unrecognized', counts: emptyCounts, topics: [],
  });
  assert.deepEqual(extractCodeBuddyReleaseOverview('这是一段未知格式的说明。'), {
    sourceStatus: 'unrecognized', counts: emptyCounts, topics: [],
  });
});

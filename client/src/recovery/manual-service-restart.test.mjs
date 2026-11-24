import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ApiError } from '../api/client.ts';
import {
  formatServiceStartedAt,
  presentServiceRestartError,
} from './manual-service-restart.ts';

test('服务启动时间使用固定的本地日期时间格式', () => {
  assert.equal(formatServiceStartedAt(null), '未知');
  assert.equal(formatServiceStartedAt(Number.NaN), '未知');
  assert.equal(formatServiceStartedAt(new Date(2026, 7, 6, 20, 41, 9).getTime()), '2026-08-06 20:41:09');
});

test('重启冷却错误说明规则、剩余时间和下一步且不建议终端重启', () => {
  const result = presentServiceRestartError(new ApiError(
    429,
    { error: '服务恢复操作过于频繁', code: 'RECOVERY_RATE_LIMITED' },
    undefined,
    42,
  ), 'restart');
  assert.equal(result.title, '重启冷却中');
  assert.match(result.detail, /同一服务需间隔 30 秒/);
  assert.match(result.detail, /交叉操作需间隔 10 秒/);
  assert.match(result.detail, /等待 42 秒/);
  assert.match(result.detail, /重试/);
  assert.equal(result.showTerminalFallback, false);
});

test('完整重启预构建失败明确说明已取消且无需终端兜底', () => {
  const result = presentServiceRestartError(new ApiError(
    409,
    { error: '前端构建体积超限：JavaScript 总量 1203.15 / 1200.00 KiB，超出 3.15 KiB。完整重启已取消，现有服务仍在运行。', code: 'RECOVERY_RESTART_FAILED' },
  ), 'restart');
  assert.equal(result.title, '完整重启已取消');
  assert.match(result.detail, /超出 3\.15 KiB/);
  assert.match(result.detail, /现有服务仍在运行/);
  assert.equal(result.showTerminalFallback, false);
});

test('状态检测错误和重启请求错误使用不同标题', () => {
  assert.equal(presentServiceRestartError(new Error('网络错误'), 'status').title, '状态检测失败');
  assert.equal(presentServiceRestartError(new Error('请求错误'), 'restart').title, '重启请求失败');
});

test('Relay 维护从仅管理员可见的管理中心进入', () => {
  const sidebar = fs.readFileSync(new URL('../components/layout/Sidebar.tsx', import.meta.url), 'utf8');
  const center = fs.readFileSync(new URL('../components/layout/AdministrationCenter.tsx', import.meta.url), 'utf8');
  assert.match(sidebar, /user\?\.role === 'admin' && <>\s*<AdministrationCenter/);
  assert.match(center, /运行与维护[\s\S]*label: 'Relay 维护', panel: 'server'/);
});

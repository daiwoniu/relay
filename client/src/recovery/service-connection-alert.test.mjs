import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('协议阻断告警只展示核心诊断并支持收起展开', () => {
  const source = fs.readFileSync(new URL('../components/system/ServiceConnectionAlert.tsx', import.meta.url), 'utf8');
  assert.match(source, /服务连接需要恢复/);
  assert.match(source, /连接已暂停/);
  assert.match(source, /前端协议/);
  assert.match(source, /后端协议/);
  assert.match(source, /setCollapsed\(true\)/);
  assert.match(source, /setCollapsed\(false\)/);
  assert.doesNotMatch(source, /彻底关闭/);
  assert.doesNotMatch(source, /仅重启后端/);
  assert.doesNotMatch(source, /仅重启前端/);
  assert.doesNotMatch(source, /高级操作/);
});

test('协议告警操作后立即反馈，关闭按钮固定在右上角', () => {
  const source = fs.readFileSync(new URL('../components/system/ServiceConnectionAlert.tsx', import.meta.url), 'utf8');
  assert.match(source, /重启请求已提交，正在等待后端服务恢复并重新连接/);
  assert.match(source, /absolute right-2 top-2/);
  assert.match(source, /pr-10/);
});

test('管理员使用推荐操作和详情，普通成员保留安全动作与人工指引', () => {
  const source = fs.readFileSync(new URL('../components/system/ServiceConnectionAlert.tsx', import.meta.url), 'utf8');
  assert.match(source, /isAdmin/);
  assert.match(source, /查看详情/);
  assert.match(source, /重新检测/);
  assert.match(source, /需要管理员恢复 Relay 服务/);
  assert.match(source, /npm run restart/);
  assert.match(source, /recommendedAction/);
});

test('告警和详情复用同一个维护控制器', () => {
  const source = fs.readFileSync(new URL('../components/system/ServiceConnectionAlert.tsx', import.meta.url), 'utf8');
  assert.match(source, /const controller = useServiceMaintenance/);
  assert.match(source, /<ServiceMaintenanceDialog[\s\S]*controller=\{controller\}/);
  assert.equal((source.match(/useServiceMaintenance\(/g) || []).length, 1);
});

test('协议告警具备稳定无障碍语义且能力失败仍保留版本', () => {
  const source = fs.readFileSync(new URL('../components/system/ServiceConnectionAlert.tsx', import.meta.url), 'utf8');
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-label="服务连接恢复"/);
  assert.match(source, /mismatch\.clientVersion/);
  assert.match(source, /controller\.serverVersion/);
  assert.match(source, /controller\.policy\.showTerminalFallback/);
});

test('ChatView 使用精简告警替代旧恢复面板', () => {
  const source = [
    '../components/chat/ChatView.tsx',
    '../components/chat/ChatViewPresentation.tsx',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  assert.match(source, /ServiceConnectionAlert/);
  assert.doesNotMatch(source, /ServiceRecoveryPanel/);
  assert.match(source, /mismatch=\{protocolMismatch\}/);
  assert.match(source, /onReconnect=\{reconnect\}/);
  assert.match(source, /<ServiceConnectionAlert mismatch=\{mismatch\} onReconnect=\{onReconnect\}/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./start.mjs', import.meta.url), 'utf8');

test('运行器响应稳定宿主固定 shutdown IPC 并复用优雅停止路径', () => {
  assert.match(source, /isLauncherHostShutdownRequest/);
  assert.match(source, /终端宿主请求停止 Relay/);
});

test('启动循环复用已注入引擎安装来源的服务对象', () => {
  assert.match(source, /RELAY_CODEX_INSTALL_SOURCE: codexInstallation\.get\(\)\.installSource/);
  assert.match(source, /RELAY_CODEBUDDY_INSTALL_SOURCE: codeBuddyInstallation\.get\(\)\.installSource/);
  assert.match(source, /servicesById\.get\('backend'\)/);
  assert.match(source, /servicesById\.get\('codex'\)/);
  assert.doesNotMatch(source, /const base = baseServices\(\)/);
});

test('面板 setup 输出写入文件日志和面板，但不直出终端', () => {
  assert.match(source, /stdio: \['ignore', 'pipe', 'pipe', 'ipc'\]/);
  assert.match(source, /onOutput: \(channel, chunk, context\) => forwardMaintenanceOutput\('setup', channel, chunk, context\)/);
  assert.match(source, /fileLogger\.writeServiceChunk\(serviceId, channel, chunk\)/);
  assert.doesNotMatch(source, /\(channel === 'stderr' \? process\.stderr : process\.stdout\)\.write\(chunk\)/);
  assert.match(source, /fileLogger\.flushService\('setup'\)/);
});

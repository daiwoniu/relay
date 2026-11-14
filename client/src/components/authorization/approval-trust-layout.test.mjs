import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./ApprovalTrustControl.tsx', import.meta.url), 'utf8');

test('授权信任入口复用桌面 Popover 和移动底部抽屉', () => {
  assert.match(source, /mobile=\{isMobile\}/);
  assert.match(source, /placement="top"/);
  assert.match(source, /label="授权信任设置"/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /aria-expanded=\{open\}/);
});

test('授权审核图标与上下文用量图标保持相同尺寸', () => {
  assert.match(source, /<svg width="18" height="18" viewBox="0 0 16 16"/);
});

test('会话提供五项、项目提供四项且保存中不可重复操作', () => {
  assert.match(source, /SESSION_OPTIONS/);
  assert.match(source, /PROJECT_OPTIONS/);
  assert.match(source, /SESSION_OPTIONS\.map/);
  assert.match(source, /PROJECT_OPTIONS\.map/);
  assert.match(source, /disabled=\{saving\}/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /aria-checked=/);
});

test('仅永久信任进入明确风险确认，撤销和人工操作直接保存', () => {
  assert.match(source, /choice === 'permanent'/);
  assert.match(source, /命令、文件和额外权限会由 Relay 自动允许/);
  assert.match(source, /<ConfirmDialog/);
  assert.match(source, /onConfirmPermanent/);
  assert.match(source, /clearSessionTrust/);
  assert.match(source, /clearProjectTrust/);
});

test('面板回显加载、保存和错误状态', () => {
  assert.match(source, /正在读取授权信任设置/);
  assert.match(source, /正在保存/);
  assert.match(source, /role="alert"/);
});

test('会话和项目定时信任保存成功后立即刷新剩余时间基准', () => {
  assert.equal(source.match(/if \(saved\) setNow\(Date\.now\(\)\);/g)?.length, 4);
});

test('选中的限时信任提供重置倒计时操作', () => {
  assert.match(source, /resetSessionTrust/);
  assert.match(source, /resetProjectTrust/);
  assert.match(source, /aria-label=\{`重置\$\{label\}倒计时`\}/);
  assert.match(source, /resettable=\{selected && \(option\.value === 'one_hour' \|\| option\.value === 'eight_hours'\)\}/g);
});

test('存在限时信任时按显示精度调度，并在页面重新可见时立即校准', () => {
  assert.match(source, /getApprovalTrustRefreshDelay\(\[sessionExpiresAt, projectExpiresAt\], currentNow\)/);
  assert.match(source, /window\.setTimeout\(refreshAndSchedule, delay\)/);
  assert.doesNotMatch(source, /setInterval/);
  assert.match(source, /window\.addEventListener\('focus', refreshAndSchedule\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', refreshAndSchedule\)/);
  assert.match(source, /window\.removeEventListener\('focus', refreshAndSchedule\)/);
  assert.match(source, /document\.removeEventListener\('visibilitychange', refreshAndSchedule\)/);
});

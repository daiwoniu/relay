import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCodeBuddyReadiness, detectSupportedEngines, engineStateFromSetup, formatEngineDetection } from './lib/engine-detection.mjs';

function runner(results) {
  return (command, args) => results[`${command} ${args.join(' ')}`] || { status: 1, stderr: 'missing' };
}

test('仅帮助参数通过时 CodeBuddy 只是探针候选而不是可用引擎', () => {
  const codex = { 'codex --version': { status: 0, stdout: 'codex 1' }, 'codex app-server --help': { status: 0, stdout: 'help' } };
  const buddy = { 'codebuddy --version': { status: 0, stdout: '2.143.0' }, 'codebuddy --help': { status: 0, stdout: '--acp --acp-transport --agent --permission-mode --no-session-persistence' } };
  assert.equal(detectSupportedEngines(runner(codex)).available, true);
  const detectedBuddy = detectSupportedEngines(runner(buddy));
  assert.equal(detectedBuddy.codebuddy.acpSupported, true);
  assert.deepEqual(detectedBuddy.codebuddy.missingAcpOptions, []);
  assert.equal(detectedBuddy.codebuddy.authReady, false);
  assert.equal(detectedBuddy.codebuddy.protocolReady, false);
  assert.equal(detectedBuddy.codebuddy.available, false);
  assert.equal(detectedBuddy.probeCandidateAvailable, true);
  assert.equal(detectSupportedEngines(runner({ ...codex, ...buddy })).available, true);
  assert.equal(detectSupportedEngines(runner({})).available, false);
});

test('CodeBuddy 只有基本可用性验证成功才可用', () => {
  const detected = detectSupportedEngines(runner({
    'codebuddy --version': { status: 0, stdout: '2.143.0' },
    'codebuddy --help': { status: 0, stdout: '--acp --acp-transport --agent --permission-mode --no-session-persistence' },
  }));
  const ready = applyCodeBuddyReadiness(detected, { ok: true, checkedAt: '2026-08-10T00:00:00.000Z' });
  assert.equal(ready.codebuddy.authReady, true);
  assert.equal(ready.codebuddy.protocolReady, true);
  assert.equal(ready.codebuddy.available, true);
  assert.equal(ready.codebuddy.readinessCheckedAt, '2026-08-10T00:00:00.000Z');
  assert.equal(ready.available, true);

  const failed = applyCodeBuddyReadiness(detected, { ok: false, message: 'ACP 基本调用失败' });
  assert.equal(failed.codebuddy.authReady, false);
  assert.equal(failed.codebuddy.protocolReady, false);
  assert.equal(failed.codebuddy.available, false);
  assert.equal(failed.codebuddy.readinessMessage, 'ACP 基本调用失败');
});

test('CodeBuddy 基本验证候选使用中性进度标记而不是警告标记', () => {
  const detected = detectSupportedEngines(runner({
    'codebuddy --version': { status: 0, stdout: '2.143.0' },
    'codebuddy --help': { status: 0, stdout: '--acp --acp-transport --agent --permission-mode --no-session-persistence' },
  }));
  const output = formatEngineDetection(detected).join('\n');
  assert.match(output, /… CodeBuddy：CLI 已安装，待验证登录与 ACP 基本可用性（2\.143\.0）/);
  assert.doesNotMatch(output, /! CodeBuddy：CLI 已安装/);
});

test('可选引擎不可用使用警告标记并保留 readiness 失败原因', () => {
  const unavailable = formatEngineDetection(detectSupportedEngines(runner({}))).join('\n');
  assert.match(unavailable, /⚠ Codex：CLI 未安装/);
  assert.match(unavailable, /⚠ CodeBuddy：CLI 未安装/);

  const detected = detectSupportedEngines(runner({
    'codebuddy --version': { status: 0, stdout: '2.143.0' },
    'codebuddy --help': { status: 0, stdout: '--acp --acp-transport --agent --permission-mode --no-session-persistence' },
  }));
  const failed = formatEngineDetection(applyCodeBuddyReadiness(detected, { ok: false, message: 'readiness 未通过' })).join('\n');
  assert.match(failed, /⚠ CodeBuddy：readiness 未通过（2\.143\.0）/);
});

test('buddycn、桌面程序、扩展和配置目录不能替代真正 codebuddy CLI', () => {
  const detected = detectSupportedEngines(runner({
    'buddycn --version': { status: 0, stdout: 'fake' },
    'CodeBuddy.exe --version': { status: 0, stdout: 'fake' },
  }));
  assert.equal(detected.codebuddy.cliInstalled, false);
  assert.equal(detected.codebuddy.available, false);
});

test('CodeBuddy CLI 版本失败或帮助缺少 ACP stdio 参数时不可用', () => {
  const versionFailed = detectSupportedEngines(runner({ 'codebuddy --version': { status: 1 } }));
  assert.equal(versionFailed.codebuddy.available, false);
  const noProtocol = detectSupportedEngines(runner({
    'codebuddy --version': { status: 0, stdout: '2.133.1' },
    'codebuddy --help': { status: 0, stdout: '--serve' },
  }));
  assert.equal(noProtocol.codebuddy.protocolReady, false);
  assert.equal(noProtocol.codebuddy.acpSupported, false);
  assert.deepEqual(noProtocol.codebuddy.missingAcpOptions, [
    '--acp', '--acp-transport', '--agent', '--permission-mode', '--no-session-persistence',
  ]);
});

test('CodeBuddy 缺少 Relay 固定运行语义所需参数时不进入 readiness', () => {
  const detected = detectSupportedEngines(runner({
    'codebuddy --version': { status: 0, stdout: '2.142.0' },
    'codebuddy --help': { status: 0, stdout: '--acp --acp-transport --no-session-persistence' },
  }));
  assert.equal(detected.codebuddy.acpSupported, false);
  assert.deepEqual(detected.codebuddy.missingAcpOptions, ['--agent', '--permission-mode']);
  assert.equal(detected.probeCandidateAvailable, false);
});

test('CodeBuddy 参数检测按完整 option token 匹配', () => {
  const detected = detectSupportedEngines(runner({
    'codebuddy --version': { status: 0, stdout: '2.143.0' },
    'codebuddy --help': { status: 0, stdout: '--acp-transport --agent-name --permission-mode-before-plan --no-session-persistence-extra' },
  }));
  assert.equal(detected.codebuddy.acpSupported, false);
  assert.deepEqual(detected.codebuddy.missingAcpOptions, [
    '--acp', '--agent', '--permission-mode', '--no-session-persistence',
  ]);
});

test('旧 setup 状态继续按 Codex 单引擎兼容读取且文案不泄露路径', () => {
  const engines = engineStateFromSetup({ codexVersion: 'codex 1.2.3' });
  assert.equal(engines.codex.available, true);
  assert.equal(engines.codebuddy.available, false);
  assert.doesNotMatch(formatEngineDetection(engines).join('\n'), /[A-Z]:\\|\/Users\//);
});

test('旧多引擎 setup 缺少 authReady 时必须失败关闭', () => {
  const engines = engineStateFromSetup({
    engines: {
      codex: { cliInstalled: false, protocolReady: false, available: false },
      codebuddy: { cliInstalled: true, protocolReady: true, available: true, version: '2.133.1' },
    },
  });
  assert.equal(engines.codebuddy.authReady, false);
  assert.equal(engines.codebuddy.available, false);
});

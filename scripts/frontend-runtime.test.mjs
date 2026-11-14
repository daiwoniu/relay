import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createFrontendService, getRunningProductionBuildId, parseFrontendRuntimeArguments } from './lib/frontend-runtime.mjs';

const frontendEndpoint = { listenHost: '192.168.1.8', port: 19083, origin: 'http://192.168.1.8:19083' };
const backendEndpoint = { listenHost: '0.0.0.0', port: 19082, origin: 'http://127.0.0.1:19082' };

test('默认 production，development 需要显式 dev 且 lan 不能单独使用', () => {
  assert.deepEqual(parseFrontendRuntimeArguments([]), { mode: 'production', lan: false });
  assert.deepEqual(parseFrontendRuntimeArguments(['--dev']), { mode: 'development', lan: false });
  assert.deepEqual(parseFrontendRuntimeArguments(['--dev', '--lan']), { mode: 'development', lan: true });
  assert.throws(() => parseFrontendRuntimeArguments(['--lan']), /只能与 --dev/);
});

test('development 默认使用配置监听端点，显式 lan 临时覆盖为所有网卡', () => {
  const root = path.resolve('G:/relay-test');
  const common = { frontendEndpoint, backendEndpoint, clientRuntimePrerequisites: [] };
  const configured = createFrontendService(root, { mode: 'development', lan: false, ...common });
  const lan = createFrontendService(root, { mode: 'development', lan: true, ...common });
  assert.deepEqual(configured.args.slice(-4), ['--host', '192.168.1.8', '--port', '19083']);
  assert.deepEqual(lan.args.slice(-4), ['--host', '0.0.0.0', '--port', '19083']);
  assert.equal(configured.healthUrl, 'http://192.168.1.8:19083/__relay/frontend-status');
});

test('production 通过 tsx 加载当前网关源码，避免复用过期 dist', () => {
  const root = path.resolve('G:/relay-test');
  const service = createFrontendService(root, {
    mode: 'production',
    buildId: 'abcdef123456',
    buildLabel: '20260809-1410 · abcdef1',
    releaseDir: path.join(root, '.relay-build/frontend/releases/abcdef123456'),
    serverRuntimePrerequisite: path.join(root, 'server/node_modules/.bin/tsx.cmd'),
    frontendEndpoint,
    backendEndpoint,
  });
  assert.deepEqual(service.args, ['--import', 'tsx', 'src/frontend-gateway.ts']);
  assert.equal(service.cwd, path.join(root, 'server'));
  assert.match(service.requiredPaths.join('\n'), /frontend-gateway\.ts/);
  assert.equal(service.env.RELAY_FRONTEND_BUILD_ID, 'abcdef123456');
  assert.equal(service.env.RELAY_FRONTEND_BUILD_LABEL, '20260809-1410 · abcdef1');
  assert.equal(service.env.RELAY_SERVER_URL, 'http://127.0.0.1:19082');
  assert.equal(service.env.PORT, undefined);
  assert.equal(service.port, 19083);
});

test('production restart 只接受实际运行网关的合法 buildId 作为回滚目标', () => {
  assert.equal(getRunningProductionBuildId({ mode: 'production', buildId: 'abcdef123456' }), 'abcdef123456');
  assert.equal(getRunningProductionBuildId({ mode: 'development', buildId: 'abcdef123456' }), null);
  assert.equal(getRunningProductionBuildId({ mode: 'production', buildId: 'invalid-build' }), null);
  assert.equal(getRunningProductionBuildId(null), null);
});

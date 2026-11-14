import assert from 'node:assert/strict';
import test from 'node:test';
import { findUnsafeStopConflicts, recognizeRelayService, resolveStopServices } from './lib/service-port-migration.mjs';

const currentServices = [
  { id: 'codex', name: 'Codex', port: 9281, healthUrl: 'http://127.0.0.1:9281/readyz' },
  { id: 'backend', name: 'Relay 后端', port: 9181, healthUrl: 'http://127.0.0.1:9181/api/health' },
  { id: 'frontend', name: 'Relay 前端', port: 9081, healthUrl: 'http://127.0.0.1:9081/__relay/frontend-status' },
];

test('端口变更后只追加确认健康的上一版遗留服务', async () => {
  const checked = [];
  const services = await resolveStopServices(currentServices, {
    recognize: async (service) => {
      checked.push(service.healthUrl);
      return service.healthUrl.includes(':9082/') || service.healthUrl.includes(':9083/');
    },
  });

  assert.deepEqual(checked, [
    'http://127.0.0.1:9082/api/health',
    'http://127.0.0.1:9083/__relay/frontend-status',
  ]);
  assert.deepEqual(services.map(({ id, port }) => [id, port]), [
    ['backend', 9181],
    ['backend', 9082],
    ['frontend', 9081],
    ['frontend', 9083],
    ['codex', 9281],
  ]);
});

test('上一版端口被其他程序占用时不纳入停止范围', async () => {
  const services = await resolveStopServices(currentServices, { recognize: async () => false });
  assert.deepEqual(services.map(({ id }) => id), ['backend', 'frontend', 'codex']);
});

test('与当前配置重叠的上一版端口不重复探测或停止', async () => {
  let checkedOverlap = false;
  const services = await resolveStopServices(currentServices, {
    recognize: async (service) => {
      if (service.healthUrl.includes(':9181/')) checkedOverlap = true;
      return true;
    },
  });
  assert.equal(checkedOverlap, false);
  assert.equal(services.filter((service) => service.port === 9181).length, 1);
});

test('上一版后端和前端必须匹配 Relay 响应特征', async () => {
  const response = (body) => ({ ok: true, json: async () => body });
  assert.equal(await recognizeRelayService(
    { id: 'backend', healthUrl: 'http://legacy/api/health' },
    async () => response({ status: 'ok', name: 'Relay' }),
  ), true);
  assert.equal(await recognizeRelayService(
    { id: 'backend', healthUrl: 'http://legacy/api/health' },
    async () => response({ status: 'ok', name: 'Other' }),
  ), false);
  assert.equal(await recognizeRelayService(
    { id: 'frontend', healthUrl: 'http://legacy/__relay/frontend-status' },
    async () => response({ mode: 'production', startedAt: 1 }),
  ), true);
  assert.equal(await recognizeRelayService(
    { id: 'frontend', healthUrl: 'http://legacy/__relay/frontend-status' },
    async () => response({ mode: 'production' }),
  ), false);
});

test('当前配置端口上的归属不明进程会阻断停止', async () => {
  const conflicts = await findUnsafeStopConflicts(currentServices, {
    findListeningPids: (ports) => new Map(ports.map((port) => [port, port === 9081 ? [404] : []])),
    recognize: async () => false,
  });
  assert.deepEqual(conflicts.map(({ service, pids }) => [service.port, pids]), [[9081, [404]]]);
});

test('当前服务或重叠的上一版服务可确认时允许停止', async () => {
  const conflicts = await findUnsafeStopConflicts(currentServices, {
    findListeningPids: (ports) => new Map(ports.map((port) => [port, port === 9181 ? [202] : []])),
    recognize: async (service) => service.id === 'codex' && service.port === 9181,
  });
  assert.deepEqual(conflicts, []);
});

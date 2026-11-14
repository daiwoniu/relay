import assert from 'node:assert/strict';
import net from 'node:net';
import process from 'node:process';
import test from 'node:test';
import { getCapturedOutput, spawnService, stopProcessTree, waitForReady } from './lib/launcher-core.mjs';
import { createServiceSupervisor } from './lib/service-supervisor.mjs';

const childSource = `
  const http = require('node:http');
  const port = Number(process.argv[1]);
  const name = process.argv[2];
  const pending = new Map();
  process.on('message', (message) => {
    if (message?.type !== 'restart_response') return;
    const resolve = pending.get(message.operationId);
    if (resolve) resolve(message);
  });
  http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (name === 'backend' && request.url?.startsWith('/confirm')) {
      const url = new URL(request.url, 'http://127.0.0.1');
      process.send({
        channel: 'relay-control-v1', type: 'restart_commit',
        operationId: url.searchParams.get('operationId'), target: url.searchParams.get('target'),
      });
      response.statusCode = 202;
      response.end(JSON.stringify({ status: 'committed' }));
      return;
    }
    if (name === 'backend' && request.url?.startsWith('/recover')) {
      const url = new URL(request.url, 'http://127.0.0.1');
      const operationId = url.searchParams.get('operationId');
      const target = url.searchParams.get('target');
      const decision = new Promise((resolve) => pending.set(operationId, resolve));
      process.send({
        channel: 'relay-control-v1', type: 'restart_request', operationId, target,
        requestedBy: 'integration-admin', clientProtocolVersion: 11, serverProtocolVersion: 10,
      });
      decision.then((message) => {
        pending.delete(operationId);
        response.statusCode = message.status === 'accepted' ? 202 : 409;
        response.end(JSON.stringify(message));
      });
      return;
    }
    response.end(JSON.stringify({ status: 'ok', name, pid: process.pid }));
  }).listen(port, '127.0.0.1');
  setInterval(() => {}, 1000);
`;

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('监督器在隔离端口单独恢复目标并在失败时保留其他服务', async () => {
  const [backendPort, frontendPort] = await Promise.all([getFreePort(), getFreePort()]);
  assert.equal([backendPort, frontendPort].some((port) => [9081, 9181, 9281].includes(port)), false);
  const definitions = new Map([
    ['backend', {
      id: 'backend', name: '测试后端', port: backendPort,
      healthUrl: `http://127.0.0.1:${backendPort}`,
      command: process.execPath, args: ['-e', childSource, String(backendPort), 'backend'],
      cwd: process.cwd(), ipc: true,
    }],
    ['frontend', {
      id: 'frontend', name: '测试前端', port: frontendPort,
      healthUrl: `http://127.0.0.1:${frontendPort}`,
      command: process.execPath, args: ['-e', childSource, String(frontendPort), 'frontend'],
      cwd: process.cwd(),
    }],
  ]);
  const owned = new Map();
  const allChildren = new Set();
  const operationResults = new Map();
  let failNextTarget = null;
  let responseFinished = false;
  let supervisor;

  const attachBackendControl = (service, child) => {
    if (service.id !== 'backend') return;
    child.on('message', (message) => {
      if (message?.type === 'restart_request') {
        void supervisor.handleControlMessage(child, message);
      } else if (message?.type === 'restart_commit') {
        operationResults.set(message.operationId, supervisor.handleControlCommit(child, message));
      }
    });
  };

  const spawnChild = (service) => {
    const definition = failNextTarget === service.id
      ? { ...service, args: ['-e', 'process.exit(23)'] }
      : service;
    failNextTarget = null;
    const child = spawnService(definition);
    allChildren.add(child);
    if (supervisor) attachBackendControl(service, child);
    return child;
  };

  for (const service of definitions.values()) {
    const child = spawnChild(service);
    owned.set(service.id, { service, child });
    await waitForReady(service, child, undefined, 10_000);
  }

  supervisor = createServiceSupervisor({
    services: definitions,
    owned,
    spawnChild,
    stopChild: async (child) => {
      assert.equal(responseFinished, true, '真实 HTTP 202 到达浏览器后才能停止目标服务');
      await stopProcessTree(child);
    },
    waitForReady: (service, child) => waitForReady(service, child, undefined, 5_000),
    getCapturedOutput,
    write: () => {},
    writeError: () => {},
    now: Date.now,
    sameTargetCooldownMs: 0,
    crossTargetCooldownMs: 0,
  });
  attachBackendControl(definitions.get('backend'), owned.get('backend').child);

  const recover = async (target, operationId) => {
    responseFinished = false;
    const response = await fetch(`${definitions.get('backend').healthUrl}/recover?target=${target}&operationId=${operationId}`);
    assert.equal(response.status, 202);
    await response.json();
    responseFinished = true;
    await fetch(`${definitions.get('backend').healthUrl}/confirm?target=${target}&operationId=${operationId}`).catch(() => null);
    for (let attempt = 0; attempt < 50 && !operationResults.has(operationId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = operationResults.get(operationId);
    assert.ok(result, `缺少恢复操作 ${operationId}`);
    return result;
  };

  try {
    const initialBackend = owned.get('backend').child;
    const initialFrontend = owned.get('frontend').child;
    const backendRestart = recover('backend', 'op-backend');
    assert.equal((await backendRestart).ok, true);
    assert.notEqual(owned.get('backend').child.pid, initialBackend.pid);
    assert.equal(owned.get('frontend').child.pid, initialFrontend.pid);
    assert.equal((await fetch(definitions.get('backend').healthUrl)).ok, true);

    const currentBackend = owned.get('backend').child;
    const beforeFrontendRestart = owned.get('frontend').child;
    const frontendRestart = recover('frontend', 'op-frontend');
    assert.equal((await frontendRestart).ok, true);
    assert.equal(owned.get('backend').child.pid, currentBackend.pid);
    assert.notEqual(owned.get('frontend').child.pid, beforeFrontendRestart.pid);
    assert.equal((await fetch(definitions.get('frontend').healthUrl)).ok, true);

    const healthyFrontendPid = owned.get('frontend').child.pid;
    failNextTarget = 'backend';
    const failedRestart = recover('backend', 'op-failed');
    assert.deepEqual(await failedRestart, {
      ok: false,
      reason: 'restart_failed',
      operationId: 'op-failed',
      target: 'backend',
    });
    assert.equal(owned.has('backend'), false);
    assert.equal(owned.get('frontend').child.pid, healthyFrontendPid);
    assert.equal((await fetch(definitions.get('frontend').healthUrl)).ok, true);
  } finally {
    await Promise.allSettled([...allChildren].map((child) => stopProcessTree(child)));
  }
});

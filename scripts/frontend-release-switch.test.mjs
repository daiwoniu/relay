import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getFrontendBuildPaths, readFrontendBuildState, writeFrontendBuildState } from './lib/frontend-build.mjs';
import { switchPreparedFrontendRelease } from './lib/frontend-release-switch.mjs';

function createRelease(root, buildId) {
  const release = path.join(getFrontendBuildPaths(root).releases, buildId);
  fs.mkdirSync(path.join(release, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(release, 'index.html'), buildId);
  fs.writeFileSync(path.join(release, 'relay-version.json'), JSON.stringify({version:'0.1.0'}));
}

test('共享切换事务健康后保留 active/previous 并清理更旧 release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-release-switch-'));
  try {
    for (const id of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) createRelease(root, id);
    const paths = getFrontendBuildPaths(root);
    writeFrontendBuildState(paths.state, { schemaVersion: 1, activeBuildId: 'aaaaaaaaaaaa', previousBuildId: 'cccccccccccc', preparedBuildId: 'bbbbbbbbbbbb', builds: {} });
    const result = await switchPreparedFrontendRelease({
      root,
      expectedBuildId: 'bbbbbbbbbbbb',
      startGateway: async (buildId) => ({ buildId }),
      waitForHealthy: async () => undefined,
      stopGateway: async () => undefined,
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(readFrontendBuildState(paths.state), { schemaVersion: 1, activeBuildId: 'bbbbbbbbbbbb', previousBuildId: 'aaaaaaaaaaaa', preparedBuildId: null, builds: {} });
    assert.equal(fs.existsSync(path.join(paths.releases, 'cccccccccccc')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('共享切换事务拒绝与跨进程预约不一致的 prepared release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-release-identity-'));
  try {
    createRelease(root, 'aaaaaaaaaaaa');
    createRelease(root, 'bbbbbbbbbbbb');
    const paths = getFrontendBuildPaths(root);
    writeFrontendBuildState(paths.state, { schemaVersion: 1, activeBuildId: 'aaaaaaaaaaaa', previousBuildId: null, preparedBuildId: 'bbbbbbbbbbbb', builds: {} });
    await assert.rejects(() => switchPreparedFrontendRelease({
      root,
      expectedBuildId: 'cccccccccccc',
      startGateway: async () => assert.fail('身份不一致时不得启动网关'),
      waitForHealthy: async () => undefined,
      stopGateway: async () => undefined,
    }), /预构建身份不一致/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('新网关失败恢复原指针并兼容无版本文件的旧 previous', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-release-rollback-'));
  try {
    createRelease(root, 'aaaaaaaaaaaa');
    createRelease(root, 'bbbbbbbbbbbb');
    const paths = getFrontendBuildPaths(root);
    const original = { schemaVersion: 1, activeBuildId: 'aaaaaaaaaaaa', previousBuildId: null, preparedBuildId: 'bbbbbbbbbbbb', builds: {} };
    fs.unlinkSync(path.join(paths.releases,'aaaaaaaaaaaa','relay-version.json'));
    writeFrontendBuildState(paths.state, original);
    const starts = [];
    const result = await switchPreparedFrontendRelease({
      root,
      startGateway: async (buildId) => { starts.push(buildId); return { buildId }; },
      waitForHealthy: async (_gateway, buildId) => { if (buildId === 'bbbbbbbbbbbb') throw new Error('不健康'); },
      stopGateway: async () => undefined,
    });
    assert.equal(result.status, 'rolled_back');
    assert.deepEqual(starts, ['bbbbbbbbbbbb', 'aaaaaaaaaaaa']);
    assert.deepEqual(readFrontendBuildState(paths.state), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('候选版本文件缺失时不切换活动指针也不启动网关',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-version-switch-'));
  try{
    createRelease(root,'aaaaaaaaaaaa');createRelease(root,'bbbbbbbbbbbb');
    const paths=getFrontendBuildPaths(root),original={schemaVersion:1,activeBuildId:'aaaaaaaaaaaa',previousBuildId:null,preparedBuildId:'bbbbbbbbbbbb',builds:{}};
    writeFrontendBuildState(paths.state,original);fs.unlinkSync(path.join(paths.releases,'bbbbbbbbbbbb','relay-version.json'));
    await assert.rejects(()=>switchPreparedFrontendRelease({root,startGateway:async()=>assert.fail('must reject before launch'),waitForHealthy:async()=>undefined,stopGateway:async()=>undefined}),/不完整/);
    assert.deepEqual(readFrontendBuildState(paths.state),original);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('setup 已激活候选 release 时失败会恢复真正 previous', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-release-activated-rollback-'));
  try {
    createRelease(root, 'aaaaaaaaaaaa');
    createRelease(root, 'bbbbbbbbbbbb');
    const paths = getFrontendBuildPaths(root);
    writeFrontendBuildState(paths.state, {
      schemaVersion: 1,
      activeBuildId: 'bbbbbbbbbbbb',
      previousBuildId: 'aaaaaaaaaaaa',
      preparedBuildId: 'bbbbbbbbbbbb',
      builds: {},
    });
    const starts = [];
    const result = await switchPreparedFrontendRelease({
      root,
      startGateway: async (buildId) => { starts.push(buildId); return { buildId }; },
      waitForHealthy: async (_gateway, buildId) => { if (buildId === 'bbbbbbbbbbbb') throw new Error('候选版本不健康'); },
      stopGateway: async () => undefined,
    });
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.buildId, 'aaaaaaaaaaaa');
    assert.deepEqual(starts, ['bbbbbbbbbbbb', 'aaaaaaaaaaaa']);
    assert.deepEqual(readFrontendBuildState(paths.state), {
      schemaVersion: 1,
      activeBuildId: 'aaaaaaaaaaaa',
      previousBuildId: 'bbbbbbbbbbbb',
      preparedBuildId: null,
      builds: {},
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('显式回滚目标与候选相同时仍恢复 previous', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-release-same-rollback-'));
  try {
    createRelease(root, 'aaaaaaaaaaaa');
    createRelease(root, 'bbbbbbbbbbbb');
    const paths = getFrontendBuildPaths(root);
    writeFrontendBuildState(paths.state, {
      schemaVersion: 1,
      activeBuildId: 'bbbbbbbbbbbb',
      previousBuildId: 'aaaaaaaaaaaa',
      preparedBuildId: 'bbbbbbbbbbbb',
      builds: {},
    });
    const starts = [];
    const result = await switchPreparedFrontendRelease({
      root,
      rollbackBuildId: 'bbbbbbbbbbbb',
      startGateway: async (buildId) => { starts.push(buildId); return { buildId }; },
      waitForHealthy: async (_gateway, buildId) => { if (buildId === 'bbbbbbbbbbbb') throw new Error('候选版本不健康'); },
      stopGateway: async () => undefined,
    });
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.buildId, 'aaaaaaaaaaaa');
    assert.deepEqual(starts, ['bbbbbbbbbbbb', 'aaaaaaaaaaaa']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

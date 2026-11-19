import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { ApiError } from '../../api/client.ts';
import { mergeUrlSessionIntoNavigationSessions, resolveInitialChatLocation } from '../../stores/chat-location.ts';

const compiled = ts.transpileModule(fs.readFileSync(new URL('./sidebar-navigation-loader.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const target = { version: 1, kind: 'session', sessionId: 'target' };
const staleSession = { id: 'target', project_id: 'project' };
const otherSession = { id: 'other', project_id: 'project' };
const projects = [{ id: 'project', is_system: 1 }];

function loader(api) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === '../../api/client') return { ApiError };
    if (name === '../../api/projects') return { listProjects: async () => projects };
    if (name === '../../api/sessions') return api;
    if (name === '../../stores/chat-location') return { mergeUrlSessionIntoNavigationSessions };
    throw new Error(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  return module.exports.loadSidebarNavigation;
}

for (const status of [403, 404]) {
  test(`精确校验${status}优先于包含目标的旧列表快照，禁止恢复失效会话`, async () => {
    const load = loader({
      listSessions: async () => [staleSession, otherSession],
      getSession: async () => { throw new ApiError(status, { error: '不可访问' }); },
    });
    const result = await load(new AbortController().signal, target);
    assert.deepEqual(result.sessions, [otherSession]);
    assert.equal(resolveInitialChatLocation(null, target, result.sessions, result.projects).activeSessionId, null);
    assert.equal(resolveInitialChatLocation(target, target, result.sessions, result.projects).activeSessionId, null);
  });
}

test('列表外的有效旧会话等待精确校验完成才交付导航结果', async () => {
  let resolveSession;
  const signal = new AbortController().signal;
  const load = loader({
    listSessions: async passedSignal => { assert.equal(passedSignal, signal); return [otherSession]; },
    getSession: (id, options) => {
      assert.equal(id, target.sessionId);
      assert.equal(options.signal, signal);
      return new Promise(resolve => { resolveSession = resolve; });
    },
  });
  let settled = false;
  const pending = load(signal, target).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  resolveSession(staleSession);
  const result = await pending;
  assert.deepEqual(result.sessions, [staleSession, otherSession]);
  assert.equal(resolveInitialChatLocation(null, target, result.sessions, result.projects).activeSessionId, 'target');
});

test('临时失败保留错误供重试，不当作已删除处理', async () => {
  const error = new ApiError(500, { error: '临时失败' });
  const load = loader({ listSessions: async () => [staleSession], getSession: async () => { throw error; } });
  await assert.rejects(load(new AbortController().signal, target), candidate => candidate === error);
});

test('无恢复目标时不发送精确校验请求', async () => {
  const load = loader({
    listSessions: async () => [otherSession],
    getSession: () => { throw new Error('不应查询'); },
  });
  const result = await load(new AbortController().signal, null);
  assert.deepEqual(result.sessions, [otherSession]);
});

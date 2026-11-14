import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from './errors.js';
import { createDeletionState } from './deletion-state.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('同一会话的并发删除复用同一个 Promise', async () => {
  const state = createDeletionState();
  const gate = deferred();
  let calls = 0;
  const operation = () => {
    calls += 1;
    return gate.promise;
  };

  const first = state.runSessionDeletion('session-1', 'project-1', operation);
  const second = state.runSessionDeletion('session-1', 'project-1', operation);

  assert.equal(first, second);
  assert.equal(state.isSessionDeleting('session-1'), true);
  assert.deepEqual(state.getSessionBlock('session-1', 'project-1'), {
    code: 'SESSION_DELETING',
    message: '会话正在删除，请稍后重试',
  });
  assert.equal(calls, 0);

  gate.resolve();
  await first;
  assert.equal(calls, 1);
  assert.equal(state.isSessionDeleting('session-1'), false);
});

test('项目删除期间阻止会话删除且相同项目删除复用 Promise', async () => {
  const state = createDeletionState();
  const gate = deferred();
  const first = state.runProjectDeletion('project-1', ['session-1'], () => gate.promise);
  const second = state.runProjectDeletion('project-1', ['session-1'], () => gate.promise);

  assert.equal(first, second);
  assert.equal(state.isProjectDeleting('project-1'), true);
  assert.deepEqual(state.getSessionBlock('session-2', 'project-1'), {
    code: 'PROJECT_DELETING',
    message: '会话所属项目正在删除，请稍后重试',
  });
  assert.throws(
    () => state.runSessionDeletion('session-1', 'project-1', async () => undefined),
    (error: unknown) => error instanceof ServiceError && error.status === 409,
  );

  gate.resolve();
  await first;
  assert.equal(state.isProjectDeleting('project-1'), false);
});

test('项目删除不会与已开始的会话删除并发执行', async () => {
  const state = createDeletionState();
  const gate = deferred();
  const sessionDeletion = state.runSessionDeletion('session-1', 'project-1', () => gate.promise);

  assert.throws(
    () => state.runProjectDeletion('project-1', ['session-1'], async () => undefined),
    (error: unknown) => error instanceof ServiceError && error.status === 409,
  );

  gate.resolve();
  await sessionDeletion;
});

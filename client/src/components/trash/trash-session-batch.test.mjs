import assert from 'node:assert/strict';
import test from 'node:test';
import { runTrashSessionBatch } from './trash-session-batch.ts';

test('批量操作串行执行，部分失败保留身份且不重试不确定请求', async () => {
  const items = ['a', 'b', 'c'].map((id) => ({ id, title: `会话 ${id}` }));
  const calls = [], progress = [];
  let active = false;
  const result = await runTrashSessionBatch([...items, items[0]], async (item) => {
    assert.equal(active, false);
    active = true;
    calls.push(item.id);
    await Promise.resolve();
    active = false;
    if (item.id === 'b') throw new Error('响应丢失，请核对状态');
    return { cleanupPending: item.id === 'c' };
  }, (completed, total) => progress.push([completed, total]));
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(result.succeeded.map(({ item }) => item.id), ['a', 'c']);
  assert.equal(result.succeeded[1].value.cleanupPending, true);
  assert.deepEqual(result.failed, [{ item: items[1], message: '响应丢失，请核对状态' }]);
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
});

test('全部失败和空选择都如实返回结果，不虚报成功', async () => {
  const failed = await runTrashSessionBatch([{ id: 'a', title: '会话' }], async () => { throw new Error('无权限'); }, () => {});
  assert.equal(failed.succeeded.length, 0);
  assert.equal(failed.failed.length, 1);
  const empty = await runTrashSessionBatch([], async () => assert.fail('空选择不能发请求'), () => {});
  assert.deepEqual(empty, { succeeded: [], failed: [] });
});

test('关闭面板或切换筛选使预览失效后，不再读取后续会话', async () => {
  let current = true;
  const calls = [];
  await runTrashSessionBatch(['a', 'b'].map(id => ({ id, title: id })), async (item) => {
    calls.push(item.id); current = false;
  }, () => {}, () => current);
  assert.deepEqual(calls, ['a']);
});

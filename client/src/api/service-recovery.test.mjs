import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from './client.ts';
import { confirmServiceRecovery, getServiceRecoveryOperationOutput } from './service-recovery.ts';
import { canIgnoreRecoveryConfirmationError } from '../recovery/service-maintenance-operation.ts';

test('维护输出允许暂无输出，确认接口null或截断必须转入结果未知', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  let reply = () => Response.json(null);
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options });
    return reply();
  };
  try {
    assert.equal(await getServiceRecoveryOperationOutput('op-1'), null);
    assert.equal(seen.at(-1).url, '/api/system/recovery-operations/op-1/output');
    assert.equal('allowNullJson' in seen.at(-1).options, false);
    for (const createResponse of [
      () => Response.json(null, { status: 202 }),
      () => new Response('', { status: 202 }),
      () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } }), { status: 202 }),
    ]) {
      reply = createResponse;
      await assert.rejects(() => confirmServiceRecovery('op-1', 'backend'),
        (error) => error instanceof ApiError && canIgnoreRecoveryConfirmationError(error));
      assert.equal(seen.at(-1).url, '/api/system/recover/confirm');
      assert.equal(seen.at(-1).options.keepalive, true);
      assert.deepEqual(JSON.parse(seen.at(-1).options.body), { operationId: 'op-1', target: 'backend' });
    }
    reply = () => Response.json({ status: 'committed' }, { status: 202 });
    assert.deepEqual(await confirmServiceRecovery('op-1', 'backend'), { status: 'committed' });
    reply = () => Response.json({ error: '准备失败', code: 'RECOVERY_RESTART_FAILED' }, { status: 409 });
    await assert.rejects(() => confirmServiceRecovery('op-1', 'backend'),
      (error) => error instanceof ApiError && !canIgnoreRecoveryConfirmationError(error));
  } finally { globalThis.fetch = originalFetch; }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForLauncherRestartBegin } from './lib/launcher-restart.mjs';

function processHarness() {
  const listeners = new Map();
  return {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    emit(event, value) { listeners.get(event)?.(value); },
  };
}

test('helper 只有收到 begin 才继续，cancel 或提前 disconnect 都退出', async () => {
  const begun = processHarness();
  const beginPromise = waitForLauncherRestartBegin(begun);
  begun.emit('message', { channel: 'relay-launcher-restart-v1', type: 'begin' });
  assert.equal(await beginPromise, true);

  const cancelled = processHarness();
  const cancelPromise = waitForLauncherRestartBegin(cancelled);
  cancelled.emit('message', { channel: 'relay-launcher-restart-v1', type: 'cancel' });
  assert.equal(await cancelPromise, false);

  const disconnected = processHarness();
  const disconnectPromise = waitForLauncherRestartBegin(disconnected);
  disconnected.emit('disconnect');
  assert.equal(await disconnectPromise, false);
});

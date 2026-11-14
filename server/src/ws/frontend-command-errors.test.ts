import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StoredFrontendCommands } from './stored-frontend-commands.js';
import { ErrorEventSchema, type FrontendCommand } from '../contracts/index.js';
import { StorageContractError } from '../storage/command-boundary.js';

test('command errors retain command identity so read/sync failures cannot masquerade as turn failures', async () => {
  const events: unknown[] = [];
  const commands = new StoredFrontendCommands({ port: {} as never, storeId: 'test', generation: 1,
    graph: { hub: { send: async (_client: unknown, event: unknown) => { events.push(event); } } } as never,
    sender: undefined!, assertExclusiveWriter: async () => {} });
  const sessionId = randomUUID();
  for (const type of ['subscribe', 'mark_session_read', 'send', 'cancel'] as const) {
    await commands.failed({} as never, { type, sessionId, messageId: 'input' } as Partial<FrontendCommand>, new StorageContractError('STORAGE_UNAVAILABLE'));
    const event = ErrorEventSchema.parse(events.at(-1));
    assert.equal(event.commandType, type);
    assert.equal(event.sessionId, sessionId);
    assert.equal(event.code, type === 'cancel' ? 'TURN_CANCEL_STORAGE_UNAVAILABLE' : 'STORAGE_UNAVAILABLE');
  }
  await commands.close();
});

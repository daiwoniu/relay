import { operationIdentity, parseCommandEnvelope } from './command-boundary.js';
import type { CommandResult, CoreCommandInputs, CoreCommandName, CoreStoragePort, StorageCommandEnvelope } from './contracts.js';

/** Await a business command and, on a lost reply, verify its exact receipt once. Never blind-retry a write. */
export async function executeStoredCommand<K extends CoreCommandName>(port: Pick<CoreStoragePort, 'execute' | 'lookup'>,
  intent: StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } }): Promise<CommandResult<K>> {
  const request = parseCommandEnvelope(intent) as typeof intent;
  const identity = operationIdentity(request);
  const result = await port.execute<K>(request);
  if (result.state !== 'unknown') return result;
  try {
    const record = await port.lookup({ storeId: request.storeId, operationId: request.operationId, principal: request.principal,
      expected: { commandName: request.command.name, inputDigest: identity.inputDigest } });
    if (record.state === 'committed' && record.commandName === request.command.name && record.operationId === request.operationId) {
      return { state: 'committed', operationId: record.operationId, committedAt: record.committedAt, replayed: true, value: record.value } as CommandResult<K>;
    }
  } catch { /* Denied / unavailable lookup cannot prove non-execution. */ }
  return result;
}

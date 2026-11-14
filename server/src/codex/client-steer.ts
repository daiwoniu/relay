import type { JsonRpcCore } from '../engine/json-rpc/core.js';
import { CodexRpcError } from './client-turn-retry.js';

export async function steerCodexTurn(
  session: { rpc: Pick<JsonRpcCore, 'request'>; threadId: string | null; currentTurnId: string | null },
  input: { content: string; messageId: string; expectedTurnId: string },
): Promise<'accepted' | 'turn_changed' | 'unsupported'> {
  if (!session.threadId || !session.currentTurnId || session.currentTurnId !== input.expectedTurnId) return 'turn_changed';
  try {
    await session.rpc.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: input.expectedTurnId,
      clientUserMessageId: input.messageId,
      input: [{ type: 'text', text: input.content }],
    });
    return 'accepted';
  } catch (error) {
    if (error instanceof CodexRpcError && (error.rpcCode === -32601
      || /(?:unknown variant|method not found).*turn\/steer/i.test(error.message))) return 'unsupported';
    if (error instanceof CodexRpcError && error.rpcCode === -32600
      && /^(?:Invalid request: )?(?:no active turn to steer|expected active turn id `[^`]+` but found `[^`]+`)$/i.test(error.message)) return 'turn_changed';
    throw error;
  }
}

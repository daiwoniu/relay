import type { SendCommand } from '../contracts/index.js';
import { RELAY_PROTOCOL_VERSION } from '../contracts/index.js';
import { WorkspaceConsoleService } from '../workspace-console/workspace-console-service.js';
import { FIXED_WORKSPACE_PATH } from '../workspace-console/workspace-snapshot.js';
import { sendFrontendEvent, type FrontendClient } from './frontend-client-hub.js';

const service = new WorkspaceConsoleService();

export async function prepareWorkspaceTaskLink(client: FrontendClient, message: SendCommand): Promise<{ taskId: string; workspacePath: string } | undefined | null> {
  if (!message.workspaceTaskId) return undefined;
  try {
    await service.validateFirstSendTask(client.actor, message.workspaceTaskId, message.sessionId);
    return { taskId: message.workspaceTaskId, workspacePath: FIXED_WORKSPACE_PATH };
  } catch (error) {
    sendFrontendEvent(client.ws, { type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId: message.sessionId,
      messageId: message.messageId, message: error instanceof Error ? error.message : '任务关联校验失败', code: 'WORKSPACE_TASK_LINK_INVALID' });
    return null;
  }
}

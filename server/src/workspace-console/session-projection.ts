export interface SessionProjectionInput {
  sessionId: string;
  title: string;
  projectPath: string;
  updatedAt: number;
  status: string;
  url: string;
  engine?: string | null;
  modelId?: string | null;
  latestMessage?: string | null;
  feishuWorkItemIds?: string[];
  workspaceTargets?: Array<{taskId:string;targetRef:string}>;
}

export interface SessionCardProjection extends SessionProjectionInput {
  engine: string | null;
  modelId: string | null;
  latestMessage: string | null;
}

export function projectSessionCard(input: SessionProjectionInput): SessionCardProjection {
  const latestMessage = input.latestMessage?.trim() || null;
  return {
    ...input,
    engine: input.engine?.trim() || null,
    modelId: input.modelId?.trim() || null,
    latestMessage: latestMessage ? latestMessage.slice(0, 240) : null,
  };
}

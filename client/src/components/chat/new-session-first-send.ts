import { SendOutcomeUnknownError } from '../../hooks/pending-send.ts';

export type CreatedSessionSendVerification = 'confirmed' | 'missing' | 'unknown';

interface SettleCreatedSessionFirstSendOptions {
  send(): Promise<void>;
  verify(): Promise<CreatedSessionSendVerification>;
  onAccepted(): void;
  discard(): Promise<void>;
}

interface CreatedSessionActivationState {
  navigationVersionAtSend: number;
  createdProjectId: string | null;
  currentActiveSessionId: string | null;
  currentNavigationVersion: number;
  currentProjectId: string | null;
}

export function shouldAutoActivateCreatedSession({
  navigationVersionAtSend,
  createdProjectId,
  currentActiveSessionId,
  currentNavigationVersion,
  currentProjectId,
}: CreatedSessionActivationState): boolean {
  return !currentActiveSessionId
    && currentNavigationVersion === navigationVersionAtSend
    && currentProjectId === createdProjectId;
}

export async function settleCreatedSessionFirstSend({
  send,
  verify,
  onAccepted,
  discard,
}: SettleCreatedSessionFirstSendOptions): Promise<void> {
  try {
    await send();
  } catch (sendError) {
    let verification: CreatedSessionSendVerification = 'unknown';
    try {
      verification = await verify();
    } catch {
      verification = 'unknown';
    }

    if (verification === 'confirmed') {
      onAccepted();
      return;
    }
    if (verification === 'missing' && !(sendError instanceof SendOutcomeUnknownError)) {
      try {
        await discard();
      } catch {
        // 清理失败时保留临时会话，原始发送错误仍是对用户最有用的信息。
      }
    }
    throw sendError;
  }

  onAccepted();
}

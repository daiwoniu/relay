import type { ShareExpiryOption } from './share-expiry.ts';

export interface ShareCaution {
  title: string;
  message: string;
}

export function getShareCaution(includeProcess: boolean, expiryOption: ShareExpiryOption): ShareCaution | null {
  const permanent = expiryOption === 'permanent';
  if (includeProcess && permanent) {
    return {
      title: '高敏感度分享',
      message: '内容将永久有效，并可能包含本地路径、命令及工具输出。请务必先预览并确认没有敏感信息。',
    };
  }
  if (includeProcess) {
    return {
      title: '处理过程可能包含敏感信息',
      message: '本地路径、命令和工具输出也会进入分享快照，建议创建前先预览。',
    };
  }
  if (permanent) {
    return {
      title: '分享不会自动失效',
      message: '永久分享需要手动取消。请确认内容适合长期公开。',
    };
  }
  return null;
}

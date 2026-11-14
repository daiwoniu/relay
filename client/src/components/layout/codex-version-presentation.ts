import type { CodexVersionDto } from '../../generated/relay-contracts';

export type CodexVersionTone = 'checking' | 'current' | 'update' | 'error';

export interface CodexVersionPresentation {
  label: string;
  detail: string;
  tone: CodexVersionTone;
}

export function getCodexVersionPresentation(value: CodexVersionDto): CodexVersionPresentation {
  const label = value.currentVersion
    ? `Codex v${value.currentVersion}`
    : value.status === 'checking'
      ? 'Codex'
      : 'Codex 版本不可用';
  if (value.status === 'checking') {
    return { label, detail: '正在检查最新版', tone: 'checking' };
  }
  if (value.status === 'error') {
    return { label, detail: '检查失败，请稍后重试', tone: 'error' };
  }
  if (!value.currentVersion) {
    return {
      label,
      detail: value.latestVersion ? `最新 v${value.latestVersion}` : '无法读取当前版本',
      tone: 'error',
    };
  }
  if (value.updateAvailable && value.latestVersion) {
    return { label, detail: `最新 v${value.latestVersion}`, tone: 'update' };
  }
  return { label, detail: '已是最新版', tone: 'current' };
}

import type { TokenUsageDto } from '../../generated/relay-contracts';

export type ContextUsageTone = 'normal' | 'warning' | 'danger' | 'unknown';
export type ContextUsageScope = 'current' | 'recent';

export interface ContextUsageSnapshot {
  tokenUsage?: TokenUsageDto;
  scope: ContextUsageScope;
}

export interface ContextUsageRiskNotice {
  level: 'warning' | 'danger';
  title: string;
  description: string;
}

export interface ContextUsageHandoffAction {
  title: string;
  description: string;
  actionLabel: string;
}

export interface ContextUsagePresentation {
  contextWindow: number | null;
  percent: number | null;
  remainingPercent: number | null;
  tone: ContextUsageTone;
  scopeLabel: string;
  emptyTitle: string | null;
  emptyDescription: string | null;
  riskNotice: ContextUsageRiskNotice | null;
  handoffAction: ContextUsageHandoffAction;
  ariaLabel: string;
}

const handoffAction: ContextUsageHandoffAction = {
  title: '需要在新会话继续当前任务？',
  description: '整理当前进展，生成可带到新会话的交接摘要。',
  actionLabel: '整理交接信息',
};

export function selectContextUsageSnapshot(
  sessionUsage: TokenUsageDto | undefined,
  currentTurnUsage: TokenUsageDto | undefined,
  isRunning: boolean,
): ContextUsageSnapshot {
  if (isRunning && currentTurnUsage) return { tokenUsage: currentTurnUsage, scope: 'current' };
  return { tokenUsage: sessionUsage, scope: 'recent' };
}

export function getContextUsagePresentation(
  tokenUsage?: TokenUsageDto,
  scope: ContextUsageScope = 'recent',
): ContextUsagePresentation {
  const scopeLabel = scope === 'current' ? '当前模型请求' : '最近一次模型请求';
  if (!tokenUsage) {
    const waitingForCurrentUsage = scope === 'current';
    return {
      contextWindow: null,
      percent: null,
      remainingPercent: null,
      tone: 'unknown',
      scopeLabel,
      emptyTitle: waitingForCurrentUsage ? '正在获取当前用量' : '暂无引擎精确用量',
      emptyDescription: waitingForCurrentUsage
        ? '收到当前模型请求用量后显示上下文占用。'
        : '收到引擎精确用量后显示上下文占用。',
      riskNotice: null,
      handoffAction,
      ariaLabel: waitingForCurrentUsage
        ? '正在获取当前上下文用量，查看上下文详情'
        : '暂无引擎精确上下文用量，查看上下文详情',
    };
  }

  const contextWindow = tokenUsage.modelContextWindow;
  if (!contextWindow) {
    return {
      contextWindow: null,
      percent: null,
      remainingPercent: null,
      tone: 'unknown',
      scopeLabel,
      emptyTitle: null,
      emptyDescription: null,
      riskNotice: null,
      handoffAction,
      ariaLabel: `${scopeLabel}的上下文已使用 ${tokenUsage.totalTokens.toLocaleString()} Tokens，模型窗口上限未知，查看上下文详情`,
    };
  }

  const rawPercent = Math.min((tokenUsage.totalTokens / contextWindow) * 100, 100);
  const percent = tokenUsage.totalTokens > 0 ? Math.max(Math.round(rawPercent * 10) / 10, 0.1) : 0;
  const remainingPercent = Math.max(Math.round((100 - percent) * 10) / 10, 0);
  const tone: ContextUsageTone = percent >= 85 ? 'danger' : percent >= 70 ? 'warning' : 'normal';
  const riskNotice: ContextUsageRiskNotice | null = tone === 'danger'
    ? {
        level: 'danger',
        title: '建议尽快新建会话',
        description: `上下文已使用 ${percent}%，长上下文会放大后续工具调用成本。`,
      }
    : tone === 'warning'
      ? {
          level: 'warning',
          title: '建议在当前阶段结束后新建会话',
          description: `上下文已使用 ${percent}%，继续对话会逐步增加后续请求携带的历史内容。`,
        }
      : null;

  return {
    contextWindow,
    percent,
    remainingPercent,
    tone,
    scopeLabel,
    emptyTitle: null,
    emptyDescription: null,
    riskNotice,
    handoffAction,
    ariaLabel: `${scopeLabel}的上下文已使用 ${percent}%，查看上下文详情`,
  };
}

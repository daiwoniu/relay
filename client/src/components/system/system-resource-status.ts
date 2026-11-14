import type { SystemResourceStatusDto } from '../../generated/relay-contracts';

export type SystemResourceTone = 'neutral' | 'warning' | 'critical' | 'unknown';

export interface SystemResourcePresentation {
  tone: SystemResourceTone;
  title: string;
  summary: string;
  detail: string;
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function formatProcessMemory(bytes: number): string {
  return bytes >= 1024 ** 3 ? formatGiB(bytes) : `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

export function getProcessMemoryPresentation(snapshot: SystemResourceStatusDto | null) {
  const memory = snapshot?.processMemory;
  const relay = memory?.relay;
  return {
    available: memory != null,
    relaySummary: relay ? `${formatProcessMemory(relay.privateBytes)} · ${relay.processCount} 个进程` : '暂不可用',
    relayDetail: relay
      ? `${relay.scope === 'managed' ? '含受管启动器、前后端、引擎及工具子进程' : '仅统计后端及其子进程，未纳入独立运行的前端和引擎'}；后端本身 ${formatProcessMemory(relay.backendPrivateBytes)}。`
      : '暂未取得 Relay 进程占用。',
    rows: (memory?.topProcesses ?? []).map((row) => ({
      ...row,
      memoryLabel: formatProcessMemory(row.privateBytes),
    })),
  };
}

export function getSystemResourcePresentation(snapshot: SystemResourceStatusDto | null): SystemResourcePresentation {
  if (!snapshot?.available || snapshot.committedBytes === null || snapshot.commitLimitBytes === null || snapshot.usagePercent === null) {
    return {
      tone: 'unknown',
      title: '系统提交内存暂不可用',
      summary: '当前平台未取得可靠的提交量指标',
      detail: '不会使用物理可用内存冒充提交量，也不影响 Relay 任务运行。',
    };
  }
  const summary = `${formatGiB(snapshot.committedBytes)} / ${formatGiB(snapshot.commitLimitBytes)} · ${snapshot.usagePercent.toFixed(1)}%`;
  if (snapshot.level === 'critical') {
    return {
      tone: 'critical',
      title: '系统提交内存严重偏高',
      summary,
      detail: `已达到 ${snapshot.criticalThresholdPercent}% 严重告警线；Relay 只提示，不会自动终止进程或中断任务。`,
    };
  }
  if (snapshot.level === 'warning') {
    return {
      tone: 'warning',
      title: '系统提交内存偏高',
      summary,
      detail: `已达到 ${snapshot.warningThresholdPercent}% 提示线；请留意持续增长的任务。`,
    };
  }
  return {
    tone: 'neutral',
    title: '系统提交内存正常',
    summary,
    detail: `${snapshot.warningThresholdPercent}% 提示，${snapshot.criticalThresholdPercent}% 严重告警；当前仅观测，不参与任务准入。`,
  };
}


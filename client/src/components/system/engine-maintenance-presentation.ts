import type { EngineMaintenanceActionDto, EngineMaintenanceStatusDto } from '../../generated/relay-contracts.ts';
import { formatDateTime } from '../../utils/date-display.ts';

export type EngineMaintenanceStatusTone = 'success' | 'warning' | 'danger' | 'neutral';

type ReleaseOverviewDto = NonNullable<EngineMaintenanceStatusDto['releaseOverview']>;
type ReleaseOverviewTopic = ReleaseOverviewDto['topics'][number];

const releaseTopicLabels: Record<ReleaseOverviewTopic, string> = {
  permissions_security: '安全、权限与沙箱',
  mcp_extensions: 'MCP 与扩展',
  plugins_skills: '插件与 Skills',
  tasks_sessions: '任务与会话',
  multi_agent: '多 Agent',
  models_providers: '模型与 Provider',
  windows_cross_platform: '跨平台兼容',
  context_compaction: '上下文与压缩',
  connection_stability: '连接与稳定性',
  terminal_ui: '终端交互',
};

export function getReleaseOverviewPresentation(overview: ReleaseOverviewDto): {
  headline: string;
  detail: string;
  supplemental: string | null;
} {
  if (overview.sourceStatus === 'metadata_only') {
    return { headline: '官方未提供分类说明', detail: '可查看该版本的完整变更记录', supplemental: null };
  }
  if (overview.sourceStatus === 'unavailable') {
    return { headline: '官方说明暂时无法读取', detail: '版本信息仍可通过官方发布页核对', supplemental: null };
  }
  if (overview.sourceStatus === 'unrecognized') {
    return { headline: '官方未提供可解析的版本说明', detail: '未生成推测性摘要，请查看官方页面', supplemental: null };
  }

  const mainCounts = [
    overview.counts.features > 0 ? `${overview.counts.features} 项功能增强` : null,
    overview.counts.improvements > 0 ? `${overview.counts.improvements} 项优化` : null,
    overview.counts.fixes > 0 ? `${overview.counts.fixes} 项问题修复` : null,
  ].filter((item): item is string => Boolean(item));
  const headline = overview.counts.features === 0 && overview.counts.improvements === 0 && overview.counts.fixes > 0
    ? `维护版本 · ${overview.counts.fixes} 项问题修复`
    : mainCounts.join(' · ') || '官方提供了版本说明';
  const topicText = overview.topics.map((topic) => releaseTopicLabels[topic]).join('、');
  const extraCounts = [
    overview.counts.documentation > 0 ? `${overview.counts.documentation} 项文档` : null,
    overview.counts.chores > 0 ? `${overview.counts.chores} 项内部维护` : null,
  ].filter((item): item is string => Boolean(item));
  return {
    headline,
    detail: topicText ? `${overview.counts.features === 0 && overview.counts.fixes === 1 ? '涉及' : '重点涉及'}${topicText}` : '官方未提供可稳定归类的主题',
    supplemental: extraCounts.length > 0 ? `另含 ${extraCounts.join('、')}` : null,
  };
}

export function formatEngineMaintenanceVersion(value: string | null): string {
  return value ? `v${value}` : '未知';
}

export function formatEngineReleaseTime(timestamp: number | null | undefined): string | null {
  if (!Number.isFinite(timestamp) || timestamp === null || timestamp === undefined || timestamp < 0) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return formatDateTime(date);
}

function getStatus(engine: EngineMaintenanceStatusDto): { statusLabel: string; statusTone: EngineMaintenanceStatusTone } {
  switch (engine.availabilityStage) {
    case 'not_installed': return { statusLabel: '尚未安装', statusTone: 'warning' };
    case 'installed_auth_required':
      if (engine.readiness !== 'failed') return { statusLabel: '需要登录', statusTone: 'warning' };
      break;
    case 'protocol_incompatible': return { statusLabel: '协议不兼容', statusTone: 'danger' };
    case 'readiness_failed': return { statusLabel: '运行异常', statusTone: 'danger' };
    case 'install_failed': return { statusLabel: '安装失败', statusTone: 'danger' };
    default: break;
  }
  if (engine.readiness === 'failed') return { statusLabel: '运行异常', statusTone: 'danger' };
  if (engine.readiness === 'stale') return { statusLabel: '等待复验', statusTone: 'warning' };
  if (engine.readiness === 'unknown') return { statusLabel: '状态未知', statusTone: 'neutral' };
  return { statusLabel: '运行正常', statusTone: 'success' };
}

function getVersionHeadline(engine: EngineMaintenanceStatusDto): string {
  if (!engine.installedVersion) return '等待安装';
  if (engine.updateAvailable && engine.latestVersion) {
    return `${formatEngineMaintenanceVersion(engine.installedVersion)} → ${formatEngineMaintenanceVersion(engine.latestVersion)}`;
  }
  if (engine.updateAvailable === false && engine.latestCheckStatus === 'success') return '已是最新版本';
  return `当前 ${formatEngineMaintenanceVersion(engine.installedVersion)}`;
}

export function getEngineMaintenancePresentation(engine: EngineMaintenanceStatusDto): {
  statusLabel: string;
  statusTone: EngineMaintenanceStatusTone;
  versionHeadline: string;
  openInstallationDetails: boolean;
  primaryAction: EngineMaintenanceActionDto | null;
  secondaryActions: EngineMaintenanceActionDto[];
} {
  const primaryAction = engine.recommendedAction
    ? engine.actions.find((item) => item.action === engine.recommendedAction) ?? null
    : null;
  const openInstallationDetails = engine.updateAvailable === true
    || engine.latestCheckStatus === 'error'
    || engine.installSource === 'unknown'
    || (engine.availabilityStage !== undefined && engine.availabilityStage !== 'ready')
    || (engine.runningVersion !== null && engine.installedVersion !== null && engine.runningVersion !== engine.installedVersion)
    || engine.instanceVersions.length > 1;
  return {
    ...getStatus(engine),
    versionHeadline: getVersionHeadline(engine),
    openInstallationDetails,
    primaryAction,
    secondaryActions: engine.actions.filter((item) => item.action !== primaryAction?.action),
  };
}

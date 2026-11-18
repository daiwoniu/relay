import type { ReactNode, RefObject } from 'react';
import type { EngineId, EngineStatusDto } from '../../generated/relay-contracts';
import type { Project } from '../../stores/chat';
import { truncateMiddlePath } from '../../utils/path-display';
import ProjectDetailsContent from '../layout/ProjectDetailsContent';
import HoverCard from '../ui/HoverCard';
import Popover from '../ui/Popover';
import PopoverSection from '../ui/PopoverSection';
import EngineSelector from './EngineSelector';
import type { ContextUsageTone } from './context-usage-presentation';
import ApprovalTrustControl from '../authorization/ApprovalTrustControl';

export type ChatInputMobileDetails = 'project' | 'context';

interface Props {
  projects: Project[];
  currentProjectId: string | null;
  currentProject?: Project;
  displayName: string;
  canSelectProject: boolean;
  canCreateProject: boolean;
  projectMenuButtonRef: RefObject<HTMLButtonElement | null>;
  projectMenuAnchor: DOMRect | null;
  onToggleProjectMenu: (button: HTMLButtonElement) => void;
  onCloseProjectMenu: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenDirectoryPicker: () => void;
  selectedEngine: EngineId | null;
  engineStatuses: EngineStatusDto[];
  engineLocked: boolean;
  engineFallbackNotice?: string | null;
  isMobile: boolean;
  onEngineChange: (engine: EngineId) => () => void;
  onEngineStatusesChange: (statuses: EngineStatusDto[]) => void;
  modelSettingsControl: ReactNode;
  onOpenMobileDetails: (details: ChatInputMobileDetails) => void;
  activeSessionId: string | null;
  tokenUsageAvailable: boolean;
  contextUsage: {
    percent: number | null;
    tone: ContextUsageTone;
    ariaLabel: string;
  };
  contextCompactionCount: number;
  contextUsageDetails: ReactNode;
}

function getContextUsageColor(tone: ContextUsageTone): string {
  if (tone === 'danger') return 'var(--color-status-danger)';
  if (tone === 'warning') return 'var(--color-status-warning)';
  if (tone === 'normal') return 'var(--color-status-success)';
  return 'var(--color-status-track)';
}

function CircularProgress({ percent, tone, count }: { percent: number | null; tone: ContextUsageTone; count: number }) {
  const size = 18;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = percent === null ? circumference : circumference * (1 - Math.min(percent, 100) / 100);
  const displayCount = Math.max(0, Math.floor(count));
  const displayLabel = displayCount > 9 ? '9+' : String(displayCount);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block shrink-0" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-bg-tertiary)" strokeWidth={stroke} />
      {percent !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={getContextUsageColor(tone)}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.2s ease' }}
        />
      )}
      {displayCount >= 1 && (
        <text
          x={size / 2}
          y={size / 2 - 0.5}
          dominantBaseline="central"
          textAnchor="middle"
          fill="currentColor"
          fontSize={displayCount > 9 ? 6.5 : 8}
          fontWeight="700"
          className="tabular-nums"
        >
          {displayLabel}
        </text>
      )}
    </svg>
  );
}

export default function ChatInputMetadataBar({
  projects,
  currentProjectId,
  currentProject,
  displayName,
  canSelectProject,
  canCreateProject,
  projectMenuButtonRef,
  projectMenuAnchor,
  onToggleProjectMenu,
  onCloseProjectMenu,
  onSelectProject,
  onOpenDirectoryPicker,
  selectedEngine,
  engineStatuses,
  engineLocked,
  engineFallbackNotice,
  isMobile,
  onEngineChange,
  onEngineStatusesChange,
  modelSettingsControl,
  onOpenMobileDetails,
  activeSessionId,
  tokenUsageAvailable,
  contextUsage,
  contextCompactionCount,
  contextUsageDetails,
}: Props) {
  return (
    <div className="composer-metadata-bar">
      {canSelectProject ? (
        <div className="relative min-w-0 flex-1">
          <div className="composer-metadata-leading overflow-hidden">
            <button
              ref={projectMenuButtonRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={projectMenuAnchor !== null}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => onToggleProjectMenu(event.currentTarget)}
              className="composer-compact-trigger composer-project-trigger"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0"><path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
              <span className="truncate whitespace-nowrap">{displayName}</span>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="shrink-0 text-[var(--color-text-tertiary)]"><path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <EngineSelector value={selectedEngine} statuses={engineStatuses} locked={engineLocked} fallbackNotice={engineFallbackNotice} mobile={isMobile} onChange={onEngineChange} onStatusesChange={onEngineStatusesChange} />
          </div>

          <Popover open={projectMenuAnchor !== null} anchorRect={projectMenuAnchor} onClose={onCloseProjectMenu} placement="top" mobile={isMobile} mobilePresentation="sheet" label="选择项目" className={isMobile ? '' : 'w-72'}>
            <PopoverSection
              title="选择项目"
              description="新会话将关联到所选项目"
              bodyClassName="max-h-60 overflow-y-auto py-1"
              footer={canCreateProject ? <button type="button" onClick={onOpenDirectoryPicker} className="popover-action-row"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 6V4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M2.25 12.75l1.2-4A1 1 0 014.4 8h9.15a1 1 0 01.96 1.28l-1.2 4a1 1 0 01-.96.72H3.2a1 1 0 01-.95-1.25z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>选择项目工作目录</button> : undefined}
            >
            <div role="listbox" aria-label="项目列表">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="option"
                  aria-selected={project.id === currentProjectId}
                  onClick={() => onSelectProject(project.id)}
                  className={`popover-option-row ${project.id === currentProjectId ? 'popover-option-row--selected' : ''}`}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true"><path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
                  <div className="min-w-0 flex-1"><div className="truncate">{project.name}</div><div className="truncate text-xs text-[var(--color-text-tertiary)]">{project.access_role && project.access_role !== 'owner' && project.owner ? `${project.owner.displayName} · ${truncateMiddlePath(project.path, 42)}` : truncateMiddlePath(project.path, 42)}</div></div>
                  {project.id === currentProjectId && <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text)]" aria-hidden="true"><path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </button>
              ))}
            </div>
            </PopoverSection>
          </Popover>
        </div>
      ) : (
        <div className="composer-metadata-leading flex-1 overflow-hidden">
          <HoverCard disabled={isMobile || !currentProject?.path} placement="top" title="项目详情" content={currentProject ? <ProjectDetailsContent project={currentProject} /> : null} className="min-w-0">
            <button type="button" onClick={() => { if (currentProject?.path) onOpenMobileDetails('project'); }} className="composer-compact-trigger composer-project-trigger" aria-label={currentProject ? '查看项目详情' : undefined}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0"><path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
              <span className="truncate whitespace-nowrap">{displayName}</span>
            </button>
          </HoverCard>
          <EngineSelector value={selectedEngine} statuses={engineStatuses} locked={engineLocked} mobile={isMobile} onChange={onEngineChange} onStatusesChange={onEngineStatusesChange} />
        </div>
      )}

      <div className="composer-metadata-actions">
        <div className="min-w-0">{modelSettingsControl}</div>
        <ApprovalTrustControl projectId={currentProjectId} sessionId={activeSessionId} isMobile={isMobile} />
        {activeSessionId && tokenUsageAvailable && (
          <HoverCard disabled={isMobile} placement="top" title="上下文用量" maxWidth="min(22rem, calc(100vw - 1rem))" openOnClick content={<div className="w-max max-w-full min-w-0 overflow-hidden">{contextUsageDetails}</div>}>
            <button type="button" onClick={() => { if (isMobile) onOpenMobileDetails('context'); }} className="composer-context-trigger" aria-label={contextCompactionCount >= 1 ? `${contextUsage.ariaLabel}，已自动整理 ${contextCompactionCount} 次` : contextUsage.ariaLabel}>
              <CircularProgress percent={contextUsage.percent} tone={contextUsage.tone} count={contextCompactionCount} />
            </button>
          </HoverCard>
        )}
      </div>
    </div>
  );
}

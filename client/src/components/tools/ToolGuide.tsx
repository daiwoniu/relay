import HelpBadge from '../workspace-console/WorkspaceHelpBadge';
import { formatHelpText } from '../workspace-console/workspace-help-text.ts';
import { toolsCatalog, type ToolGuideInfo } from './tools-catalog';
import type { ToolId } from './tools-state';

export function ToolName({ tool }: { tool: ToolGuideInfo }) {
  return <>{tool.title}{tool.term && <span className="tool-name-term">（{tool.term}）</span>}</>;
}

export function ToolGuide({ id, compact = false }: { id: ToolId; compact?: boolean }) {
  const tool = toolsCatalog[id];
  return <details className={`tool-guide${compact ? ' tool-guide-compact' : ''}`}>
    <summary>常见用法 <HelpBadge label={tool.title} content={tool.start} triggerClassName="tool-hint-trigger" /></summary>
    <div className="tool-guide-content">
      <p>{formatHelpText(tool.start)}</p>
      <ul>{tool.examples.map((example) => <li key={example}>{formatHelpText(example)}</li>)}</ul>
    </div>
  </details>;
}

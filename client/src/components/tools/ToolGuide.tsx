import { formatHelpText } from '../workspace-console/workspace-help-text.ts';
import { toolsCatalog, type ToolGuideInfo } from './tools-catalog';
import type { ToolId } from './tools-state';

export function ToolName({ tool }: { tool: ToolGuideInfo }) {
  return <>{tool.title}{tool.term && <span className="tool-name-term">（{tool.term}）</span>}</>;
}

export function ToolGuide({ id, compact = false }: { id: ToolId; compact?: boolean }) {
  const tool = toolsCatalog[id];
  return <details className={`tool-guide${compact ? ' tool-guide-compact' : ''}`}>
    <summary aria-label={compact ? '常见用法' : undefined}>{compact ? '用法' : '常见用法'}</summary>
    <div className="tool-guide-content">
      <p>{formatHelpText(tool.start)}</p>
      <ul>{tool.examples.map((example) => <li key={example}>{formatHelpText(example)}</li>)}</ul>
    </div>
  </details>;
}

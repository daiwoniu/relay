import Tooltip from '../ui/Tooltip';
import { formatHelpText } from './workspace-help-text.ts';

/** Hover/focus help with a tap alternative; safe inside a details summary. */
export default function WorkspaceHelpBadge({ label, content, triggerClassName, coexist }: {
  label: string; content: string; triggerClassName?: string; coexist?: boolean;
}) {
  return <span className="ml-1 inline-flex shrink-0 align-middle font-normal">
    <Tooltip content={formatHelpText(content)} coexist={coexist} pinOnClick asChild>
      <button type="button" aria-label={`${label}说明`}
        className={triggerClassName ?? 'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-sm text-slate-400 hover:bg-white/10 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300'}>
        <span aria-hidden="true">ⓘ</span>
      </button>
    </Tooltip>
  </span>;
}

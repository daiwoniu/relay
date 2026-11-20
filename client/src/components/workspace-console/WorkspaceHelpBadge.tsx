import { useRef, useState } from 'react';
import Tooltip from '../ui/Tooltip';
import Popover from '../ui/Popover';
import { formatHelpText } from './workspace-help-text.ts';

/** Hover/focus help with a tap alternative; safe inside a details summary. */
export default function WorkspaceHelpBadge({ label, content }: { label: string; content: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const text = formatHelpText(content);
  return <span className="ml-1 inline-flex shrink-0 align-middle font-normal" onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
    <Tooltip content={text} disabled={anchor !== null} asChild>
      <button ref={trigger} type="button" aria-label={`${label}说明`} aria-haspopup="dialog" aria-expanded={anchor !== null}
        onClick={event => { event.preventDefault(); event.stopPropagation(); setAnchor(current => current ? null : trigger.current?.getBoundingClientRect() ?? null); }}
        className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-sm text-slate-400 hover:bg-white/10 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
        <span aria-hidden="true">ⓘ</span>
      </button>
    </Tooltip>
    <Popover open={anchor !== null} anchorRect={anchor} label={`${label}说明`} onClose={() => setAnchor(null)} className="max-w-[min(24rem,calc(100vw-1rem))] whitespace-pre-line p-3 text-xs leading-5">
      {text}
    </Popover>
  </span>;
}

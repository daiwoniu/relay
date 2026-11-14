import { getFailurePresentation } from './failure-presentation';

/** Phrasing content also works inside existing p/small/span containers. Never inject error HTML. */
export default function FailureNotice({ error, code, description, suggestion }: {
  error: unknown; code?: string; description?: string; suggestion?: string;
}) {
  const detail = getFailurePresentation(error, code);
  return <span className="block min-w-0 text-left" data-failure-notice>
    <span className="block">{description || detail.description}</span>
    <span className="mt-1 block"><span className="font-medium">处理建议：</span>{suggestion || detail.suggestion}</span>
    <span className="mt-2 block whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs opacity-80"><span className="font-medium">原始异常：</span>{detail.raw}{detail.code && <span className="ml-2 font-mono">{detail.code}</span>}</span>
  </span>;
}

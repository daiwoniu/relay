import type { MessageSearchSnippetDto } from '../../generated/relay-contracts';
import { buildHighlightedTextParts, buildHighlightedTextPartsFromRange } from './session-search-view';

function HighlightedText({ text, query, matchStart, matchLength }: {
  text: string;
  query: string;
  matchStart?: number;
  matchLength?: number;
}) {
  const parts = matchStart === undefined || matchLength === undefined
    ? buildHighlightedTextParts(text, query)
    : buildHighlightedTextPartsFromRange(text, matchStart, matchLength);
  return parts.map((part, index) => (
    part.highlighted
      ? <mark key={`${index}-${part.text}`} className="rounded-sm bg-[var(--color-status-warning)]/25 px-0.5 text-inherit">{part.text}</mark>
      : <span key={`${index}-${part.text}`}>{part.text}</span>
  ));
}

export function SessionSearchTitle({ title, query, matched }: {
  title: string;
  query: string;
  matched: boolean;
}) {
  return <>{matched ? <HighlightedText text={title} query={query} /> : title}</>;
}

export default function SessionSearchSummary({ countLabel, snippet, query }: {
  countLabel: string;
  snippet: MessageSearchSnippetDto;
  query: string;
}) {
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
      <span className="shrink-0">{countLabel}</span>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate">
        <HighlightedText
          text={snippet.text}
          query={query}
          matchStart={snippet.matchStart}
          matchLength={snippet.matchLength}
        />
      </span>
    </div>
  );
}

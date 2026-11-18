import { useLayoutEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { shouldDimShareMessage } from '../sharing/share-selection';
import CopyIcon from '../icons/CopyIcon';
import Tooltip from '../ui/Tooltip';
import type { MessageAttachmentDto, MessageAttachmentSummaryDto, MessageOriginDto } from '../../generated/relay-contracts';
import MessageAttachmentList from './MessageAttachmentList';
import { createUserMessageCopyText } from './user-message-copy';
import MessageOriginInfo from './MessageOriginInfo';
import { formatCompletionTime } from './message-duration-presentation.ts';

interface Props {
  content: string;
  attachments?: MessageAttachmentDto[] | MessageAttachmentSummaryDto[];
  readOnly?: boolean;
  full?: boolean;
  createdAt: number;
  selectionMode?: boolean;
  selected?: boolean;
  selectable?: boolean;
  onToggleSelection?: () => void;
  messageId?: string;
  searchTarget?: boolean;
  origin?: MessageOriginDto;
  mobile?: boolean;
}

export default function UserMessage({ content, attachments, readOnly = false, full, createdAt, selectionMode = false, selected = false, selectable = true, onToggleSelection, messageId, searchTarget = false, origin, mobile = false }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [copied, setCopied] = useState(false);
  const displayExpanded = full || expanded || searchTarget;

  useLayoutEffect(() => {
    if (displayExpanded || !contentRef.current) return;
    const element = contentRef.current;
    const updateOverflow = () => setHasOverflow(element.scrollHeight > element.clientHeight + 1);
    updateOverflow();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, displayExpanded]);

  const handleCopy = () => {
    copyToClipboard(createUserMessageCopyText(content, attachments)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div data-message-id={messageId} className={`message-row message-row--user flex justify-end group ${searchTarget ? 'search-target-message' : ''} ${selectionMode ? 'items-start gap-3' : ''} ${shouldDimShareMessage(selectionMode, selectable) ? 'opacity-55' : ''}`}>
      {selectionMode && <input type="checkbox" className="mt-4 h-4 w-4 shrink-0" checked={selected} disabled={!selectable} onChange={onToggleSelection} aria-label="选择这条用户消息" />}
      <div className="message-shell message-shell--user message-bubble min-w-0 w-fit">
        <div className="message-content message-content--user user-message theme-message-content" data-search-content>
          <MessageAttachmentList attachments={attachments} readOnly={readOnly} />
          {content && (
          <div className="relative">
            <div
              ref={contentRef}
              className={`whitespace-pre-wrap break-words ${displayExpanded ? '' : 'user-message-collapsed'}`}
            >
              {content}
            </div>
            {hasOverflow && <div hidden={displayExpanded} className="user-message-fade pointer-events-none" />}
          </div>
          )}
          {hasOverflow && !searchTarget && (
            <div className="mt-2">
              <button
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={displayExpanded}
                className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
              >
                {displayExpanded ? '收起' : '显示更多'}
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`transition-transform ${displayExpanded ? 'rotate-180' : ''}`}>
                  <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="message-support message-support--user message-meta message-meta--user justify-end pr-1">
          <div
            className="message-actions message-actions--compact flex items-center"
            onPointerUp={(event) => event.stopPropagation()}
          >
            {origin && <MessageOriginInfo origin={origin} mobile={mobile} />}
            <Tooltip content={copied ? '已复制' : '复制'}>
              <button type="button" onClick={handleCopy} className="message-action-button" aria-label={copied ? '已复制' : '复制'}>
                <CopyIcon copied={copied} />
              </button>
            </Tooltip>
          </div>
          <span className="shrink-0">{formatCompletionTime(createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

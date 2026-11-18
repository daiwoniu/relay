import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatClockTime } from '../../utils/date-display.ts';
import { useLocalNotes } from '../../hooks/useLocalNotes';
import {
  LOCAL_NOTES_LIMIT,
  LOCAL_NOTE_MAX_LENGTH,
  type DeletedLocalNote,
} from '../../stores/local-notes';
import { copyToClipboard } from '../../utils/clipboard';
import IconActionButton from '../ui/IconActionButton';
import Popover from '../ui/Popover';
import { getLocalNoteEditorSize, getLocalNoteInitialEditorHeight, getLocalNotesPanelWidth } from './local-notes-layout';

interface Props {
  isMobile: boolean;
  onInsert: (content: string) => void;
}

function NoteIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 2.5h10v7.2L8.7 14H3a1 1 0 01-1-1V3.5a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M8.7 14V9.7H13M5 6h5M5 8.5h4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatUpdatedAt(timestamp: number) {
  return formatClockTime(timestamp);
}

function resizeTextarea(textarea: HTMLTextAreaElement, initialHeight?: number) {
  textarea.style.height = 'auto';
  const { height, scrollable } = getLocalNoteEditorSize(textarea.scrollHeight, initialHeight);
  textarea.style.height = `${height}px`;
  textarea.style.overflowY = scrollable ? 'auto' : 'hidden';
}

export default function LocalNotesControl({ isMobile, onInsert }: Props) {
  const {
    notes,
    storageError,
    createNote,
    updateNote,
    removeNote,
    restoreNote,
    removeEmptyNotes,
  } = useLocalNotes();
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingViewHeight, setEditingViewHeight] = useState<number | null>(null);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; ok: boolean } | null>(null);
  const [deletedNote, setDeletedNote] = useState<DeletedLocalNote | null>(null);
  const noteRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const initialEditorHeightsRef = useRef(new Map<string, number>());
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = anchorRect !== null;
  const atLimit = notes.length >= LOCAL_NOTES_LIMIT;
  const panelWidth = getLocalNotesPanelWidth(notes.map((note) => note.content));

  useEffect(() => () => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    if (!focusNoteId) return;
    const textarea = noteRefs.current.get(focusNoteId);
    if (!textarea) return;
    resizeTextarea(textarea, initialEditorHeightsRef.current.get(focusNoteId));
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    setFocusNoteId(null);
  }, [focusNoteId, notes]);

  useLayoutEffect(() => {
    noteRefs.current.forEach((textarea, id) => {
      resizeTextarea(textarea, initialEditorHeightsRef.current.get(id));
    });
  }, [notes]);

  const closePanel = useCallback(() => {
    removeEmptyNotes();
    setAnchorRect(null);
    setEditingNoteId(null);
    setEditingViewHeight(null);
    setFocusNoteId(null);
    initialEditorHeightsRef.current.clear();
  }, [removeEmptyNotes]);

  const handleCreate = () => {
    const note = createNote();
    if (note) {
      initialEditorHeightsRef.current.set(note.id, 24);
      setEditingNoteId(note.id);
      setEditingViewHeight(24);
      setFocusNoteId(note.id);
    }
  };

  const handleStartEditing = (id: string, viewHeight: number) => {
    const editorHeight = getLocalNoteInitialEditorHeight(viewHeight);
    initialEditorHeightsRef.current.set(id, editorHeight);
    setEditingNoteId(id);
    setEditingViewHeight(editorHeight);
    setFocusNoteId(id);
  };

  const handleEditorBlur = (id: string, content: string) => {
    setEditingNoteId((current) => current === id ? null : current);
    setEditingViewHeight(null);
    initialEditorHeightsRef.current.delete(id);
    if (!content.trim()) removeEmptyNotes();
  };

  const handleCopy = async (id: string, content: string) => {
    try {
      await copyToClipboard(content);
      setCopyFeedback({ id, ok: true });
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = setTimeout(() => setCopyFeedback(null), 1600);
    } catch {
      setCopyFeedback({ id, ok: false });
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = setTimeout(() => setCopyFeedback(null), 2000);
    }
  };

  const handleDelete = (id: string) => {
    const deleted = removeNote(id);
    setDeletedNote(deleted);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setDeletedNote(null), 5000);
  };

  const handleUndo = () => {
    restoreNote(deletedNote);
    setDeletedNote(null);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
  };

  const handleInsert = (content: string) => {
    if (!content.trim()) return;
    onInsert(content);
    closePanel();
  };

  return (
    <>
      <IconActionButton
        label="临时便签"
        variant="neutral"
        className="relative h-[30px] w-[30px] rounded-xl"
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const nextRect = event.currentTarget.getBoundingClientRect();
          setAnchorRect((current) => current ? null : nextRect);
        }}
      >
        <NoteIcon />
        {notes.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-text)] px-1 text-[9px] font-semibold leading-none text-[var(--color-bg)]">
            {notes.length}
          </span>
        )}
      </IconActionButton>

      <Popover
        open={open}
        anchorRect={anchorRect}
        onClose={closePanel}
        placement="top"
        gap={8}
        mobile={isMobile}
        mobilePresentation="sheet"
        label="临时便签"
        className={isMobile ? '' : 'max-w-[calc(100vw-24px)]'}
        desktopStyle={{ width: panelWidth }}
      >
        <div className="flex max-h-[min(70vh,32rem)] flex-col text-[var(--color-text)]">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">临时便签</div>
              <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">全局共享 · 自动保存在当前浏览器</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <IconActionButton
                label={atLimit ? '已达到 10 条上限' : '新建便签'}
                variant="neutral"
                tooltipPlacement="top"
                disabled={atLimit}
                onClick={handleCreate}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </IconActionButton>
              <IconActionButton label="关闭便签" variant="neutral" tooltip={false} onClick={closePanel}>
                <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </IconActionButton>
            </div>
          </div>

          {storageError && (
            <div role="status" className="mx-3 mt-2 rounded-lg border border-[var(--color-status-warning)]/30 bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text-secondary)]">
              浏览器存储暂不可用，本页内容可能无法在刷新后恢复。
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {notes.length === 0 ? (
              <button
                type="button"
                onClick={handleCreate}
                className="flex min-h-[87px] w-full flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border)] px-4 text-center transition-colors hover:border-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
              >
                <span className="mb-1 text-[var(--color-text-tertiary)]"><NoteIcon /></span>
                <span className="text-sm font-medium text-[var(--color-text-secondary)]">记录一个临时想法</span>
                <span className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">点击创建，输入时自动保存</span>
              </button>
            ) : (
              <div className="space-y-2.5">
                {notes.map((note) => {
                  const isBlank = !note.content.trim();
                  const isEditing = editingNoteId === note.id;
                  return (
                    <div key={note.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2.5 transition-colors focus-within:border-[var(--color-text-tertiary)]">
                      <div style={isEditing && editingViewHeight ? { minHeight: editingViewHeight } : undefined}>
                        {isEditing ? (
                          <textarea
                            ref={(element) => {
                              if (element) {
                                noteRefs.current.set(note.id, element);
                                resizeTextarea(element, initialEditorHeightsRef.current.get(note.id));
                              } else {
                                noteRefs.current.delete(note.id);
                              }
                            }}
                            value={note.content}
                            onChange={(event) => {
                              initialEditorHeightsRef.current.delete(note.id);
                              updateNote(note.id, event.target.value);
                              resizeTextarea(event.currentTarget);
                            }}
                            onBlur={() => handleEditorBlur(note.id, note.content)}
                            enterKeyHint="enter"
                            maxLength={LOCAL_NOTE_MAX_LENGTH}
                            rows={1}
                            placeholder="输入临时记录或稍后要发给 AI 的想法……"
                            className="block w-full resize-none bg-transparent text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-tertiary)]"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={(event) => handleStartEditing(note.id, event.currentTarget.getBoundingClientRect().height)}
                            className={`block min-h-6 w-full whitespace-pre-wrap break-words text-left text-sm leading-6 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${isBlank ? 'text-[var(--color-text-tertiary)]' : 'text-[var(--color-text)]'}`}
                          >
                            {isBlank ? '点击输入临时记录……' : note.content}
                          </button>
                        )}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--color-border-light)] pt-2">
                        <div className="min-w-0 text-[10px] text-[var(--color-text-tertiary)]">
                          {note.content.length} / {LOCAL_NOTE_MAX_LENGTH} · {formatUpdatedAt(note.updatedAt)}
                        </div>
                        <div className="flex shrink-0 items-center gap-1 text-xs">
                          <button
                            type="button"
                            disabled={isBlank}
                            onClick={() => handleInsert(note.content)}
                            className="rounded-md px-2 py-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            插入
                          </button>
                          <button
                            type="button"
                            disabled={isBlank}
                            onClick={() => void handleCopy(note.id, note.content)}
                            className="rounded-md px-2 py-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {copyFeedback?.id === note.id ? (copyFeedback.ok ? '已复制' : '复制失败') : '复制'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(note.id)}
                            className="rounded-md px-2 py-1 text-[var(--color-danger-text)] transition-colors hover:bg-[var(--color-danger-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
            {deletedNote ? (
              <>
                <span>已删除一条便签</span>
                <button
                  type="button"
                  onClick={handleUndo}
                  className="rounded-md px-2 py-1 font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                >
                  撤销
                </button>
              </>
            ) : (
              <>
                <span>{notes.length} / {LOCAL_NOTES_LIMIT} 条</span>
                {atLimit && <span>删除后可继续添加</span>}
              </>
            )}
          </div>
        </div>
      </Popover>
    </>
  );
}

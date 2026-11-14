import type { ChangeEventHandler, RefObject } from 'react';
import IconActionButton from '../ui/IconActionButton';
import Popover from '../ui/Popover';
import PopoverSection from '../ui/PopoverSection';
import LocalNotesControl from './LocalNotesControl';

interface Props {
  anchorRect: DOMRect | null;
  disabled: boolean;
  isMobile: boolean;
  deviceFileInputRef: RefObject<HTMLInputElement | null>;
  imageInputRef: RefObject<HTMLInputElement | null>;
  cameraInputRef: RefObject<HTMLInputElement | null>;
  onToggle: (button: HTMLButtonElement) => void;
  onClose: () => void;
  onOpenHostFilePicker: () => void;
  onFilesSelected: ChangeEventHandler<HTMLInputElement>;
  onInsertLocalNote: (content: string) => void;
}

export default function ChatInputAddContentControl({ anchorRect, disabled, isMobile, deviceFileInputRef, imageInputRef, cameraInputRef, onToggle, onClose, onOpenHostFilePicker, onFilesSelected, onInsertLocalNote }: Props) {
  return (
    <div className="mb-[3px] flex shrink-0 items-center gap-0">
      <IconActionButton label="添加内容" variant="neutral" className="h-[30px] w-[30px] rounded-xl" disabled={disabled} aria-haspopup="dialog" aria-expanded={anchorRect !== null} onClick={(event) => onToggle(event.currentTarget)}>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      </IconActionButton>

      <Popover open={anchorRect !== null} anchorRect={anchorRect} onClose={onClose} placement="top" mobile={isMobile} mobilePresentation="sheet" label="添加内容" className={isMobile ? '' : 'w-[min(19rem,calc(100vw-1.5rem))]'}>
        <PopoverSection title="添加内容" description="文件、图片与设备内容" bodyClassName="p-2">
        <div>
          <button type="button" onClick={onOpenHostFilePicker} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-[var(--color-surface-hover)]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" data-icon="computer-file" aria-hidden="true"><rect x="1.5" y="2.25" width="9.5" height="7.25" rx="1.25" stroke="currentColor" strokeWidth="1.3"/><path d="M4.75 12.75h3.5M6.5 9.5v3.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><path d="M8.75 5.75h2.5L14.25 8.75v4.75h-5.5V5.75z" fill="var(--color-bg-secondary)" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M11.25 5.75v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg></span>
            <span><span className="block text-sm font-medium text-[var(--color-text)]">选择电脑文件</span><span className="block text-xs text-[var(--color-text-tertiary)]">浏览 Relay 所在电脑</span></span>
          </button>
          <button type="button" onClick={() => { onClose(); deviceFileInputRef.current?.click(); }} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-[var(--color-surface-hover)]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" data-icon="file-add" aria-hidden="true"><path d="M3.5 2.5h5l3 3V13a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5V2.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M8.5 2.5v3h3M5.5 9.5h4M7.5 7.5v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
            <span><span className="block text-sm font-medium text-[var(--color-text)]">上传设备文件</span><span className="block text-xs text-[var(--color-text-tertiary)]">从当前设备选择，单文件不超过 50MB</span></span>
          </button>
          <button type="button" onClick={() => { onClose(); imageInputRef.current?.click(); }} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-[var(--color-surface-hover)]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" data-icon="image" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M4 11l2.5-2.5 2 2L10 9l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/><circle cx="10.5" cy="6" r="1" fill="currentColor"/></svg></span>
            <span><span className="block text-sm font-medium text-[var(--color-text)]">{isMobile ? '选择图片' : '上传图片'}</span><span className="block text-xs text-[var(--color-text-tertiary)]">支持常规 PNG、JPEG、GIF、WebP 等图片</span></span>
          </button>
          {isMobile && <button type="button" onClick={() => { onClose(); cameraInputRef.current?.click(); }} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-[var(--color-surface-hover)]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" data-icon="camera" aria-hidden="true"><path d="M3 5h2l1-1.5h4L11 5h2a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3"/><circle cx="8" cy="8.5" r="2.2" stroke="currentColor" strokeWidth="1.3"/></svg></span>
            <span><span className="block text-sm font-medium text-[var(--color-text)]">拍照</span><span className="block text-xs text-[var(--color-text-tertiary)]">调用后置摄像头拍摄并上传</span></span>
          </button>}
        </div>
        </PopoverSection>
      </Popover>

      <input ref={deviceFileInputRef} type="file" multiple className="hidden" onChange={onFilesSelected} />
      <input ref={imageInputRef} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml" className="hidden" onChange={onFilesSelected} />
      <input ref={cameraInputRef} type="file" accept="image/jpeg,image/png" capture="environment" className="hidden" onChange={onFilesSelected} />
      <LocalNotesControl isMobile={isMobile} onInsert={onInsertLocalNote} />
    </div>
  );
}

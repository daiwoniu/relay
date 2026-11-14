import FailureNotice from '../ui/FailureNotice';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { browseHostFiles, type HostFileEntry } from '../../api/filesystem';
import { generateUUID } from '../../utils/uuid';
import FileTypeIcon from '../messages/FileTypeIcon';
import type { HostFileDraft } from './host-file-drafts';
import { getHostParentPath } from './host-file-path';
import FileBrowserSearch, { FileBrowserSearchButton } from './FileBrowserSearch';
import FilePickerShell from './FilePickerShell';
import { filterFileBrowserEntries, formatFileBrowserModifiedTime } from './file-browser-utils';

interface Props {
  initialPath?: string;
  remainingSlots: number;
  existingHostFilePaths: string[];
  onDirectoryChange?: (directoryPath: string) => void;
  onSelect: (attachments: HostFileDraft[]) => void;
  onCancel: () => void;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function hostPathKey(filePath: string): string {
  return /^[A-Za-z]:[\\/]/.test(filePath) ? filePath.toLowerCase() : filePath;
}

export default function HostFilePicker({ initialPath, remainingSlots, existingHostFilePaths, onDirectoryChange, onSelect, onCancel }: Props) {
  const [currentPath, setCurrentPath] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<HostFileEntry[]>([]);
  const [selected, setSelected] = useState<Map<string, HostFileEntry>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const browse = useCallback((targetPath?: string) => {
    const requestedPath = targetPath || '';
    setLoading(true);
    setError('');
    setSearchQuery('');
    setSearchOpen(false);
    browseHostFiles(targetPath)
      .then((result) => {
        setCurrentPath(result.current);
        setParent(result.parent);
        setEntries(result.entries);
        onDirectoryChange?.(result.current);
      })
      .catch((browseError: unknown) => {
        setCurrentPath(requestedPath);
        setParent(getHostParentPath(requestedPath));
        setEntries([]);
        setError(browseError instanceof Error ? browseError.message : '无法访问此目录');
      })
      .finally(() => setLoading(false));
  }, [onDirectoryChange]);

  useEffect(() => { browse(initialPath || undefined); }, [browse, initialPath]);

  const selectedEntries = useMemo(() => [...selected.values()], [selected]);
  const selectableLimit = Math.max(0, Math.min(10, remainingSlots));
  const existingPaths = useMemo(() => new Set(existingHostFilePaths.map(hostPathKey)), [existingHostFilePaths]);
  const visibleEntries = useMemo(() => filterFileBrowserEntries(entries, searchQuery), [entries, searchQuery]);
  const closeSearch = () => {
    setSearchQuery('');
    setSearchOpen(false);
  };
  const toggleSearch = () => {
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  };
  const toggleFile = (entry: HostFileEntry) => {
    if (existingPaths.has(hostPathKey(entry.path))) return;
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else if (next.size < selectableLimit) next.set(entry.path, entry);
      return next;
    });
  };

  const confirm = () => {
    onSelect(selectedEntries.map((entry) => ({
      id: generateUUID(),
      kind: 'host_file',
      name: entry.name,
      path: entry.path,
      size: entry.size || 0,
    })));
  };

  return (
    <FilePickerShell labelledBy="host-file-picker-title" title="选择电脑文件" subtitle={currentPath || '此电脑'} onClose={onCancel} onBack={() => parent !== null && browse(parent || undefined)} backDisabled={parent === null || loading} headerActions={<FileBrowserSearchButton open={searchOpen} onToggle={toggleSearch} disabled={loading} />} footer={<><span className="text-xs text-[var(--color-text-secondary)]">已选择 {selected.size} 个，还可选择 {Math.max(0, selectableLimit - selected.size)} 个</span><div className="flex gap-2"><button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">取消</button><button type="button" onClick={confirm} disabled={selected.size === 0} className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-sm text-[var(--theme-on-primary)] disabled:opacity-40">{selected.size > 0 ? `添加 ${selected.size} 个文件` : '添加文件'}</button></div></>}>

      {searchOpen && (
        <FileBrowserSearch value={searchQuery} onChange={setSearchQuery} onClose={closeSearch} disabled={loading} />
      )}

      <div className="min-h-[260px] flex-1 overflow-y-auto">
        {loading ? <div className="py-12 text-center text-sm text-[var(--color-text-tertiary)]">正在读取目录…</div>
          : error ? <div className="px-5 py-10 text-center"><p role="alert" className="text-sm text-[var(--color-danger-text)]"><FailureNotice error={error} /></p><button type="button" onClick={() => browse(currentPath || undefined)} className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm">重试</button></div>
            : entries.length === 0 ? <div className="py-12 text-center text-sm text-[var(--color-text-tertiary)]">此目录为空</div>
              : visibleEntries.length === 0 ? <div className="py-12 text-center text-sm text-[var(--color-text-tertiary)]">当前目录没有匹配项</div>
                : <div className="py-1">{visibleEntries.map((entry) => {
                  if (entry.kind === 'directory') {
                    return (
                      <button key={entry.path} type="button" onClick={() => browse(entry.path)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--color-surface-hover)]">
                        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text-secondary)]"><path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.4" /></svg>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-[var(--color-text)]">{entry.name}</span>
                          {typeof entry.modifiedAt === 'number' && Number.isFinite(entry.modifiedAt) && (
                            <span className="mt-0.5 block text-[11px] leading-4 text-[var(--color-text-tertiary)]">修改于 {formatFileBrowserModifiedTime(entry.modifiedAt)}</span>
                          )}
                        </span>
                        <span className="text-[var(--color-text-tertiary)]">›</span>
                      </button>
                    );
                  }
                  const alreadyAdded = existingPaths.has(hostPathKey(entry.path));
                  const selectionFull = !selected.has(entry.path) && selected.size >= selectableLimit;
                  return (
                    <label key={entry.path} className={`flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-hover)] ${alreadyAdded || selectionFull ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={alreadyAdded || selected.has(entry.path)} disabled={alreadyAdded || selectionFull} onChange={() => toggleFile(entry)} className="h-4 w-4 shrink-0" />
                      <FileTypeIcon filePath={entry.name} size={17} className="shrink-0 text-[var(--color-text-secondary)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm leading-5 text-[var(--color-text)]" title={entry.name}>{entry.name}</span>
                        {typeof entry.modifiedAt === 'number' && Number.isFinite(entry.modifiedAt) && (
                          <span className="mt-0.5 block text-[11px] leading-4 text-[var(--color-text-tertiary)]">修改于 {formatFileBrowserModifiedTime(entry.modifiedAt)}</span>
                        )}
                      </span>
                      {alreadyAdded && <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">已添加</span>}
                      <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{formatFileSize(entry.size || 0)}</span>
                    </label>
                  );
                })}</div>}
      </div>

    </FilePickerShell>
  );
}

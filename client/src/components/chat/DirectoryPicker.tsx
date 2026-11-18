import Tooltip from '../ui/Tooltip';
import FailureNotice from '../ui/FailureNotice';
import { useState, useEffect, useCallback, type FormEvent, type KeyboardEvent } from 'react';
import { browseDirectory, createDirectory, type DirectoryEntry } from '../../api/filesystem';
import FileBrowserSearch, { FileBrowserSearchButton } from './FileBrowserSearch';
import FilePickerShell from './FilePickerShell';
import { filterFileBrowserEntries, formatFileBrowserModifiedTime } from './file-browser-utils';
import { getHostParentPath } from './host-file-path';

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

export default function DirectoryPicker({ initialPath, onSelect, onCancel }: Props) {
  const [currentPath, setCurrentPath] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isCreatingDirectory, setIsCreatingDirectory] = useState(false);
  const [directoryName, setDirectoryName] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const browse = useCallback((targetPath: string) => {
    const requestedPath = targetPath || '';
    setLoading(true);
    setError('');
    setIsCreatingDirectory(false);
    setDirectoryName('');
    setCreateError('');
    setSearchQuery('');
    setSearchOpen(false);
    browseDirectory(targetPath || undefined)
      .then((data) => {
        setCurrentPath(data.current);
        setParent(data.parent);
        setEntries(data.entries);
      })
      .catch((browseError: unknown) => {
        setCurrentPath(requestedPath);
        setParent(requestedPath ? getHostParentPath(requestedPath) : null);
        setEntries([]);
        setError(browseError instanceof Error ? browseError.message : '无法访问此目录');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    browse(initialPath || '');
  }, [browse, initialPath]);

  const enterDir = (targetPath: string) => {
    browse(targetPath);
  };

  const goUp = () => {
    if (parent !== null) {
      browse(parent);
    }
  };

  // 底部确认选择的是当前浏览目录
  const confirmSelection = () => {
    if (currentPath) {
      onSelect(currentPath);
    }
  };

  const canGoUp = parent !== null;
  const visibleEntries = filterFileBrowserEntries(entries, searchQuery);

  const closeSearch = () => {
    setSearchQuery('');
    setSearchOpen(false);
  };

  const toggleSearch = () => {
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  };

  const cancelCreateDirectory = () => {
    if (creating) return;
    setIsCreatingDirectory(false);
    setDirectoryName('');
    setCreateError('');
  };

  const handleCreateDirectory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = directoryName.trim();
    if (!name) {
      setCreateError('请输入文件夹名称');
      return;
    }

    setCreating(true);
    setCreateError('');
    try {
      const result = await createDirectory(currentPath, name);
      setIsCreatingDirectory(false);
      setDirectoryName('');
      browse(result.path);
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : '创建文件夹失败');
    } finally {
      setCreating(false);
    }
  };

  const handleCreateDirectoryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelCreateDirectory();
    }
  };

  return (
    <FilePickerShell
      labelledBy="directory-picker-title"
      title="选择项目工作目录"
      subtitle={currentPath || '选择盘符'}
      onClose={onCancel}
      onBack={goUp}
      backDisabled={!canGoUp || loading}
      widthClassName="w-[560px]"
      headerActions={
        <>
          <Tooltip content="新建文件夹" asChild><button
            type="button"
            onClick={() => {
              setIsCreatingDirectory(true);
              setCreateError('');
            }}
            disabled={!currentPath || Boolean(error) || loading || creating}
            aria-label="新建文件夹"
            className="inline-flex size-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M8 7.5v3M6.5 9h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button></Tooltip>
          <FileBrowserSearchButton open={searchOpen} onToggle={toggleSearch} disabled={loading} />
        </>
      }
      footer={<><Tooltip overflowOnly content={currentPath || undefined} asChild><span className="min-w-0 truncate text-xs text-[var(--color-text-tertiary)]">{currentPath ? `将选择：${currentPath}` : '单击进入目录'}</span></Tooltip><div className="flex shrink-0 items-center gap-2"><button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">取消</button><button onClick={confirmSelection} disabled={!currentPath || Boolean(error) || loading || creating} className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-sm text-[var(--theme-on-primary)] disabled:cursor-not-allowed disabled:opacity-40">选择当前目录</button></div></>}
    >
        {isCreatingDirectory && (
          <form onSubmit={handleCreateDirectory} className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
            <label htmlFor="new-directory-name" className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
              在当前路径中新建文件夹
            </label>
            <div className="flex items-center gap-2">
              <input
                id="new-directory-name"
                autoFocus
                value={directoryName}
                onChange={(event) => {
                  setDirectoryName(event.target.value);
                  if (createError) setCreateError('');
                }}
                onKeyDown={handleCreateDirectoryKeyDown}
                enterKeyHint="done"
                disabled={creating}
                maxLength={255}
                aria-invalid={Boolean(createError)}
                aria-describedby={createError ? 'new-directory-error' : undefined}
                placeholder="文件夹名称"
                className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-focus-ring)] focus:ring-2 focus:ring-[var(--color-focus-ring)]/20 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={cancelCreateDirectory}
                disabled={creating}
                className="rounded-lg px-3 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={creating || !directoryName.trim()}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-sm text-[var(--theme-on-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
            {createError && (
              <div id="new-directory-error" role="alert" className="mt-1.5 text-xs text-[var(--color-danger-text)]">
                <FailureNotice error={createError} />
              </div>
            )}
          </form>
        )}

        {searchOpen && (
          <FileBrowserSearch value={searchQuery} onChange={setSearchQuery} onClose={closeSearch} disabled={loading} />
        )}

        {/* 目录列表 */}
        <div className="flex-1 overflow-y-auto min-h-[200px]">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-tertiary)]">
              加载中...
            </div>
          ) : error ? (
            <div className="px-5 py-10 text-center">
              <p role="alert" className="text-sm text-[var(--color-danger-text)]"><FailureNotice error={error} /></p>
              <button type="button" onClick={() => browse(currentPath)} className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm">重试</button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-tertiary)]">
              没有子目录
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-tertiary)]">
              当前目录没有匹配项
            </div>
          ) : (
            <div className="py-1">
              {visibleEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => enterDir(entry.path)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm cursor-pointer transition-colors text-left
                    text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]`}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text-tertiary)]">
                    <path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{entry.name}</span>
                    {typeof entry.modifiedAt === 'number' && Number.isFinite(entry.modifiedAt) && (
                      <span className="mt-0.5 block text-[11px] leading-4 text-[var(--color-text-tertiary)]">修改于 {formatFileBrowserModifiedTime(entry.modifiedAt)}</span>
                    )}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]">›</span>
                </button>
              ))}
            </div>
          )}
        </div>

    </FilePickerShell>
  );
}

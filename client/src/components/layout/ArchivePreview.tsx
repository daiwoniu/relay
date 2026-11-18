import { useEffect, useMemo, useState } from 'react';
import type { ArchivePreviewDto } from '../../generated/relay-contracts';
import FileTypeIcon from '../messages/FileTypeIcon';
import { formControlClassName } from '../ui/FormControls';
import { formatFileMetadataSize, formatFileMetadataTime } from './file-preview-metadata';
import { formatArchiveRatio, getArchiveRows } from './archive-directory';

const PAGE_SIZE = 100;
export default function ArchivePreview({ archive }: { archive: ArchivePreviewDto }) {
  const [directory, setDirectory] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => { setDirectory(''); setQuery(''); setLimit(PAGE_SIZE); }, [archive]);
  const rows = useMemo(() => getArchiveRows(archive.entries, directory, query), [archive.entries, directory, query]);
  const searching = Boolean(query.trim());
  const navigate = (path: string) => { setDirectory(path); setQuery(''); setLimit(PAGE_SIZE); };
  const parts = directory ? directory.split('/') : [];
  return <section className="archive-preview" aria-label="ZIP 压缩包目录">
    <header className="archive-preview-summary">
      <strong>ZIP · {archive.totalFiles.toLocaleString()} 个文件</strong>
      <span>原始内容 {formatFileMetadataSize(archive.totalSize)} · 压缩后 {formatFileMetadataSize(archive.totalCompressedSize)} · 节省 {formatArchiveRatio(archive.totalSize, archive.totalCompressedSize)}</span>
      <span>仅查看目录和文件信息</span>
    </header>
    {archive.truncated && <p className="workspace-preview-notice is-warning" role="status">目录共 {archive.totalEntries.toLocaleString()} 条，已加载前 {archive.entries.length.toLocaleString()} 条；浏览和搜索仅覆盖已加载条目，请下载查看完整目录。</p>}
    <label className="archive-preview-search"><span className="sr-only">搜索压缩包目录</span><input type="search" className={formControlClassName} value={query} placeholder="搜索文件名或路径" onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} /></label>
    <nav className="archive-preview-breadcrumbs" aria-label="压缩包内路径">
      <button type="button" onClick={() => navigate('')} aria-current={!directory && !searching ? 'page' : undefined}>根目录</button>
      {!searching && parts.map((part, index) => <span key={index}> / <button type="button" aria-current={index === parts.length - 1 ? 'page' : undefined} onClick={() => navigate(parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}
      {searching && <span> / 搜索结果（{rows.length}）</span>}
    </nav>
    {!searching && directory && <button type="button" className="archive-preview-back" onClick={() => navigate(parts.slice(0, -1).join('/'))}>← 返回上一级</button>}
    {!rows.length ? <p className="archive-preview-empty">{searching ? '没有匹配的文件或目录' : archive.totalEntries === 0 ? '这是一个空压缩包' : '当前目录没有已加载条目'}</p> : <ul className="archive-preview-list" aria-label={searching ? '压缩包搜索结果' : '当前目录条目'}>
      {rows.slice(0, limit).map(row => <li key={`${row.directory ? 'd' : 'f'}:${row.path}`}>
        <div className="archive-preview-entry">
          {row.directory ? <button type="button" className="archive-preview-name" onClick={() => navigate(row.path)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3Z" /></svg><span>{row.name}</span><span aria-hidden="true">›</span></button> : <div className="archive-preview-name"><FileTypeIcon filePath={row.path} size={16} /><span>{row.name}</span></div>}
          <span className="archive-preview-size">{row.directory ? '文件夹' : formatFileMetadataSize(row.size ?? NaN)}</span>
        </div>
        <div className="archive-preview-details">{!row.directory && <span>压缩后 {formatFileMetadataSize(row.compressedSize ?? NaN)}</span>}{row.modifiedAt !== null && <time dateTime={new Date(row.modifiedAt).toISOString()}>{formatFileMetadataTime(row.modifiedAt)}</time>}</div>
      </li>)}
    </ul>}
    {rows.length > limit && <button type="button" className="archive-preview-more" onClick={() => setLimit(value => value + PAGE_SIZE)}>显示更多（已显示 {limit} / {rows.length}）</button>}
  </section>;
}

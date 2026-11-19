import { memo, useEffect, useRef, useState } from 'react';
import { readFileMetadata, readImagePreviewSource } from '../../api/filesystem';
import { compressImageForPreview } from '../../utils/image-preview';
import FileTypeIcon from './FileTypeIcon';
import { getFileIconType } from './file-icon-type';
import { useFilePreview } from './useFilePreview';
import { areProcessFilesEqual, type ProcessFileResource } from './process-file-resources';

import {featureAction} from '../../analytics/features';
const PAGE_SIZE = 6;
const THUMBNAIL_SOURCE_LIMIT = 4 * 1024 * 1024;

export default memo(function ProcessFileList({ files }: { files: ProcessFileResource[] }) {
  const openFile = useFilePreview();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const container = useRef<HTMLDivElement>(null);
  const attempted = useRef(new Set<string>());
  useEffect(() => { attempted.current.clear(); setThumbnails({}); setLimit(PAGE_SIZE); }, [files]);
  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    const load = async () => {
      if (started) return;
      started = true;
      for (const file of files.slice(0, limit)) {
        if (controller.signal.aborted) return;
        if (file.deleted || !file.thumbnailAllowed || attempted.current.has(file.path) || getFileIconType(file.name) !== 'image') continue;
        try {
          const metadata = await readFileMetadata(file.path, undefined, { signal: controller.signal });
          controller.signal.throwIfAborted();
          if (metadata.size > THUMBNAIL_SOURCE_LIMIT) continue;
          const blob = await readImagePreviewSource(file.path, undefined, { signal: controller.signal });
          controller.signal.throwIfAborted();
          if (blob.size > THUMBNAIL_SOURCE_LIMIT) continue;
          const url = await compressImageForPreview(blob, controller.signal, { maxDimension: 192, qualityPercent: 75 });
          controller.signal.throwIfAborted();
          setThumbnails(previous => ({ ...previous, [file.path]: url }));
        } catch { if (controller.signal.aborted) return; }
        finally { if (!controller.signal.aborted) attempted.current.add(file.path); }
      }
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); }
    });
    if (observer && container.current) observer.observe(container.current);
    else void load();
    return () => { controller.abort(); observer?.disconnect(); };
  }, [files, limit]);
  return <div ref={container} className="process-file-list" aria-label="本步骤相关文件">
    <p className="process-file-list__notice">预览文件当前内容</p>
    {files.slice(0, limit).map(file => <button key={file.path} type="button" className="process-file-list__row" disabled={file.deleted}
      aria-label={`${file.deleted ? '已删除' : '预览'}：${file.name}，${file.directory}`} title={file.path}
      onClick={event => { event.stopPropagation(); void openFile(file.path); }}>
      <span className="process-file-list__thumbnail" aria-hidden="true">{thumbnails[file.path] && !file.deleted
        ? <img src={thumbnails[file.path]} alt="" onError={() => setThumbnails(previous => { const next = { ...previous }; delete next[file.path]; return next; })} />
        : <FileTypeIcon filePath={file.name} size={22} />}</span>
      <span className="process-file-list__identity"><span className="process-file-list__name">{file.name}</span><span className="process-file-list__directory">{file.directory}</span></span>
      <span className="process-file-list__action">{file.deleted ? '已删除' : file.action}</span>
    </button>)}
    {files.length > limit && <button type="button" className="flow-more" onClick={() => {featureAction('message','expand_files','message_file');setLimit(value => value + PAGE_SIZE);}}>再显示 {Math.min(PAGE_SIZE, files.length - limit)} 个文件（剩余 {files.length - limit} 个）</button>}
  </div>;
}, (previous, next) => areProcessFilesEqual(previous.files, next.files));

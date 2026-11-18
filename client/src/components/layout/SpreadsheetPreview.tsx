import Tooltip from '../ui/Tooltip';
import { useEffect, useMemo, useState } from 'react';
import type { SpreadsheetDocumentPreviewDto, SpreadsheetSheetPreviewDto } from '../../generated/relay-contracts';
import { readSpreadsheetSheet } from '../../api/filesystem';
import PreviewState from './PreviewState';

function columnLabel(column: number): string {
  let value = column;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
export default function SpreadsheetPreview({
  document,
  sourcePath,
  accessToken,
  requestSignal,
}: {
  document: SpreadsheetDocumentPreviewDto;
  sourcePath: string;
  accessToken?: string;
  requestSignal?: AbortSignal;
}) {
  const [selectedName, setSelectedName] = useState(document.activeSheet.name);
  const [sheet, setSheet] = useState(document.activeSheet);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    setSelectedName(name => document.sheets.some(sheet => sheet.name === name) ? name : document.activeSheet.name);
    setSheet(document.activeSheet);
    setError(null);
  }, [document]);

  useEffect(() => {
    if (selectedName === document.activeSheet.name) {
      setSheet(document.activeSheet);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(requestSignal?.reason);
    if (requestSignal?.aborted) abortFromParent();
    else requestSignal?.addEventListener('abort', abortFromParent, { once: true });
    setLoading(true);
    setError(null);
    void readSpreadsheetSheet(sourcePath, selectedName, accessToken, { signal: controller.signal }).then(
      (response) => { if (!controller.signal.aborted) setSheet(response.sheet); },
      (reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '工作表加载失败'); },
    ).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => {
      requestSignal?.removeEventListener('abort', abortFromParent);
      controller.abort();
    };
  }, [accessToken, document.activeSheet, requestSignal, retryVersion, selectedName, sourcePath]);

  const headers = useMemo(
    () => Array.from({ length: sheet.displayedColumns }, (_, index) => columnLabel(index + 1)),
    [sheet.displayedColumns],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="spreadsheet-tabs" role="tablist" aria-label="工作表">
        {document.sheets.map((item) => (
          <button
            key={item.name}
            type="button"
            role="tab"
            aria-selected={selectedName === item.name}
            className={selectedName === item.name ? 'is-active' : ''}
            onClick={() => setSelectedName(item.name)}
          >
            {item.name}{item.state !== 'visible' ? '（隐藏）' : ''}
          </button>
        ))}
      </div>
      <div className={`document-preview-notice${sheet.rowsTruncated || sheet.columnsTruncated ? ' is-limited' : ''}`}>
        <span>
          共 <strong>{sheet.totalRows} 行、{sheet.totalColumns} 列</strong>；<strong>展示 {sheet.displayedRows} 行、{sheet.displayedColumns} 列</strong>
          {(sheet.rowsTruncated || sheet.columnsTruncated) ? '，建议下载后查看完整内容' : ''}
          {sheet.merges.length > 0 ? `；${sheet.merges.length} 个合并区域` : ''}
        </span>
      </div>
      {loading ? (
        <PreviewState tone="loading" title="正在加载工作表" />
      ) : error ? (
        <PreviewState tone="danger" title="工作表加载失败" description={error} action={<button className="workspace-preview-state__button" type="button" onClick={() => setRetryVersion((value) => value + 1)}>重试</button>} />
      ) : (
        <div className="spreadsheet-table-wrap">
          <table className="spreadsheet-table">
            <thead><tr><th aria-label="行号" />{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.rowNumber}>
                  <th>{row.rowNumber}</th>
                  {row.cells.map((cell) => (
                    <Tooltip key={cell.address} content={cell.formula ? `公式：${cell.formula}` : undefined} asChild><td>
                      {cell.display}{cell.formula ? <span className="spreadsheet-formula-mark" aria-label="包含公式">ƒ</span> : null}
                    </td></Tooltip>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

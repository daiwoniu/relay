import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const panel = [
  fs.readFileSync(new URL('RightPanel.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('RightPanelContent.tsx', import.meta.url), 'utf8'),
].join('\n');
const previewHook = fs.readFileSync(new URL('../messages/useFilePreview.ts', import.meta.url), 'utf8');
const filesystemApi = fs.readFileSync(new URL('../../api/filesystem.ts', import.meta.url), 'utf8');
const previewState = fs.readFileSync(new URL('file-preview-state.ts', import.meta.url), 'utf8');
const pdfPreview = fs.readFileSync(new URL('PdfDocumentPreview.tsx', import.meta.url), 'utf8');
const wordPreview = fs.readFileSync(new URL('WordDocumentPreview.tsx', import.meta.url), 'utf8');
const spreadsheetPreview = fs.readFileSync(new URL('SpreadsheetPreview.tsx', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');
const requestManager = fs.readFileSync(new URL('file-preview-request-manager.ts', import.meta.url), 'utf8');
const metadata = fs.readFileSync(new URL('file-preview-metadata.ts', import.meta.url), 'utf8');
const iconActionButton = fs.readFileSync(new URL('../ui/IconActionButton.tsx', import.meta.url), 'utf8');

test('路径栏支持选择和独立复制且不再使用文件路径悬浮卡', () => {
  assert.match(panel, /readOnly[\s\S]*value=\{activeTab\.title\}/);
  assert.match(panel, /onFocus=\{\(event\) => event\.currentTarget\.select\(\)\}/);
  assert.match(panel, /复制文件路径/);
  assert.match(panel, /onCopyPath=\{\(filePath\) => void handleCopyPath\(filePath\)\}/);
  assert.match(panel, /onCopyPath\(activeTab\.title\)/);
  assert.doesNotMatch(panel, /title="文件路径"/);
});

test('文件信息仅使用简短悬停提示并通过点击弹窗查看详情', () => {
  assert.match(panel, /label="文件信息"/);
  assert.doesNotMatch(panel, /title="文件信息"/);
  assert.match(panel, /disabled=\{isMobile\}/);
  assert.match(panel, /setMobileInfo\('file-info'\)/);
  assert.match(panel, /<FileMetadataContent[\s\S]*metadata=\{activeTab\.fileMetadata\}/);
  assert.match(panel, /mobileInfo === 'file-info'/);
  assert.match(panel, /containerClassName=\{isMobile \? '!items-end !p-0'/);
  assert.match(panel, /label="文件信息"[^\n]*tooltip=\{!isMobile\}/);
  assert.match(iconActionButton, /overlayIgnore = true/);
  assert.match(iconActionButton, /data-overlay-ignore=\{overlayIgnore \? true : undefined\}/);
  assert.match(metadata, /formatFileMetadataSize/);
  assert.match(metadata, /formatFileMetadataTime/);
  assert.match(metadata, /getFileMetadataTypeLabel/);
});

test('文件正文与元数据独立加载且临时授权后会重新读取信息', () => {
  assert.match(filesystemApi, /readFileMetadata/);
  assert.match(filesystemApi, /\/api\/filesystem\/metadata/);
  assert.match(previewHook, /buildFileMetadataUpdate/);
  assert.match(panel, /buildFileMetadataUpdate\(sourcePath, authorization\.accessToken, request\.signal\)/);
  assert.match(store, /fileMetadata\?: FileMetadataResult/);
  assert.match(filesystemApi, /path: string;[\s\S]*size: number;/);
  assert.match(panel, /metadata\.path/);
});

test('移动端文件信息与临时授权说明使用不同图标', () => {
  assert.match(panel, /data-icon="file-metadata-info"/);
  assert.match(panel, /data-icon="file-access-info"/);
});

test('预览标签使用实际文件类型图标', () => {
  assert.match(panel, /<FileTypeIcon filePath=\{tab\.sourcePath \|\| tab\.title\} size=\{12\}/);
});

test('文本预览显示不可选中的独立行号栏且不改变高亮内容', () => {
  assert.match(panel, /buildPreviewLineNumbers\(activeTab\.content\)/);
  assert.match(panel, /buildCodePreviewMarkdown\(activeTab\.content, activeTab\.language\)/);
  assert.match(panel, /className=\{`right-panel-code-frame/);
  assert.match(panel, /className="right-panel-line-numbers"/);
  assert.match(panel, /aria-hidden="true"/);
  assert.match(panel, /\{lineNumbers\}/);
  assert.match(panel, /rehypePlugins=\{\[rehypeHighlight\]\}/);
  assert.match(panel, /行数超过 \{MAX_PREVIEW_LINE_NUMBERS\.toLocaleString\(\)\}，已隐藏行号/);
});

test('大代码文件跳过同步高亮和行号并使用可取消的分帧纯文本预览', () => {
  assert.match(store, /contentSize\?: number/);
  assert.match(previewState, /contentSize: data\.size/);
  assert.match(previewState, /contentSize: undefined/);
  assert.match(panel, /isLargeCodePreview\(activeTab\.contentSize\)/);
  assert.match(panel, /largeCodePreview \? '' : activeTab\?\.language \? buildCodePreviewMarkdown/);
  assert.match(panel, /largeCodePreview \? \[\] : activeTab\?\.language \? buildPreviewLineNumbers/);
  assert.match(panel, /<ProgressiveCodePreview key=\{activeTab\.id\} content=\{activeTab\.content\}/);
  assert.match(panel, /大文件已关闭语法高亮和行号/);
  assert.match(panel, /getFilePreviewView\(activeTab\) === 'preview'/);
  assert.match(panel, /activeTab=\{isOpen \? activeTab : undefined\}/);
  const progressivePreview = fs.readFileSync(new URL('ProgressiveCodePreview.tsx', import.meta.url), 'utf8');
  assert.match(progressivePreview, /return startProgressiveTextPreview/);
});

test('临时授权后预览失败保留下载令牌而不是重复显示强制访问', () => {
  assert.match(panel, /let authorizedAccessToken: string \| undefined/);
  assert.match(panel, /authorizedAccessToken = authorization\.accessToken/);
  assert.match(panel, /buildForceAccessFailureUpdate\(err, authorizedAccessToken\)/);
});

test('较大图片显示压缩预览入口并按需读取图片源', () => {
  assert.match(previewState, /data\.type === 'image-preview-required'/);
  assert.match(panel, /activeTab\.compressedPreviewAvailable/);
  assert.match(panel, /压缩后预览/);
  assert.match(panel, /readImagePreviewSource\(tab\.sourcePath \|\| tab\.title, tab\.fileAccessToken, \{ signal: request\.signal \}\)/);
  assert.match(filesystemApi, /\/api\/filesystem\/preview-image-source/);
});

test('PDF、Word 与 Excel 使用独立懒加载预览组件', () => {
  assert.match(panel, /lazy\(\(\) => import\('\.\/PdfDocumentPreview'\)\)/);
  assert.match(panel, /lazy\(\(\) => import\('\.\/WordDocumentPreview'\)\)/);
  assert.match(panel, /lazy\(\(\) => import\('\.\/SpreadsheetPreview'\)\)/);
  assert.match(previewHook, /buildFilePreviewUpdate/);
  assert.match(previewState, /data\.type === 'pdf-document'/);
  assert.match(previewState, /data\.type === 'word-document' \|\| data\.type === 'spreadsheet'/);
});

test('重新打开既有文件标签时清空旧预览模式，失败后只显示错误', () => {
  assert.match(previewState, /EMPTY_FILE_PREVIEW_MODES[\s\S]*isImage: false[\s\S]*imageUrl: undefined[\s\S]*language: undefined[\s\S]*documentPreview: undefined[\s\S]*compressedPreviewAvailable: false/);
  assert.match(previewHook, /openRightPanel\([\s\S]*\.\.\.EMPTY_FILE_PREVIEW_MODES/);
  const resets = previewHook.match(/\.\.\.EMPTY_FILE_PREVIEW_MODES/g) ?? [];
  assert.equal(resets.length, 3);
});

test('PDF Blob 生命周期受标签状态管理并保留下载回退', () => {
  assert.match(previewState, /URL\.createObjectURL\(blob\)/);
  assert.match(store, /disposeFilePreviewTab\(closing\)/);
  assert.match(store, /for \(const tab of get\(\)\.rightPanelTabs\) disposeFilePreviewTab\(tab\)/);
  assert.match(requestManager, /releaseObjectUrl/);
  assert.match(pdfPreview, /仅展示前/);
  assert.match(pdfPreview, /建议下载后查看完整内容/);
  assert.match(pdfPreview, /新标签打开预览/);
  assert.equal(pdfPreview.match(/下载原文件/g)?.length, 1);
});

test('Word 显示页或内容块截断提示并仅接收服务端安全 HTML', () => {
  assert.match(wordPreview, /document\.countUnit === 'pages'/);
  assert.match(wordPreview, /建议下载后查看完整内容/);
  assert.doesNotMatch(wordPreview, /下载原文件/);
  assert.match(wordPreview, /dangerouslySetInnerHTML=\{\{ __html: document\.html \}\}/);
  assert.match(wordPreview, /图片因安全限制未加载/);
  assert.doesNotMatch(wordPreview, /sanitize|DOMParser/);
});

test('Excel 支持工作表切换、横向表格和失败重试', () => {
  assert.match(spreadsheetPreview, /readSpreadsheetSheet\(sourcePath, selectedName, accessToken, \{ signal: controller\.signal \}\)/);
  assert.match(spreadsheetPreview, /role="tablist"/);
  assert.match(spreadsheetPreview, /setRetryVersion/);
  assert.match(spreadsheetPreview, /sheet\.rowsTruncated \|\| sheet\.columnsTruncated/);
  assert.match(spreadsheetPreview, /建议下载后查看完整内容/);
  assert.doesNotMatch(spreadsheetPreview, /下载原文件/);
  assert.match(filesystemApi, /\/api\/filesystem\/preview-spreadsheet-sheet/);
});

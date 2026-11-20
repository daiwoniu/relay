import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getHostParentPath } from './host-file-path.ts';

const inputSource = [
  './ChatInput.tsx',
  './composer-status-notice.ts',
  './ChatInputAddContentControl.tsx',
  './ChatInputSubmitControl.tsx',
  './ChatInputDialogs.tsx',
].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const pickerSource = fs.readFileSync(new URL('./HostFilePicker.tsx', import.meta.url), 'utf8');
const directoryPickerSource = fs.readFileSync(new URL('./DirectoryPicker.tsx', import.meta.url), 'utf8');
const browserSearchSource = fs.readFileSync(new URL('./FileBrowserSearch.tsx', import.meta.url), 'utf8');
const viewSource = fs.readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
const sendPresentationSource = fs.readFileSync(new URL('./send-message-presentation.ts', import.meta.url), 'utf8');
const websocketSource = fs.readFileSync(new URL('../../hooks/useRelayWebSocket.ts', import.meta.url), 'utf8');
const userMessageSource = fs.readFileSync(new URL('../messages/UserMessage.tsx', import.meta.url), 'utf8');
const publicShareSource = fs.readFileSync(new URL('../sharing/PublicShareMessageList.tsx', import.meta.url), 'utf8');

test('加号综合菜单开放主机文件、设备文件、图片和移动端拍照入口', () => {
  assert.match(inputSource, /label="添加内容"/);
  assert.match(inputSource, /选择电脑文件/);
  assert.match(inputSource, /上传设备文件/);
  assert.match(inputSource, /上传图片/);
  assert.match(inputSource, /isMobile \? '选择图片' : '上传图片'/);
  assert.match(inputSource, /拍照/);
  assert.match(inputSource, /capture="environment"/);
  assert.doesNotMatch(inputSource, /语音输入/);
  assert.match(inputSource, /mobile=\{isMobile\}/);
});

test('电脑文件与设备文件使用不同且无下载歧义的图标', () => {
  assert.match(inputSource, /data-icon="computer-file"/);
  assert.match(inputSource, /data-icon="file-add"/);
  assert.doesNotMatch(inputSource, /M8 2v8M5 7l3 3 3-3M3 12\.5h10/);
});

test('添加内容菜单图标统一使用十八像素线性规格', () => {
  for (const icon of ['computer-file', 'file-add', 'image', 'camera']) {
    assert.match(inputSource, new RegExp(`width="18" height="18"[^>]+data-icon="${icon}"`));
  }
  assert.match(inputSource, /data-icon="computer-file"[\s\S]*strokeWidth="1\.3"/);
});

test('文件选择器支持目录导航、多选、错误反馈和消息剩余额度', () => {
  assert.match(pickerSource, /browseHostFiles/);
  assert.match(pickerSource, /type="checkbox"/);
  assert.match(pickerSource, /remainingSlots/);
  assert.match(pickerSource, /selected\.size >= selectableLimit/);
  assert.match(pickerSource, /existingHostFilePaths/);
  assert.match(pickerSource, /alreadyAdded/);
  assert.match(pickerSource, /无法访问此目录/);
  assert.match(pickerSource, /已选择 \{selected\.size\} 个，还可选择/);
  assert.match(inputSource, /remainingHostFileSlots=\{Math\.max\(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments\.length\)\}/);
  assert.match(inputSource, /existingHostFilePaths=\{attachments\.filter/);
});

test('文件选择器在目录切换时保持稳定高度', () => {
  const shellSource = fs.readFileSync(new URL('./FilePickerShell.tsx', import.meta.url), 'utf8');
  assert.match(shellSource, /h-\[80vh\] max-h-\[560px\]/);
  assert.match(pickerSource, /min-h-\[260px\] flex-1 overflow-y-auto/);
});

test('文件选择器成功进入目录后按当前会话记忆，下次优先从该目录打开', () => {
  assert.match(pickerSource, /onDirectoryChange\?\.\(result\.current\)/);
  assert.match(inputSource, /readHostFileDirectory\(sessionStorage, hostFileDirectoryKey\)/);
  assert.match(inputSource, /initialHostFilePath=\{rememberedHostFilePath \|\| currentProject\?\.path\}/);
  assert.match(inputSource, /initialPath=\{initialHostFilePath\}/);
});

test('文件选择器复用类型图标并用整行标签选择文件', () => {
  assert.match(pickerSource, /<FileTypeIcon filePath=\{entry\.name\} size=\{17\}/);
  assert.match(pickerSource, /typeof entry\.modifiedAt === 'number' && Number\.isFinite\(entry\.modifiedAt\)/);
  assert.match(pickerSource, /修改于 \{formatFileBrowserModifiedTime\(entry\.modifiedAt\)\}/);
  assert.match(pickerSource, /<label key=\{entry\.path\}/);
  assert.match(pickerSource, /content=\{entry\.name\} asChild><span[^>]*>\{entry\.name\}<\/span>/);
  assert.doesNotMatch(pickerSource, /type="text"/);
});

test('项目目录选择器单击进入并确认当前目录，支持初始目录和错误重试', () => {
  assert.match(directoryPickerSource, /initialPath/);
  assert.match(directoryPickerSource, /browse\(initialPath \|\| ''\)/);
  assert.match(directoryPickerSource, /type="button"[\s\S]*onClick=\{\(\) => enterDir\(entry\.path\)\}/);
  assert.doesNotMatch(directoryPickerSource, /onDoubleClick/);
  assert.doesNotMatch(directoryPickerSource, /selectedPath/);
  assert.match(directoryPickerSource, /无法访问此目录/);
  assert.match(directoryPickerSource, /role="alert"/);
  assert.match(directoryPickerSource, /选择当前目录/);
  assert.match(inputSource, /initialDirectoryPath=\{pendingProjectPath \|\| undefined\}/);
});

test('两个文件浏览窗口复用当前层级搜索并显示目录修改时间', () => {
  for (const source of [pickerSource, directoryPickerSource]) {
    assert.match(source, /<FileBrowserSearchButton open=\{searchOpen\}/);
    assert.match(source, /searchOpen && \(\s*<FileBrowserSearch value=\{searchQuery\}/);
    assert.match(source, /setSearchOpen\(false\)/);
    assert.match(source, /filterFileBrowserEntries\(entries, searchQuery\)/);
    assert.match(source, /当前目录没有匹配项/);
    assert.match(source, /修改于 \{formatFileBrowserModifiedTime\(entry\.modifiedAt\)\}/);
  }
  assert.match(browserSearchSource, /aria-label="搜索当前目录"/);
  assert.match(browserSearchSource, /aria-expanded=\{open\}/);
  assert.match(browserSearchSource, /autoFocus/);
  assert.match(browserSearchSource, /event\.stopPropagation\(\)/);
  assert.match(browserSearchSource, /enterKeyHint="search"/);
  assert.match(browserSearchSource, /appearance-none/);
  assert.match(browserSearchSource, /aria-label="清除搜索"/);
});

test('不可访问目录仍能计算 Windows 与 Unix 上一级路径', () => {
  assert.equal(getHostParentPath('C:\\Users\\blocked'), 'C:\\Users');
  assert.equal(getHostParentPath('C:\\'), '');
  assert.equal(getHostParentPath('/var/blocked'), '/var');
  assert.equal(getHostParentPath('/'), '');
});

test('附件授权后同时进入乐观消息与 WebSocket send 命令', () => {
  assert.match(inputSource, /authorizeHostFiles/);
  assert.match(viewSource, /buildOptimisticUserMessage\(\{ sessionId: targetSessionId, messageId, content, attachments, replyToAsyncQuestionId \}\)/);
  assert.match(sendPresentationSource, /attachments: MessageAttachmentDto\[\] = input\.attachments\.map/);
  assert.match(viewSource, /send\(targetSessionId, content, messageId, attachments, onConfirmationState, selectedEngine, enginePreferences, workspaceTaskId, replyToAsyncQuestionId, workspaceId\)/);
  assert.match(websocketSource, /payload\.attachments = attachments/);
});

test('附件草稿等待服务端落库确认，拒绝时回滚乐观消息', () => {
  assert.match(websocketSource, /pendingSendManagerRef\.current\.wait\(confirmedMessageId, \{/);
  assert.match(websocketSource, /pendingSendManagerRef\.current\.confirm\(msg\.message\.id\)/);
  assert.match(websocketSource, /pendingSendManagerRef\.current\.reject\(msg\.messageId/);
  assert.match(viewSource, /await send\(targetSessionId, content, messageId, attachments, onConfirmationState, selectedEngine, enginePreferences, workspaceTaskId, replyToAsyncQuestionId, workspaceId\)/);
  assert.match(viewSource, /removeMessage\(targetSessionId, messageId\)/);
  assert.match(inputSource, /const accepted = await onSend\(content, sendAttachments, messageId,/);
  assert.match(inputSource, /if \(!accepted\) return/);
});

test('设备上传提供进度、取消、失败重试并阻止未就绪附件发送', () => {
  assert.match(inputSource, /uploadProjectFile/);
  assert.match(inputSource, /onProgress/);
  assert.match(inputSource, /cancelUpload/);
  assert.match(inputSource, /retryUpload/);
  assert.match(inputSource, /hasUnreadyAttachments/);
  assert.match(inputSource, /attachmentDraftKeyRef\.current !== targetDraftKey/);
  assert.match(inputSource, /updateAttachmentsForKey\(targetDraftKey/);
  assert.match(inputSource, /messageId: draft\.messageId/);
  assert.match(inputSource, /messageDraftIdRef\.current \|\| generateUUID\(\)/);
});

test('桌面输入框支持粘贴文件、截图和拖拽文件上传', () => {
  assert.match(inputSource, /onPaste=\{handlePasteFiles\}/);
  assert.match(inputSource, /extractTransferredFiles\(event\.clipboardData\)/);
  assert.match(inputSource, /if \(isMobile \|\| isSubmitting\) return/);
  assert.match(inputSource, /onDragEnter=\{handleFileDragEnter\}/);
  assert.match(inputSource, /onDragOver=\{handleFileDragOver\}/);
  assert.match(inputSource, /onDragLeave=\{handleFileDragLeave\}/);
  assert.match(inputSource, /onDrop=\{handleFileDrop\}/);
  assert.match(inputSource, /松开即可添加文件/);
  assert.match(inputSource, /queueUploadFiles\(files\)/);
});

test('附件上传批次串行接纳并同步提交最新额度快照', () => {
  assert.match(inputSource, /createAttachmentUploadQueue/);
  assert.match(inputSource, /uploadQueueRef\.current\.enqueue\(\(\) => handleUploadFiles\(files, targetDraftKey\)\)\.catch/);
  assert.match(inputSource, /const currentAttachments = attachmentsRef\.current/);
  assert.match(inputSource, /selectUploadFiles\(currentAttachments, files\)/);
  assert.match(inputSource, /attachmentsRef\.current = nextAttachments/);
});

test('回复处理中允许准备下一条附件，但发送守卫保持生效', () => {
  assert.match(inputSource, /<AttachmentDraftList[\s\S]*disabled=\{isSubmitting \|\| deletingCurrentDraftAttachment\}/);
  assert.match(inputSource, /<ChatInputAddContentControl[\s\S]*disabled=\{isSubmitting\}/);
  assert.match(inputSource, /label="添加内容"[\s\S]*disabled=\{disabled\}[\s\S]*aria-haspopup="dialog"/);
  assert.match(inputSource, /\(!content && attachments\.length === 0\) \|\| isSubmitting/);
});

test('删除已上传附件期间阻止同一草稿发送并绑定原草稿键', () => {
  assert.match(inputSource, /deletingAttachmentDraftKeysRef\.current\.has\(attachmentDraftKey\)/);
  assert.match(inputSource, /const targetDraftKey = attachmentDraftKey/);
  assert.match(inputSource, /removeReadyAttachmentForKey\(targetDraftKey, attachment\)/);
  assert.match(inputSource, /disabled=\{isSubmitting \|\| deletingCurrentDraftAttachment\}/);
});

test('发送阶段只在主机附件授权时提示准备附件', () => {
  assert.match(inputSource, /const submissionDraftKey = attachmentDraftKey/);
  assert.match(inputSource, /beginSubmissionState\([\s\S]*hostAttachments\.length > 0 \? 'preparing-attachments' : 'sending'/);
  assert.match(inputSource, /updateSubmissionState\(current, submissionDraftKey, 'sending'\)[\s\S]*const accepted = await onSend/);
  assert.match(inputSource, /clearSubmissionState\(current, submissionDraftKey\)/);
  assert.match(inputSource, /submissionPhase === 'verifying'[\s\S]*正在核实发送结果，请勿重复发送…[\s\S]*submissionPhase === 'preparing-attachments'[\s\S]*正在准备附件…[\s\S]*submissionPhase === 'sending'[\s\S]*正在发送…/);
  assert.doesNotMatch(inputSource, /setPreparingAttachments/);
});

test('发送确认延迟时显示核实状态并把进度回调传入发送链路', () => {
  assert.match(inputSource, /onConfirmationState[\s\S]*updateSubmissionState\(current, submissionDraftKey, 'verifying'\)/);
  assert.match(inputSource, /正在核实发送结果，请勿重复发送/);
  assert.match(viewSource, /onConfirmationState[\s\S]*send\(targetSessionId, content, messageId, attachments, onConfirmationState, selectedEngine, enginePreferences, workspaceTaskId, replyToAsyncQuestionId, workspaceId\)/);
  assert.match(websocketSource, /onConfirmationState[\s\S]*onVerifying:[\s\S]*onConfirmationState\?\.\('verifying'\)/);
});

test('延迟完成和错误只更新原发送草稿，不污染切换后的会话', () => {
  assert.match(inputSource, /if \(attachmentDraftKeyRef\.current === submissionDraftKey\) \{[\s\S]*setInputState\(''\)[\s\S]*setAttachmentsState\(\[\]\)/);
  assert.match(inputSource, /catch \(error: unknown\) \{\s*if \(attachmentDraftKeyRef\.current === submissionDraftKey\) \{\s*shouldRestoreInputFocus = true;\s*setAttachmentNotice\(\{[\s\S]*tone: 'danger'/);
});

test('历史消息显示附件，公开分享使用只读附件摘要', () => {
  assert.match(userMessageSource, /MessageAttachmentList/);
  assert.match(publicShareSource, /attachments=\{message\.attachments\}/);
  assert.match(publicShareSource, /readOnly/);
});

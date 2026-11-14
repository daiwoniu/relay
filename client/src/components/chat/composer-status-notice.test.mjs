import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getComposerStatusNotice, getComposerStatusNotices, isEngineStatusBlocking, prioritizeComposerStatusNotices } from './composer-status-notice.ts';

const base = {
  attachmentNotice: null,
  isAwaitingAction: false,
  engineStatusNotice: null,
  isQueued: false,
  submissionPhase: 'idle',
  deletingAttachment: false,
  hasUnreadyAttachments: false,
};

test('统一提示只选择最高优先级状态', () => {
  const first = getComposerStatusNotice({
    ...base,
    attachmentNotice: { message: '附件处理失败', tone: 'danger' },
    isAwaitingAction: true,
    engineStatusNotice: { message: '引擎不可用', tone: 'danger' },
    isQueued: true,
  });
  assert.equal(first?.id, 'awaiting-action:请先处理上方操作请求');
  assert.equal(first?.message, '请先处理上方操作请求');
  assert.equal(first?.tone, 'warning');
  assert.equal(getComposerStatusNotice({ ...base, isAwaitingAction: true, engineStatusNotice: { message: '引擎不可用', tone: 'danger' } })?.message, '请先处理上方操作请求');
  assert.equal(getComposerStatusNotice({ ...base, engineStatusNotice: { message: '引擎不可用', tone: 'danger' }, isQueued: true })?.message, '引擎不可用');
});

test('引擎检查与附件提醒保留调用方提供的语义级别', () => {
  assert.equal(getComposerStatusNotice({ ...base, engineStatusNotice: { message: '正在检查可用引擎…', tone: 'processing' } })?.tone, 'processing');
  assert.equal(getComposerStatusNotice({ ...base, attachmentNotice: { message: '已忽略重复选择的文件', tone: 'warning' } })?.tone, 'warning');
  assert.equal(getComposerStatusNotice({ ...base, attachmentNotice: { message: '上传失败', tone: 'danger' } })?.tone, 'danger');
});

test('处理状态按核实、准备、发送顺序生成提示', () => {
  assert.equal(getComposerStatusNotice({ ...base, submissionPhase: 'verifying' })?.message, '正在核实发送结果，请勿重复发送…');
  assert.equal(getComposerStatusNotice({ ...base, submissionPhase: 'preparing-attachments' })?.message, '正在准备附件…');
  assert.equal(getComposerStatusNotice({ ...base, submissionPhase: 'sending' })?.message, '正在发送…');
});

test('无特殊状态时不显示统一提示', () => {
  assert.equal(getComposerStatusNotice(base), null);
});

test('旁观者等待所有人处理，不提示其执行无权限的操作', () => {
  const notice = getComposerStatusNotice({ ...base, isAwaitingAction: true, canRespondToInteraction: false });
  assert.equal(notice.message, '等待会话所有人处理');
  assert.doesNotMatch(notice.nextStep, /停止等待/);
});

test('同时存在多个状态时按优先级保留全部提示及各自的原因和下一步', () => {
  const notices = getComposerStatusNotices({
    ...base,
    isAwaitingAction: true,
    engineStatusNotice: { message: '引擎不可用', tone: 'danger', reason: '引擎状态检查返回不可用', nextStep: '稍后重试' },
    isQueued: true,
  });
  assert.deepEqual(notices.map(({ message }) => message), ['请先处理上方操作请求', '引擎不可用', '消息已排队']);
  assert.match(notices[0].reason, /等待.*操作/);
  assert.match(notices[0].nextStep, /上方/);
  assert.equal(notices[1].reason, '引擎状态检查返回不可用');
  assert.equal(notices[1].nextStep, '稍后重试');
  assert.match(notices[2].reason, /执行/);
  assert.match(notices[2].nextStep, /取消排队/);
});

test('发送核实状态说明重复发送风险，空闲状态没有详情', () => {
  const notices = getComposerStatusNotices({ ...base, submissionPhase: 'verifying' });
  assert.match(notices[0].reason, /发送结果/);
  assert.match(notices[0].nextStep, /重复发送/);
  assert.deepEqual(getComposerStatusNotices(base), []);
});

test('附件列表已有明确状态时不额外显示重复提示', () => {
  assert.deepEqual(getComposerStatusNotices({ ...base, hasUnreadyAttachments: true }), []);
  assert.deepEqual(getComposerStatusNotices({ ...base, deletingAttachment: true }), []);
});

test('默认引擎回退警告不阻止发送，检查中和不可用仍阻止发送', () => {
  assert.equal(isEngineStatusBlocking(null), false);
  assert.equal(isEngineStatusBlocking({ message: '已回退', tone: 'warning' }), false);
  assert.equal(isEngineStatusBlocking({ message: '检查中', tone: 'processing' }), true);
  assert.equal(isEngineStatusBlocking({ message: '不可用', tone: 'danger' }), true);
});

test('警告和错误不会被同时存在的处理中状态遮住', () => {
  const notices = getComposerStatusNotices({
    ...base,
    engineStatusNotice: { message: '检查中', tone: 'processing' },
    attachmentNotice: { message: '附件失败', tone: 'danger' },
    isQueued: true,
  });
  assert.deepEqual(prioritizeComposerStatusNotices(notices).map(({ message }) => message), ['附件失败', '检查中', '消息已排队']);
});

test('展示组件保持单行截断、可查看完整内容并支持手动关闭', async () => {
  const source = await readFile(new URL('./ComposerStatusNotice.tsx', import.meta.url), 'utf8');
  assert.match(source, /min-w-0 flex-1 truncate rounded-sm text-left leading-5/);
  assert.match(source, /title=\{notice\.message\}/);
  assert.doesNotMatch(source, /-webkit-line-clamp|setExpanded|ResizeObserver/);
  assert.match(source, /aria-label=\{`查看完整提示：\$\{notice\.message\}`\}/);
  assert.match(source, /<DetailsDialog open=\{openedNotices !== null\}/);
  assert.match(source, /setOpenedNotices\(\[\.\.\.notices\]\)/);
  assert.match(source, /whitespace-pre-wrap break-words/);
  assert.match(source, /aria-label="关闭当前提示"/);
  assert.match(source, /setDismissed\(true\)/);
});

test('ChatInput 使用固定输入引导并将状态交给统一提示', async () => {
  const source = await readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(source, /<ComposerStatusNotice scopeKey=\{attachmentDraftKey\} notice=\{composerStatusNotice\} notices=\{visibleComposerStatusNotices\}/);
  assert.doesNotMatch(source, /\{composerStatusNotice && <ComposerStatusNotice/);
  assert.match(source, /placeholder="随心输入"/);
  assert.doesNotMatch(source, /placeholder=\{engineStatusNotice/);
  assert.match(source, /message: '已忽略重复选择的文件', tone: 'warning'/);
});

test('统一延迟器只控制提示可见性，提交禁用仍使用原始阶段', async () => {
  const source = await readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(source, /useDelayedComposerStatusNotices\(composerStatusNotices, attachmentDraftKey\)/);
  assert.match(source, /submissionPhase,/);
  assert.match(source, /const isSubmitting = submissionPhase !== 'idle'/);
  assert.match(source, /submissionPhase=\{submissionPhase\}/);
});

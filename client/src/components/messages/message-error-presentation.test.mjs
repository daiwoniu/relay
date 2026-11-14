import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getMessageErrorGuidance } from './message-error-guidance.ts';
import { isMessageSafeToRetry } from './message-retry-safety.ts';

test('错误消息在同一卡片展示友好说明、原始异常和错误码且不提供重试按钮', () => {
  const source = fs.readFileSync(new URL('AssistantMessage.tsx', import.meta.url), 'utf8');

  assert.match(source, /\{\(errorDescription \|\| errorMessage \|\| errorCode\) && \(/);
  assert.match(source, /原始异常：/);
  assert.match(source, /errorMessage/);
  assert.match(source, /errorCode/);
  assert.match(source, /errorGuidance\.suggestion/);
  assert.match(source, /statusDescription \|\| errorGuidance\?\.description/);
  assert.match(source, /assistant-message__raw-error/);
  assert.equal(source.match(/message-feedback message-feedback--error assistant-message__detail/g)?.length, 1);
  assert.doesNotMatch(source, /重试本条消息/);
});

test('常见异常提供稳定易懂的描述和可选操作建议', () => {
  assert.deepEqual(getMessageErrorGuidance('CODEX_SERVER_OVERLOADED', 'Selected model is at capacity.', { safeToRetry: true }), {
    description: '当前模型容量已满，暂时无法完成本次处理。',
    suggestion: '建议稍后重新发送。',
  });
  assert.deepEqual(getMessageErrorGuidance('INVALID_MESSAGE', '[{"code":"unrecognized_keys","keys":["engine"]}]'), {
    description: '当前请求包含服务端无法识别的参数，可能是前后端版本不一致。',
    suggestion: '建议刷新页面；如果仍然出现，请重启 Relay。',
  });
  assert.deepEqual(getMessageErrorGuidance('UNKNOWN_ERROR', 'boom', { safeToRetry: true }), {
    description: '任务处理未能完成，可结合下方原始异常排查原因。',
    suggestion: '可以重新发送；如果持续出现，请复制原始异常进行排查。',
  });
  assert.deepEqual(getMessageErrorGuidance('UNKNOWN_ERROR', 'boom'), {
    description: '任务处理未能完成，可结合下方原始异常排查原因。',
    suggestion: '请先检查处理过程和文件变更，确认没有产生副作用后再决定是否重新发送。',
  });
});

test('三个引擎已定义错误码覆盖人性化描述', () => {
  assert.deepEqual(getMessageErrorGuidance('CODEX_THREAD_ARCHIVED'), {
    description: '该会话已在 ChatGPT/Codex 中归档，无法继续处理。',
    suggestion: '请在 Codex 会话菜单中取消归档后重试。',
  });
  assert.deepEqual(getMessageErrorGuidance('CODEX_USAGE_LIMIT_EXCEEDED'), {
    description: 'Codex 使用额度已达到限制。',
    suggestion: '请检查额度后稍后重新发送。',
  });
  assert.deepEqual(getMessageErrorGuidance('RESTART_RECOVERY_FAILED'), {
    description: '恢复重启前的任务失败。',
    suggestion: '请打开原会话查看已保留的结果，必要时重新发送。',
  });
  assert.deepEqual(getMessageErrorGuidance('CODEBUDDY_PROMPT_STALLED', undefined, { safeToRetry: true }), {
    description: 'CodeBuddy 长时间没有响应，已回收连接。',
    suggestion: '可以重新发送。',
  });
  assert.deepEqual(getMessageErrorGuidance('OPENCODE_AUTH_REQUIRED'), {
    description: 'OpenCode 尚未登录，无法开始处理。',
    suggestion: '请先完成 OpenCode 登录后重试。',
  });
  assert.deepEqual(getMessageErrorGuidance('OPENCODE_CONNECTION_CLOSED', undefined, { safeToRetry: true }), {
    description: 'OpenCode 连接在任务完成前已断开。',
    suggestion: '请检查引擎状态后重新发送。',
  });
  assert.deepEqual(getMessageErrorGuidance('FINAL_ANSWER_MISSING'), {
    description: '任务已经结束，但 AI 没有生成可展示的最终回复。',
    suggestion: '请先查看处理过程及文件变更，确认已有结果后再决定是否补发消息。',
  });
  assert.deepEqual(getMessageErrorGuidance('CODEBUDDY_TURN_CANCELLED'), {
    description: '本轮 CodeBuddy 任务已取消。',
  });
});

test('未识别错误码按网关 JSON 提取与内容特征给出人性化描述', () => {
  assert.equal(getMessageErrorGuidance(undefined, '{"error":{"code":1210,"message":"upstream 429 rate limited"}}')?.description, '服务端暂时过载或触发限流，任务未能完成。');
  assert.equal(getMessageErrorGuidance('UNKNOWN', '{"error":{"message":"gateway auth failed"}}')?.description, '服务端未通过身份校验，可能是登录状态已失效。');
  assert.equal(getMessageErrorGuidance('UNKNOWN', 'agent rejected invalid parameters')?.description, '请求或返回内容不符合服务端协议，消息未能正常处理。');
  assert.equal(getMessageErrorGuidance('UNKNOWN', 'connection lost to engine', { safeToRetry: true })?.suggestion, '请检查引擎状态与网络后重新发送。');
  assert.match(getMessageErrorGuidance('UNKNOWN', 'connection lost to engine')?.suggestion, /确认没有产生副作用/);
  assert.deepEqual(getMessageErrorGuidance(undefined, '{"message":"custom readable message"}'), {
    description: '服务返回了未能识别的异常。',
    suggestion: '请查看下方原始异常，提供发生时间、操作步骤和错误码排查。',
  });
});

test('只有不存在不可重试痕迹时才建议安全重试', () => {
  const base = {
    finalContent: '', processContent: '', items: [], changedFileCount: 0, processItemCount: 0, processNarrativeCount: 0, detailsLoaded: true,
  };
  assert.equal(isMessageSafeToRetry(base), true);
  assert.equal(isMessageSafeToRetry({ ...base, items: [{ type: 'reasoning' }], processItemCount: 1 }), true);
  assert.equal(isMessageSafeToRetry({ ...base, items: [{ type: 'commandExecution' }], processItemCount: 1 }), false);
  assert.equal(isMessageSafeToRetry({ ...base, items: [{ type: 'interaction' }], processItemCount: 1 }), false);
  assert.equal(isMessageSafeToRetry({ ...base, finalContent: '已输出文本' }), false);
  assert.equal(isMessageSafeToRetry({ ...base, processContent: '处理过程文本' }), false);
  assert.equal(isMessageSafeToRetry({ ...base, changedFileCount: 1 }), false);
  assert.equal(isMessageSafeToRetry({ ...base, detailsLoaded: false, processItemCount: 1 }), false);
  assert.equal(isMessageSafeToRetry({ ...base, detailsLoaded: false, processNarrativeCount: 1 }), false);
});

test('仅支持 cancel 的授权不展示操作按钮并提示停止本轮', () => {
  const source = fs.readFileSync(new URL('InteractionPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, />取消并中断本轮<\/button>/);
  assert.match(source, /该请求未提供可用的授权操作，当前无法继续。请停止本轮后重试。/);
});

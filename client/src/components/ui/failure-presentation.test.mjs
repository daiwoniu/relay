import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getFailurePresentation } from './failure-presentation.ts';
import { getMessageErrorGuidance } from '../messages/message-error-guidance.ts';

test('文件预览只保留错误文本时仍解释缺失路径，而不是退回未知操作异常', () => {
  const raw = '文件不存在或已被移动，请确认路径并重新选择文件。';
  const result = getFailurePresentation(raw);
  assert.equal(result.raw, raw);
  assert.match(result.description, /文件或目录已不存在/);
  assert.match(result.suggestion, /重新选择有效的文件/);
  assert.doesNotMatch(result.description, /未提供可识别/);
});

test('原始异常完整保留，友好说明与建议独立生成', () => {
  const raw = '{"error":{"message":"gateway auth failed","details":"provider original details\\nline 2"}}';
  const result = getFailurePresentation(raw);
  assert.equal(result.raw, raw);
  assert.match(result.description, /身份校验/);
  assert.match(result.suggestion, /登录状态/);
  for (const [error, expected] of [
    ['Error: address already in use (os error 10048)', /端口/],
    ['请求超时，请重试', /超时/],
    ['Failed to fetch', /连接异常/],
    ['ENOSPC disk full', /磁盘/],
    ['context token limit exceeded', /上下文/],
    ['insufficient quota', /额度/],
    ['SQLITE_BUSY', /数据/],
    ['请输入正确的日期', /校验/],
  ]) {
    const detail=getFailurePresentation(error);
    assert.equal(detail.raw,error);
    assert.match(detail.description,expected);
    assert.ok(detail.suggestion);
  }
});
test('网络或超时的写操作不直接建议重复提交，权限与登录不混淆', () => {
  for(const error of ['请求超时','ECONNREFUSED','Failed to fetch']) assert.match(getFailurePresentation(error).suggestion,/核对|确认/);
  assert.match(getFailurePresentation({status:403,message:'denied'}).description,/权限/);
  assert.match(getFailurePresentation({status:401,message:'unauthorized'}).description,/身份校验/);
  assert.doesNotMatch(getFailurePresentation('unknown token calculation failure').description,/身份校验/);
  assert.doesNotMatch(getFailurePresentation('bad4000value').description,/协议/);
  for(const code of ['CODEX_TURN_ERROR','CODEX_RESPONSE_STREAM_DISCONNECTED','CODEBUDDY_PROMPT_STALLED','OPENCODE_CONNECTION_CLOSED'])
    assert.match(getMessageErrorGuidance(code,'raw',{safeToRetry:false}).suggestion,/确认没有产生副作用/);
});
test('新旧准备失败码均说明本轮尚未发送并给出可执行建议', () => {
  const codes=['TURN_START_PREPARATION_FAILED','TURN_PREPARATION_ENGINE_UNAVAILABLE','TURN_PREPARATION_CONNECTION_TIMEOUT',
    'TURN_PREPARATION_MODEL_UNAVAILABLE','TURN_PREPARATION_ATTACHMENT_INVALID','TURN_PREPARATION_STORAGE_UNAVAILABLE',
    'TURN_PREPARATION_CONFLICT','TURN_PREPARATION_ACCESS_DENIED'];
  for(const code of codes){const result=getMessageErrorGuidance(code,'raw original');assert.match(result.description,/尚未发送/);assert.ok(result.suggestion);}
});

test('未确认结果的连接异常和限流不直接建议重发，token速率限制不误判为上下文满', () => {
  for (const raw of ['network error', '429 token rate limit exceeded', 'tokens per minute limit exceeded']) {
    assert.match(getMessageErrorGuidance(undefined, raw, { safeToRetry: false }).suggestion, /确认没有产生副作用/);
    assert.match(getMessageErrorGuidance(undefined, raw, { safeToRetry: true }).suggestion, /重新发送/);
    assert.match(getFailurePresentation(raw).suggestion, /核对/);
  }
  assert.match(getFailurePresentation('429 token rate limit exceeded').description, /限流/);
  assert.match(getFailurePresentation('tokens per minute limit exceeded').description, /限流/);
  assert.match(getFailurePresentation('maximum tokens limit exceeded').description, /上下文/);
});
test('未知异常不猜测具体原因，完整长文本与错误码都保留', () => {
  const raw='<script>alert(1)</script>\n'+ 'original '.repeat(3000);
  const result=getFailurePresentation(raw,'UNCLASSIFIED_PROVIDER_ERROR');
  assert.equal(result.raw,raw);assert.equal(result.code,'UNCLASSIFIED_PROVIDER_ERROR');
  assert.match(result.description,/未提供可识别/);assert.match(result.suggestion,/发生时间/);
  const component=fs.readFileSync(new URL('FailureNotice.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(component,/dangerouslySetInnerHTML/);assert.match(component,/处理建议：/);assert.match(component,/原始异常：/);
});

test('结构化原始异常和长网关消息中的实际原因不丢失', () => {
  const value = { code: 'UPSTREAM_FAILURE', error: { message: 'gateway request details '.repeat(10) + ' ENOSPC disk full', requestId: 'sample-id' } };
  const result = getFailurePresentation(value);
  assert.equal(result.raw, JSON.stringify(value));
  assert.equal(result.code, value.code);
  assert.match(result.description, /磁盘/);
  assert.equal(getFailurePresentation(0).raw, '0');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTurnPreparationError } from './turn-preparation-error.js';

test('准备失败按具体原因分类，未知异常仍保留可读原文',()=>{
  for(const [error,code] of [
    [Object.assign(new Error('拒绝访问'),{code:'FORBIDDEN'}),'TURN_PREPARATION_ACCESS_DENIED'],
    [new Error('Codex app-server 按需启动超时'),'TURN_PREPARATION_CONNECTION_TIMEOUT'],
    [new Error('端口被占用 (os error 10048)'),'TURN_PREPARATION_ENGINE_UNAVAILABLE'],
    [new Error('所选模型不可用'),'TURN_PREPARATION_MODEL_UNAVAILABLE'],
    [new Error('附件无法读取'),'TURN_PREPARATION_ATTACHMENT_INVALID'],
    [Object.assign(new Error('storage'),{code:'STORAGE_UNAVAILABLE'}),'TURN_PREPARATION_STORAGE_UNAVAILABLE'],
    [Object.assign(new Error('snapshot changed'),{code:'CONFLICT'}),'TURN_PREPARATION_CONFLICT'],
    [new Error('unexpected preparation failure'),'TURN_START_PREPARATION_FAILED'],
  ] as const)assert.equal(classifyTurnPreparationError(error).code,code);
  assert.equal(classifyTurnPreparationError(new Error('unexpected preparation failure')).message,'unexpected preparation failure');
});
test('本机异常隐藏凭据和绝对路径、清理终端控制且体积有界',()=>{
  const result=classifyTurnPreparationError(new Error('\x1b[31mECONNREFUSED token=secret-value path=C:\\private\\config.json\x1b[0m'));
  assert.match(result.message,/ECONNREFUSED/);assert.doesNotMatch(result.message,/secret-value|private|\x1b/);
  assert.ok(classifyTurnPreparationError(new Error('token=x '.repeat(20000))).message.length<=16384);
});

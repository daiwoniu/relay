import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production handlers with boundary dependencies mocked, without mounting the app.
const source=ts.createSourceFile('ChatInput.tsx',readFileSync(new URL('./ChatInput.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(predicate(node))found=node;else ts.forEachChild(node,visit);}visit(source);assert.ok(found);return found;}
function handler(expression,context){const javascript=ts.transpile(`(${expression.getText(source)})`,{target:ts.ScriptTarget.ES2022});return vm.runInNewContext(javascript,context);}
const removeExpression=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(source)==='removeAttachment').initializer;
const applyExpression=find(node=>ts.isJsxAttribute(node)&&node.name.getText(source)==='onApply').initializer.expression;

test('新会话模型草稿只记本地应用，已有会话只走远端保存主点',async()=>{
  const calls=[],context={currentSession:null,modelDraftKey:'private-key',selectedEngine:'codex',setModelDraft:()=>calls.push('draft'),featureAction:(...args)=>calls.push(args),updateSessionEnginePreferences:async()=>{calls.push('remote');return{session:{}};},updateSession:()=>calls.push('updated')};
  const apply=handler(applyExpression,context);await apply({modelId:'private-model'});
  assert.deepEqual(calls,['draft',['composer','apply_model_draft','composer']]);
  calls.length=0;context.currentSession={id:'private-session',engine_preferences:{revision:1}};await apply({});
  assert.deepEqual(calls,['remote','updated']);
});

test('本地附件移除计一次，取消上传/不存在的附件不重复计，已上传草稿沿用远端删除',async()=>{
  const calls=[],context={attachments:[{id:'local',kind:'host_file'},{id:'ready',kind:'uploaded_file',status:'ready',projectId:'p',uploadId:'u'}],attachmentDraftKey:'draft',uploadTasksRef:{current:new Map()},deletingAttachmentDraftKeysRef:{current:new Set()},setDeletingAttachmentDraftKeys:()=>{},deleteUploadDraft:async()=>calls.push('remote'),removeReadyAttachmentForKey:()=>{},attachmentDraftKeyRef:{current:'draft'},setAttachmentNotice:()=>{},updateAttachments:()=>{},messageDraftIdRef:{current:null},featureAction:(...args)=>calls.push(args)};
  const remove=handler(removeExpression,context);
  await remove('local');assert.deepEqual(calls,[['attachments','remove_local','composer']]);
  calls.length=0;await remove('local','cancel');await remove('missing');assert.deepEqual(calls,[]);
  await remove('ready');assert.deepEqual(calls,['remote']);
});

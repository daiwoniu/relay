import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAccountReader } from './codex-account-reader.js';

test('reset reader rechecks account and Native dispatch authority after provider connection setup',async()=>{
  let email='other@example.test',authorized=false,consumed=0,closed=0,released=0;
  const reader=createCodexAccountReader({ensureReady:async()=>true,releaseReady:()=>{released++;},openRpc:async()=>({close:()=>{closed++;},request:async method=>{
    if(method==='account/read')return{account:{type:'chatgpt',email}};if(method==='account/rateLimitResetCredit/consume'){consumed++;return{outcome:'reset'};}throw Error('unexpected request');
  }})});
  const request={idempotencyKey:'synthetic'},context={expectedIdentityKey:'chatgpt:a@example.test',mayDispatch:async()=>authorized};
  await assert.rejects(()=>reader.consumeResetCredit(request,context),/CODEX_ACCOUNT_IDENTITY_CHANGED/);
  email='a@example.test';await assert.rejects(()=>reader.consumeResetCredit(request,context),/CREDIT_RESET_AUTHORITY_CHANGED/);assert.equal(consumed,0);
  authorized=true;assert.equal(await reader.consumeResetCredit(request,context),'reset');assert.equal(consumed,1);assert.equal(closed,3);assert.equal(released,3);
});

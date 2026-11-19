import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {tracker} from './tracker.ts';
import {observeMessageIntent} from './message-intent.ts';

test('发送意图仅传匿名关联，异步散列失败不影响业务',async()=>{
  const original=tracker.capture;let resolve;
  const completed=new Promise(done=>resolve=done);
  tracker.capture=()=>({track:(name,properties)=>{resolve({name,properties});return true;}});
  try{
    const messageId='sensitive-message-identifier';
    assert.equal(observeMessageIntent(messageId,'codex'),undefined);
    const event=await completed;
    assert.equal(event.name,'feature_action');assert.equal(event.properties.action,'submit');
    assert.doesNotMatch(JSON.stringify(event),/sensitive-message-identifier|messageId/);
    const compact=event.properties.operationId.replaceAll('-','');
    const expected=createHash('sha256').update('analytics:login:message:'+messageId).digest('hex').slice(0,32);
    assert.equal(compact.slice(0,12),expected.slice(0,12));assert.equal(compact.slice(13,16),expected.slice(13,16));assert.equal(compact.slice(17),expected.slice(17));
    tracker.capture=()=>{throw Error('synthetic telemetry failure');};
    assert.doesNotThrow(()=>observeMessageIntent('another'));
  }finally{tracker.capture=original;}
});

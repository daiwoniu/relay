import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoredRuntimePreparation } from './stored-runtime-preparation.js';
import { resolveTurnStartPreferences } from '../engine/runtime.js';
import type { QueueClaim, StoredClaimedTurn } from '../storage/contracts.js';

const claim = { sessionId:'session', engineId:'codex', attemptId:'attempt', resourceKey:'resource', leaseToken:'lease', requestedByUserId:'user' } as QueueClaim;
const payload = { claimedAt:123, session:{ projectId:'project', modelId:null, reasoningEffort:null, serviceTier:null } } as StoredClaimedTurn;
const catalog = { displayNames:{model:'Model'}, defaultModelId:'model', modelDefaults:{model:{reasoningEffort:'high',serviceTier:'default'}} };

test('Native preparation resolves actual configured defaults and keeps claim identity', async () => {
  const prepare = createStoredRuntimePreparation(async (engine, preferences) => {
    assert.equal(engine,'codex');assert.deepEqual(preferences,{modelId:null,reasoningEffort:null,serviceTier:null});return catalog;
  });
  const runtime = await prepare(claim,payload,new AbortController().signal);
  assert.deepEqual(resolveTurnStartPreferences(runtime),{modelId:'model',reasoningEffort:'high',serviceTier:'default'});
  assert.equal(runtime.attemptId,claim.attemptId);assert.equal(runtime.leaseToken,claim.leaseToken);
  assert.equal(runtime.requestedByUserId,'user');assert.equal(runtime.turnStartTime,123);
  assert.equal(runtime.engineConnection,null);assert.equal(runtime.isRunning,true);
});

test('cancellation during catalog wait does not return a runtime', async () => {
  const controller=new AbortController();let release!:()=>void;
  const ready=new Promise<void>(resolve=>{release=resolve;});
  const prepare=createStoredRuntimePreparation(async()=>{await ready;return catalog;});
  const pending=prepare(claim,payload,controller.signal);controller.abort();release();
  await assert.rejects(pending,{message:'NOT_SUBMITTED'});
});

test('already cancelled preparation does not request a catalog', async () => {
  const controller=new AbortController();controller.abort();
  await assert.rejects(createStoredRuntimePreparation(async()=>{assert.fail('catalog called');})(claim,payload,controller.signal),{message:'NOT_SUBMITTED'});
});

test('catalog failure remains a preparation failure and explicit preferences win', async () => {
  await assert.rejects(createStoredRuntimePreparation(async()=>{throw Error('catalog unavailable');})(claim,payload,new AbortController().signal),/catalog unavailable/);
  const selected={...payload,session:{...payload.session,modelId:'selected',reasoningEffort:'low',serviceTier:'fast'}};
  const runtime=await createStoredRuntimePreparation(async()=>catalog)(claim,selected,new AbortController().signal);
  assert.deepEqual(resolveTurnStartPreferences(runtime),{modelId:'selected',reasoningEffort:'low',serviceTier:'fast'});
});

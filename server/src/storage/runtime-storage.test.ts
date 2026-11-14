import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStorage, runtimeOperationId } from './runtime-storage.js';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { EngineEventEnvelope } from '../engine/events.js';

const principal = { kind: 'runtime' as const, sessionId: 'session', attemptId: 'attempt', connectionId: 'connection', runtimeVersion: 1 };
const event = (): EngineEventEnvelope => ({ engineId: 'codex', payload: { type: 'message_complete', turnId: 'coordinator-turn', content: 'result' },
  meta: { source: 'realtime', sequence: 1, observedAt: 100, eventId: 'coordinator-event', externalSessionId: 'thread', externalTurnId: 'coordinator-turn' } });

test('a synchronous burst of deltas is coalesced without dropping text or the terminal receipt', async () => {
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const failures:unknown[]=[],storage=new RuntimeStorage(port,{storeId:'store',generation:1,leaseToken:'lease',engineId:'codex',runtime:{},principal,isCurrent:()=>true,onFailure:(...args)=>{failures.push(args);}});
  let text='';
  try{
    for(let n=0;n<2000;n++)storage.accept({...event(),payload:{type:'delta',itemId:'text',phase:'final_answer',content:'米'},meta:{...event().meta,eventId:`delta-${n}`,sequence:n}},async captured=>{
      if(captured.payload.type==='delta')text+=captured.payload.content;
    });
    storage.accept({...event(),payload:{type:'message_complete',turnId:'coordinator-turn',content:'米'.repeat(2000)}},async(_,context)=>{await context.finishTerminal({id:'burst-answer',turnId:'coordinator-turn',content:text,items:null,metadata:null,durationMs:null});});
    await storage.drain().catch(()=>assert.fail(JSON.stringify(failures)));assert.equal(text,'米'.repeat(2000));assert.deepEqual(failures,[]);
    assert.equal(f.scalar("SELECT content FROM messages WHERE id='burst-answer'"),text);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{await storage.close().catch(()=>{});await port.close();f.cleanup();}
});

test('delta batching preserves phase, observation time and nonstream order, including replay after a flush',async()=>{
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const storage=new RuntimeStorage(port,{storeId:'store',generation:1,leaseToken:'lease',engineId:'codex',runtime:{},principal,isCurrent:()=>true,onFailure:()=>assert.fail('unexpected delta failure')});
  const observed:any[]=[],handler:Parameters<RuntimeStorage['process']>[1]=async value=>{observed.push({payload:value.payload,at:value.meta.observedAt});};
  const delta=(n:number,content:string,phase='commentary'):EngineEventEnvelope=>({...event(),payload:{type:'delta',itemId:'text',content,phase},meta:{...event().meta,eventId:`part-${n}`,sequence:n,observedAt:100+n}});
  try{
    storage.accept(delta(1,'a'),handler);storage.accept(delta(2,'b'),handler);storage.accept(delta(2,'b'),handler);
    storage.accept({...event(),payload:{type:'item_complete',item:{id:'tool',type:'commandExecution',status:'completed'}}},handler);
    storage.accept(delta(3,'answer','final_answer'),handler);await storage.drain();
    storage.accept(delta(2,'b'),handler);await storage.drain();
    assert.deepEqual(observed,[{payload:{type:'delta',itemId:'text',content:'ab',phase:'commentary'},at:101},
      {payload:{type:'item_complete',item:{id:'tool',type:'commandExecution',status:'completed'}},at:100},
      {payload:{type:'delta',itemId:'text',content:'answer',phase:'final_answer'},at:103}]);
  }finally{await storage.close();await port.close();f.cleanup();}
});

test('provider event IDs reused by different sessions cannot collide in the Native fact store',async()=>{
  const f=fixture();f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,engine,engine_session_id,active_attempt_id,message_revision) VALUES('second','owner','project','codex','second-thread','second-attempt',0);
    INSERT INTO engine_resource_leases VALUES('second-attempt','second','second-lease','running','codex','codex:default',1,1)`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const first=new RuntimeStorage(port,{storeId:'store',generation:1,leaseToken:'lease',engineId:'codex',runtime:{},principal,isCurrent:()=>true,onFailure:()=>{}});
  const second=new RuntimeStorage(port,{storeId:'store',generation:1,leaseToken:'second-lease',engineId:'codex',runtime:{},
    principal:{...principal,sessionId:'second',attemptId:'second-attempt',connectionId:'second-connection'},isCurrent:()=>true,onFailure:()=>{}});
  try{await first.process(event(),(_,context)=>{assert.equal(context.fact?.sessionId,'session');});
    await second.process({...event(),payload:{type:'message_complete',turnId:'second-turn',content:'second result'},meta:{...event().meta,externalSessionId:'second-thread',externalTurnId:'second-turn'}},
      (_,context)=>{assert.equal(context.fact?.sessionId,'second');});assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'),2);
  }finally{await first.close().catch(()=>{});await second.close().catch(()=>{});await port.close();f.cleanup();}
});

test('local stop evidence is awaited, deduplicated and used for a single stopped projection', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: {},
    principal, isCurrent: () => true, onFailure: () => assert.fail('unexpected local evidence failure') });
  try {
    let firstId: string | undefined;
    await storage.processLocal({ type: 'interrupt_confirmed', userInitiated: true }, ({ fact }) => {
      firstId = fact.id; assert.equal(fact.source, 'local');
      assert.deepEqual(fact.payload, { userInitiated: true });
      assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'), 1);
    }, 100);
    await storage.processLocal({ type: 'interrupt_confirmed', userInitiated: true }, async (context) => {
      assert.equal(context.fact.id, firstId);
      await context.persistTerminal({ decision: { id: 'stopped', sessionId: 'session', attemptId: 'attempt', engineId: 'codex',
        outcome: 'stopped', reasonCode: 'USER_STOPPED', factId: context.fact.id, decidedAt: 110, projectedAt: null },
        message: { id: 'stop-message', turnId: 'turn-stop', content: '', items: null, metadata: null, durationMs: null } });
    }, 110);
    assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'), 1);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 0);
    assert.equal(f.scalar("SELECT stopped FROM messages WHERE id='stop-message'"), 1);
  } finally { await storage.close(); await port.close(); f.cleanup(); }
});

test('duplicate capacity observations use event identity and do not duplicate accounting', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: {},
    principal, isCurrent: () => true, onFailure: () => assert.fail('unexpected capacity failure') });
  const retry: EngineEventEnvelope = { ...event(), payload: { type: 'capacity_observation', observation: { type: 'request_retry' } } };
  try {
    for (let i = 0; i < 2; i++) await storage.process(retry, async (_, context) => {
      assert.equal(context.fact, null);
      const result = await context.persistCapacity({ type: 'request_retry' });
      assert.equal(result.replayed, i === 1);
    });
    assert.equal(f.scalar('SELECT count(*) FROM engine_capacity_events'), 1);
  } finally { await storage.close(); await port.close(); f.cleanup(); }
});

test('unknown conflicting input cannot be mistaken for an older committed receipt of the same command', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: {},
    principal, isCurrent: () => true, onFailure: () => undefined });
  const retry: EngineEventEnvelope = { ...event(), payload: { type: 'capacity_observation', observation: { type: 'request_retry' } } };
  try {
    await storage.process(retry, async (_, context) => { await context.persistCapacity({ type: 'request_retry' }); });
    const execute = port.execute.bind(port);
    port.execute = (async (request: any) => {
      const result = await execute(request);
      assert.equal(result.state, 'rejected');
      return { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' };
    }) as typeof port.execute;
    await assert.rejects(storage.process(retry, async (_, context) => {
      await context.persistCapacity({ type: 'overload', retryAfterMs: null });
      assert.fail('a receipt for different input must never confirm this effect');
    }), /CONFLICT/);
    assert.equal(f.scalar('SELECT count(*) FROM engine_provider_cooldowns'), 0);
    assert.equal(f.scalar('SELECT count(*) FROM engine_capacity_events'), 1);
  } finally { await storage.close().catch(() => undefined); await port.close(); f.cleanup(); }
});

test('real EngineEvent is persisted before handler and nested terminal does not deadlock the event queue', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const owner = {}; const order: string[] = [];
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: owner,
    principal, isCurrent: (value) => value.runtime === owner, onFailure: () => order.push('failure'),
    beforeTerminal: async (guard) => {
      await Promise.resolve(); guard.assertCurrent();
      assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 1);
      order.push('flush');
    },
    onTerminalCommitted: (effect, guard) => { guard.assertCurrent(); order.push(effect.replayed ? 'replay' : 'terminal'); } });
  try {
    const result = await storage.process(event(), async (_, context) => {
      order.push('handler'); assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'), 1);
      assert.ok(context.fact);
      await context.persistUsage({ inputTokens: 12 });
      await context.persistHostContext({ externalSessionId: 'thread', compactionCount: 0, delivered: true });
      assert.equal(f.scalar('SELECT active_turn_usage FROM sessions'), '{"inputTokens":12}');
      assert.equal(JSON.parse(String(f.scalar('SELECT engine_metadata FROM sessions'))).relayHostContext.externalSessionId, 'thread');
      await context.persistTerminal({ decision: { id: 'decision', sessionId: 'session', attemptId: 'attempt', engineId: 'codex',
        externalTurnId: 'coordinator-turn', factId: context.fact!.id, outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', decidedAt: 100, projectedAt: null },
      message: { id: 'coordinator-message', turnId: 'coordinator-turn', content: 'result', items: null, metadata: null, durationMs: 1 } });
    });
    assert.equal(result.state, 'handled'); assert.deepEqual(order, ['handler', 'flush', 'terminal']);
    assert.equal(f.scalar('SELECT status FROM sessions'), 'completed');
    await storage.close();
    const recovery = await port.lookup({ storeId: 'store', operationId: runtimeOperationId('terminal', 'decision'), principal: { kind: 'system', purpose: 'recovery' } });
    assert.equal(recovery.state, 'committed');
  } finally { await storage.close().catch(() => undefined); await port.close(); f.cleanup(); }
});

test('out-of-handler host and usage callbacks share event ordering and capture caller inputs', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: {},
    principal, isCurrent: () => true, onFailure: () => assert.fail('unexpected callback storage failure') });
  try {
    const usage = { inputTokens: 5 };
    const first = storage.updateUsage(usage); usage.inputTokens = 999;
    const host = storage.setHostContext({ externalSessionId: 'thread', compactionCount: 0, delivered: true });
    const last = storage.process(event(), async (_, context) => {
      assert.equal(f.scalar('SELECT active_turn_usage FROM sessions'), '{"inputTokens":5}');
      await context.persistHostContext({ externalSessionId: 'thread', compactionCount: 0, delivered: false });
      assert.equal(JSON.parse(String(f.scalar('SELECT engine_metadata FROM sessions'))).relayHostContext, undefined);
    });
    assert.equal((await first).state, 'handled'); assert.equal((await host).state, 'handled'); assert.equal((await last).state, 'handled');
  } finally { await storage.close(); await port.close(); f.cleanup(); }
});

test('failed pre-terminal flush keeps the lease and prevents terminal publication', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  let failures = 0;
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: {},
    principal, isCurrent: () => true, onFailure: () => { failures++; },
    beforeTerminal: async () => { throw new Error('flush failed'); },
    onTerminalCommitted: () => assert.fail('failed flush must not publish terminal') });
  try {
    await assert.rejects(storage.process(event(), async (_, context) => {
      await context.persistTerminal({ decision: { id: 'failed-flush', sessionId: 'session', attemptId: 'attempt', engineId: 'codex',
        externalTurnId: 'coordinator-turn', factId: context.fact!.id, outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', decidedAt: 100, projectedAt: null },
        message: { id: 'result', turnId: 'coordinator-turn', content: 'result', items: null, metadata: null, durationMs: null } });
    }), /flush failed/);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 1);
    assert.equal(f.scalar('SELECT count(*) FROM engine_terminal_decisions'), 0);
    assert.equal(failures, 1);
  } finally { await storage.close().catch(() => undefined); await port.close(); f.cleanup(); }
});

test('retirement fences the old actor and same-generation re-registration cannot revive it', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await port.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime: principal });
    await port.retireRuntime({ storeId: 'store', workerGeneration: 1, runtime: principal });
    await assert.rejects(port.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime: principal }), /CONFLICT/);
    await port.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime: { ...principal, runtimeVersion: 2 } });
  } finally { await port.close(); f.cleanup(); }
});

test('dropped response is resolved from a real committed receipt before continuing event handling', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const execute = port.execute.bind(port);
  port.execute = (async (request: any) => {
    const result = await execute(request);
    return result.state === 'committed' ? { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' } : result;
  }) as typeof port.execute;
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: {},
    principal, isCurrent: () => true, onFailure: () => assert.fail('unexpected storage failure') });
  try {
    let handled = false;
    const result = await storage.process(event(), (_, context) => { assert.ok(context.fact); handled = true; });
    assert.equal(result.state, 'handled'); assert.equal(handled, true);
    assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'), 1);
  } finally { await storage.close(); await port.close(); f.cleanup(); }
});

test('an unaccepted critical event poisons the attempt instead of letting later terminal work pass', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  let failures = 0;
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: {},
    principal, isCurrent: () => true, maxBytes: 1, onFailure: () => { failures++; } });
  try {
    storage.accept(event(), () => assert.fail('overloaded event must not execute'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(storage.health().failed, true); assert.equal(failures, 1);
    await assert.rejects(storage.process(event(), () => assert.fail('poisoned queue must not execute')), /FAILED/);
  } finally { await storage.close().catch(() => undefined); await port.close(); f.cleanup(); }
});

test('retirement while an acknowledged fact reply is delayed prevents late handler publication', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const execute = port.execute.bind(port);
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const acknowledged = new Promise<void>((done) => { started = done; });
  port.execute = (async (request: any) => { const result = await execute(request); started(); await gate; return result; }) as typeof port.execute;
  let current = true; let published = false;
  const storage = new RuntimeStorage(port, { storeId: 'store', generation: 1, leaseToken: 'lease', engineId: 'codex', runtime: {},
    principal, isCurrent: () => current, onFailure: () => assert.fail('retired event should be stale') });
  try {
    const pending = storage.process(event(), () => { published = true; });
    await acknowledged; current = false; release();
    assert.deepEqual(await pending, { state: 'stale' }); assert.equal(published, false);
    assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'), 1);
  } finally { release(); await storage.close(); await port.close(); f.cleanup(); }
});

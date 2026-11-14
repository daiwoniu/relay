import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { StorageCommandEnvelope } from './contracts.js';
import { FIXED_WORKSPACE_PATH } from '../workspace-console/workspace-snapshot.js';

function enqueue(): StorageCommandEnvelope & { command: { name: 'turn.enqueue'; input: {
  sessionId: string; attemptId: string; messageId: string; engineId: 'codex'; resourceKey: string;
  content: string; metadata: null; expectedPreferencesRevision: number; origin: { kind: 'direct' };
  draft: { projectId: string; title: string; titleManuallySet: boolean };
  workspaceTaskLink?: { taskId: string; workspacePath: string };
} } } {
  return { ...markRead(), operationId: 'enqueue', command: { name: 'turn.enqueue', input: {
    sessionId: 'draft', attemptId: 'new-attempt', messageId: 'user-message', engineId: 'codex', resourceKey: 'codex:default',
    content: 'test', metadata: null, expectedPreferencesRevision: 0, origin: { kind: 'direct' },
    draft: { projectId: 'project', title: 'fixed title', titleManuallySet: true },
  } } };
}

test('first send materializes draft, message, queue and receipt atomically with stable replay', async () => {
  const f = fixture();f.mutate(`UPDATE users SET role='admin' WHERE id='owner';UPDATE projects SET path='${FIXED_WORKSPACE_PATH}' WHERE id='project'`);const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const request = enqueue();
    request.command.input.workspaceTaskLink = { taskId: 'task', workspacePath: FIXED_WORKSPACE_PATH };
    assert.equal((await client.execute(request)).state, 'committed');
    assert.equal(f.scalar("SELECT status FROM sessions WHERE id='draft'"), 'queued');
    assert.equal(f.scalar("SELECT title FROM sessions WHERE id='draft'"), 'fixed title');
    assert.equal(f.scalar('SELECT count(*) FROM engine_queue_entries'), 1);
    assert.equal(f.scalar('SELECT count(*) FROM workspace_console_links'), 1);
    const replay = await client.execute(request);
    assert.equal(replay.state, 'committed'); if (replay.state === 'committed') assert.equal(replay.replayed, true);
    assert.equal(f.scalar("SELECT count(*) FROM messages WHERE id='user-message'"), 1);
    f.mutate("UPDATE sessions SET deleted_at=1 WHERE id='draft'");
    assert.deepEqual(await client.execute(request), { state: 'rejected', operationId: 'enqueue', code: 'FORBIDDEN' });
  } finally { await client.close(); f.cleanup(); }
});

test('Feishu task reference is committed with the first message and never duplicated on replay',async()=>{
  const f=fixture();f.mutate(`UPDATE users SET role='admin' WHERE id='owner';UPDATE projects SET path='${FIXED_WORKSPACE_PATH}' WHERE id='project'`);
  const client=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  try{
    const request=enqueue();request.command.input.workspaceTaskLink={taskId:'feishu:9001000015',workspacePath:FIXED_WORKSPACE_PATH};
    assert.equal((await client.execute(request)).state,'committed');assert.equal((await client.execute(request)).state,'committed');
    assert.equal(f.scalar('SELECT count(*) FROM workspace_console_links'),1);
    assert.equal(f.scalar('SELECT feishu_work_item_id FROM workspace_console_links'),'9001000015');
  }finally{await client.close();f.cleanup();}
});

test('workspace first-send cannot bypass the admin or fixed-path fence through the private command',async()=>{
  const f=fixture();const client=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  try{
    const request=enqueue();request.command.input.workspaceTaskLink={taskId:'task',workspacePath:FIXED_WORKSPACE_PATH};
    const member=await client.execute(request);assert.equal(member.state,'rejected');if(member.state==='rejected')assert.equal(member.code,'FORBIDDEN');
    f.mutate("UPDATE users SET role='admin' WHERE id='owner'");request.command.input.workspaceTaskLink.workspacePath='D:/synthetic';
    const wrong=await client.execute(request);assert.equal(wrong.state,'rejected');if(wrong.state==='rejected')assert.equal(wrong.code,'INVALID_ARGUMENT');
    assert.equal(f.scalar("SELECT count(*) FROM sessions WHERE id='draft'"),0);assert.equal(f.scalar('SELECT count(*) FROM workspace_console_links'),0);
  }finally{await client.close();f.cleanup();}
});

test('rejected preferences and receipt failure do not leave a persisted empty draft', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const request = enqueue(); request.command.input.expectedPreferencesRevision = 9;
    assert.deepEqual(await client.execute(request), { state: 'rejected', operationId: 'enqueue', code: 'CONFLICT' });
    assert.equal(f.scalar("SELECT count(*) FROM sessions WHERE id='draft'"), 0);
    request.command.input.expectedPreferencesRevision = 0;
    f.mutate("CREATE TRIGGER fail_receipt BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await client.execute(request)).state, 'unknown');
    assert.equal(f.scalar("SELECT count(*) FROM sessions WHERE id='draft'"), 0);
    assert.equal(f.scalar('SELECT count(*) FROM engine_queue_entries'), 0);
    assert.equal(f.scalar("SELECT count(*) FROM messages WHERE id='user-message'"), 0);
  } finally { await client.close(); f.cleanup(); }
});

test('project ownership and resource identity reject the admission before committing', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const request = enqueue();
    request.principal = markRead('x', 'other').principal;
    assert.deepEqual(await client.execute(request), { state: 'rejected', operationId: 'enqueue', code: 'FORBIDDEN' });
    request.principal = markRead().principal; request.command.input.resourceKey = 'codebuddy:default';
    assert.deepEqual(await client.execute(request), { state: 'rejected', operationId: 'enqueue', code: 'INVALID_ARGUMENT' });
    assert.equal(f.scalar("SELECT count(*) FROM sessions WHERE id='draft'"), 0);
  } finally { await client.close(); f.cleanup(); }
});

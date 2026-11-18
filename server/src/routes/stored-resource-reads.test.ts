import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createStoredResourceReadsRouter } from './stored-resource-reads.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';

const project = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const attachment = '33333333-3333-4333-8333-333333333333';
const cookie = (id = 'owner') => serializeSessionCookie(`synthetic-read-${id}`, Date.now()+600_000, false);
async function prepared() {
  const f = fixture();
  const items = JSON.stringify([{ id: 'command', type: 'commandExecution', status: 'completed', details: { command: 'echo synthetic', aggregatedOutput: 'synthetic output', privateField: 'must-not-escape' } }]);
  const metadata = JSON.stringify({ processContent: 'synthetic reasoning', attachments: [{ id: attachment, kind: 'uploaded_file',
    name: 'synthetic.txt', path: 'D:/nonexistent-relay-read-fixture.txt', size: 1, mimeType: 'text/plain', available: true }], privateField: 'must-not-escape' });
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','owner','D:/read-http','Read');
    INSERT INTO sessions(id,owner_user_id,project_id,status,engine,engine_session_id,message_revision,updated_at)
      VALUES('${session}','owner','${project}','idle','codex','engine-session-synthetic',2,10);
    INSERT INTO messages(id,session_id,turn_id,role,content,phase,items,metadata,created_at,duration,stopped) VALUES
      ('a','${session}','turn','user','first',NULL,NULL,NULL,1,NULL,0),
      ('b','${session}','turn','assistant','last','final_answer','${items.replaceAll("'", "''")}','${metadata.replaceAll("'", "''")}',2,NULL,0);`);
  for (const id of ['owner','other','admin']) f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at)
    VALUES('${hashSessionToken(`synthetic-read-${id}`)}','${id}',${Date.now()+600_000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const hooks = { archive: async () => {}, report: async (_child: string, _item: string): Promise<string | null> => 'synthetic report' };
  const app = new Hono().route('/api', createStoredResourceReadsRouter({ port, refreshSessionArchiveState: () => hooks.archive(), loadSubAgentReport: (child, item) => hooks.report(child, item) }));
  app.get('/api/public-probe', (c) => c.text('public'));
  const get = (url: string, user = 'owner') => app.request(url, { headers: { cookie: cookie(user) } });
  return { f, port, app, hooks, get, cleanup: async () => { await port.close(); f.cleanup(); } };
}

test('子任务回报只读取消息内明确的完成记录，不接受浏览器指定线程，读取后复核权限', async () => {
  const p = await prepared();
  try {
    const items = [
      { id: 'subagent-completed-first', type: 'subAgentActivity', status: 'completed', details: { kind: 'completed', agentThreadId: 'child' } },
      { id: 'subagent-completed-second', type: 'subAgentActivity', status: 'completed', details: { kind: 'completed', agentThreadId: 'child' } },
      { id: 'started', type: 'subAgentActivity', status: 'completed', details: { kind: 'started', agentThreadId: 'child' } },
    ];
    p.f.mutate(`UPDATE messages SET items='${JSON.stringify(items)}' WHERE id='b'`);
    const path = `/api/sessions/${session}/messages/b/subagent-report`;
    const calls: string[][] = [];
    p.hooks.report = async (child, item) => { calls.push([child, item]); return `report:${item}`; };
    assert.equal((await p.app.request(`${path}?itemId=subagent-completed-first`)).status, 401);
    assert.equal((await p.get(`${path}?itemId=subagent-completed-first`, 'other')).status, 404);
    assert.equal((await p.get(`${path}?itemId=started`)).status, 404);
    assert.equal((await p.get(`${path}?itemId=subagent-completed-first&childThreadId=foreign`)).status, 400);
    assert.equal((await p.get(`${path.replace('/messages/b/', '/messages/a/')}?itemId=subagent-completed-first`)).status, 404);
    assert.equal(calls.length, 0);
    for (const item of ['subagent-completed-first', 'subagent-completed-second']) {
      const response = await p.get(`${path}?itemId=${item}`);
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(await response.json(), { content: `report:${item}` });
    }
    assert.deepEqual(calls, [['child', 'subagent-completed-first'], ['child', 'subagent-completed-second']]);
    p.f.mutate(`INSERT INTO project_members VALUES('${project}','other','viewer',1,1,1)`);
    assert.equal((await p.get(`${path}?itemId=subagent-completed-first`, 'other')).status, 200);
    p.hooks.report = async () => { p.f.mutate(`DELETE FROM project_members WHERE project_id='${project}' AND user_id='other'`); return 'must not escape'; };
    assert.equal((await p.get(`${path}?itemId=subagent-completed-first`, 'other')).status, 404);
    p.hooks.report = async () => null;
    assert.equal((await p.get(`${path}?itemId=subagent-completed-first`)).status, 404);
    p.hooks.report = async () => { throw new Error('private-engine-details'); };
    const failed = await p.get(`${path}?itemId=subagent-completed-first`);
    assert.equal(failed.status, 503); assert(!JSON.stringify(await failed.json()).includes('private-engine-details'));
  } finally { await p.cleanup(); }
});
test('candidate reads preserve project/session response contracts and offset pagination with current actor scopes', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.app.request('/api/public-probe')).status, 200);
    assert.equal((await p.app.request('/api/projects')).status, 401);
    const projects = await p.get('/api/projects'); assert.equal(projects.status, 200); assert.equal(projects.headers.get('cache-control'), 'private, no-store');
    assert.equal((await projects.json() as any[]).length, 2);
    const list = await p.get(`/api/sessions?projectId=${project}&limit=1&offset=0`); assert.equal(list.status, 200);
    assert.deepEqual((await list.json() as any[]).map((s) => s.id), [session]);
    assert.deepEqual(await (await p.get(`/api/sessions?projectId=${project}&limit=1&offset=1`)).json(), []);
    const details = await p.get(`/api/sessions/${session}`); assert.equal(details.status, 200);
    const dto = await details.json() as any; assert.equal(dto.engine_session_id, 'engine-session-synthetic'); assert.equal(dto.last_result.messageId, 'b');
    assert.equal((await p.get('/api/projects?scope=all', 'other')).status, 404);
    assert.equal((await p.get('/api/projects?scope=all', 'admin')).status, 200);
  } finally { await p.cleanup(); }
});

test('deletion previews preserve owner/admin authorization and count live archived sessions through the Worker', async () => {
  const p=await prepared();try{
    const sessionUrl=`/api/sessions/${session}/deletion-impact`,projectUrl=`/api/projects/${project}/deletion-impact`;
    assert.equal((await p.app.request(sessionUrl)).status,401);
    assert.deepEqual(await (await p.get(sessionUrl)).json(),{hasLinkedCodexThread:false});
    p.f.mutate(`UPDATE sessions SET codex_thread_id='synthetic-thread' WHERE id='${session}';
      INSERT INTO sessions(id,owner_user_id,project_id,status,archived,codex_thread_id,deleted_at) VALUES
      ('preview-archived','owner','${project}','processing',1,'archived-thread',NULL),
      ('preview-deleted','owner','${project}','processing',0,'deleted-thread',1)`);
    const preview=await p.get(sessionUrl);assert.equal(preview.status,200);assert.equal(preview.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(await preview.json(),{hasLinkedCodexThread:true});
    assert.deepEqual(await (await p.get(projectUrl)).json(),{sessionCount:2,linkedCodexSessionCount:2,inProgressSessionCount:1});
    for(const url of [sessionUrl,projectUrl]){
      assert.equal((await p.get(url,'admin')).status,200);assert.equal((await p.get(url,'other')).status,404);
      assert.equal((await p.get(url+'?extra=1')).status,400);
    }
    p.f.mutate(`INSERT INTO project_members VALUES('${project}','other','manager',1,1,1)`);
    assert.equal((await p.get(sessionUrl,'other')).status,404);assert.equal((await p.get(projectUrl,'other')).status,404);
    assert.equal((await p.get('/api/sessions/invalid/deletion-impact')).status,400);
    p.f.mutate(`UPDATE sessions SET deleted_at=1 WHERE id='${session}'`);assert.equal((await p.get(sessionUrl)).status,404);
    p.f.mutate(`UPDATE projects SET deleted_at=1 WHERE id='${project}'`);assert.equal((await p.get(projectUrl,'admin')).status,404);
  }finally{await p.cleanup();}
});
test('message page and sanitized details match existing DTO shape without heavy process fields in the page', async () => {
  const p = await prepared();
  try {
    const response = await p.get(`/api/sessions/${session}/message-page?limit=1`); assert.equal(response.status, 200);
    const value = await response.json() as any; assert.equal(value.unchanged, false); assert.equal(value.page.revision, 2);
    assert.deepEqual(value.page.nextCursor, { beforeCreatedAt: 2, beforeId: 'b' });
    assert.equal(value.page.messages[0].id, 'b'); assert.equal(value.page.messages[0].hasDetails, true);
    assert.equal(value.page.messages[0].items, undefined); assert.equal(value.page.messages[0].attachments[0].available, false);
    const older = await p.get(`/api/sessions/${session}/message-page?beforeCreatedAt=2&beforeId=b&limit=1`);
    const page = (await older.json() as any).page; assert.equal(page.messages[0].id, 'a'); assert.equal(page.hasMore, false);
    const detail = await p.get(`/api/sessions/${session}/messages/b/details`); assert.equal(detail.status, 200);
    const data = await detail.json() as any; assert.equal(data.items[0].details.command, 'echo synthetic'); assert.equal(data.processContent, 'synthetic reasoning');
    assert.equal(JSON.stringify(data).includes('must-not-escape'), false);
    assert.equal((await p.get(`/api/sessions/${session}/messages/m2/details`)).status, 404); // Belongs to another session.
  } finally { await p.cleanup(); }
});
test('known revision is an authorized fast path and never bypasses cursor/schema or current shared permissions', async () => {
  const p = await prepared();
  try {
    const url = `/api/sessions/${session}/message-page?knownRevision=2`;
    assert.deepEqual(await (await p.get(url)).json(), { unchanged: true, revision: 2 });
    assert.equal((await p.get(url, 'other')).status, 404);
    p.f.mutate(`INSERT INTO project_members VALUES('${project}','other','viewer',1,1,1)`);
    assert.equal((await p.get(url, 'other')).status, 200);
    p.f.mutate(`UPDATE project_members SET can_view_sessions=0 WHERE user_id='other'`);
    assert.equal((await p.get(url, 'other')).status, 404);
    assert.equal((await p.get(`/api/sessions/${session}/messages/b/details`, 'other')).status, 404);
    assert.equal((await p.get(`/api/sessions/${session}/message-page?knownRevision=2&beforeId=b`)).status, 400);
    assert.equal((await p.get(`/api/sessions/${session}/message-page?knownRevision=2&limit=101`)).status, 400);
    p.f.mutate(`UPDATE projects SET deleted_at=1 WHERE id='${project}'`);
    assert.equal((await p.get(url, 'admin')).status, 404);
  } finally { await p.cleanup(); }
});
test('archive refresh failures are owned; revocation after archive awaits is rechecked before querying', async () => {
  const p = await prepared(); const warn = console.warn; const warnings: unknown[] = []; console.warn = (...values) => { warnings.push(values); };
  try {
    p.hooks.archive = async () => { throw new Error('private archive diagnostic'); };
    assert.equal((await p.get('/api/sessions')).status, 200); assert.equal(warnings.length, 1); assert.equal(JSON.stringify(warnings).includes('private archive diagnostic'), false);
    p.hooks.archive = async () => { p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'"); };
    assert.equal((await p.get('/api/sessions')).status, 404);
    assert.equal((await p.get('/api/sessions')).status, 401);
  } finally { console.warn = warn; await p.cleanup(); }
});
test('history raw-field size gates avoid loading an oversized next record and preserve an honest continuation cursor', async () => {
  const p = await prepared();
  try {
    p.f.mutate(`UPDATE messages SET content=replace(hex(zeroblob(3700000)),'0','a') WHERE id='a' AND session_id='${session}'`);
    const first = await p.get(`/api/sessions/${session}/message-page?limit=100`); assert.equal(first.status, 200);
    const page = (await first.json() as any).page; assert.equal(page.messages.length, 1); assert.equal(page.messages[0].id, 'b'); assert.equal(page.hasMore, true);
    const huge = await p.get(`/api/sessions/${session}/message-page?beforeCreatedAt=2&beforeId=b`);
    assert.equal(huge.status, 503); assert.equal((await huge.json() as any).code, 'PAYLOAD_TOO_LARGE');
    const detail = await p.get(`/api/sessions/${session}/messages/a/details`); assert.equal(detail.status, 503);
    assert.equal((await detail.json() as any).code, 'PAYLOAD_TOO_LARGE');
    assert.deepEqual(await (await p.get(`/api/sessions/${session}/message-page?knownRevision=2`)).json(), { unchanged: true, revision: 2 });
  } finally { await p.cleanup(); }
});
test('read boundaries reject malformed queries, preserve must-change gates and return outage instead of empty data', async () => {
  const p = await prepared();
  try {
    for (const url of ['/api/sessions?limit=501', '/api/sessions?offset=-1', '/api/sessions?unknown=1', '/api/projects?scope=invalid', '/api/sessions/invalid'])
      assert.equal((await p.get(url)).status, 400);
    p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'"); assert.equal((await p.get('/api/projects')).status, 403);
    await p.port.close();
    const response = await p.get('/api/projects'); assert.equal(response.status, 503); assert.equal((await response.json() as any).code, 'STORAGE_UNAVAILABLE');
  } finally { await p.cleanup(); }
});

test('native search routes preserve literal/attachment/process/operation matching and current actor boundaries', async () => {
  const p = await prepared();
  try {
    const response = await p.get('/api/sessions/search?q=synthetic'); assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.query, 'synthetic'); assert.equal(data.results.length, 1); assert.equal(data.results[0].session.id, session);
    assert.equal(data.results[0].messageMatchCount, 1); assert.equal(data.results[0].latestMessageMatch.messageId, 'b');
    assert.equal(JSON.stringify(data).includes('must-not-escape'), false);
    const path = `/api/sessions/${session}/search-matches?q=echo%20synthetic`;
    assert.equal((await (await p.get(path)).json() as any).total, 0);
    const operation = await p.get(`${path}&includeOperations=1`); assert.equal(operation.status, 200);
    assert.equal((await operation.json() as any).matches[0].scope, 'operation');
    assert.equal((await (await p.get(`/api/sessions/${session}/search-matches?q=synthetic%20reasoning&includeProcess=1`)).json() as any).matches[0].scope, 'process');
    p.f.mutate(`UPDATE messages SET content='literal 100% _name' WHERE id='a' AND session_id='${session}'`);
    assert.equal((await (await p.get('/api/sessions/search?q=100%25')).json() as any).results.length, 1);
    assert.equal((await (await p.get('/api/sessions/search?q=100_')).json() as any).results.length, 0);
    assert.equal((await p.get(`${path}&includeOperations=1`, 'other')).status, 404);
    p.f.mutate(`INSERT INTO project_members VALUES('${project}','other','viewer',1,1,1)`);
    assert.equal((await p.get(`${path}&includeOperations=1`, 'other')).status, 200);
    p.f.mutate(`UPDATE projects SET deleted_at=1 WHERE id='${project}'`);
    assert.deepEqual((await (await p.get('/api/sessions/search?q=synthetic', 'admin')).json() as any).results, []);
  } finally { await p.cleanup(); }
});

test('streamed process search keeps exact totals and last-match order using a bounded ring', async () => {
  const p = await prepared();
  try {
    p.f.mutate(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8)
      INSERT INTO messages(id,session_id,turn_id,role,content,metadata,created_at,stopped)
      SELECT 'ring-'||x,'${session}','turn','assistant','ring needle','{"processContent":"ring needle"}',x+2,0 FROM n`);
    const result = await p.get(`/api/sessions/${session}/search-matches?q=needle&includeProcess=1&limit=3`);
    assert.equal(result.status, 200); const data = await result.json() as any;
    assert.equal(data.total, 16); assert.equal(data.truncated, true);
    assert.deepEqual(data.matches.map((m: any) => [m.messageId, m.scope]), [['ring-7','process'],['ring-8','message'],['ring-8','process']]);
    const plain = await p.get(`/api/sessions/${session}/search-matches?q=needle&limit=3`);
    const page = await plain.json() as any; assert.equal(page.total, 8); assert.deepEqual(page.matches.map((m: any) => m.messageId), ['ring-6','ring-7','ring-8']);
  } finally { await p.cleanup(); }
});

test('legacy offset message arrays remain chronological, support details flags and never silently shorten a budget-limited page', async () => {
  const p = await prepared();
  try {
    const all = await p.get(`/api/sessions/${session}/messages?limit=2`); assert.equal(all.status, 200);
    const messages = await all.json() as any[]; assert.deepEqual(messages.map((m) => m.id), ['a','b']); assert.equal(messages[1].items.length, 1);
    const shallow = await p.get(`/api/sessions/${session}/messages?limit=1&details=0`); assert.equal((await shallow.json() as any[])[0].items, undefined);
    assert.equal((await (await p.get(`/api/sessions/${session}/messages?limit=1&offset=1`)).json() as any[])[0].id, 'a');
    assert.deepEqual(await (await p.get(`/api/sessions/${session}/messages?limit=0`)).json(), []);
    assert.equal((await p.get(`/api/sessions/${session}/messages?limit=2`, 'other')).status, 404);
    p.f.mutate(`UPDATE messages SET content=replace(hex(zeroblob(3700000)),'0','a') WHERE id='a' AND session_id='${session}'`);
    const oversized = await p.get(`/api/sessions/${session}/messages?limit=2`); assert.equal(oversized.status, 503);
    assert.equal((await oversized.json() as any).code, 'PAYLOAD_TOO_LARGE');
    for (const url of ['/api/sessions/search?q=', '/api/sessions/search?q=ok&scope=invalid', `/api/sessions/${session}/search-matches?q=ok&includeProcess=true`, `/api/sessions/${session}/messages?limit=501`])
      assert.equal((await p.get(url)).status, 400);
  } finally { await p.cleanup(); }
});

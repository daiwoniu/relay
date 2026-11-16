import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeLocalStorage } from './local-storage-initializer.js';
import { NativeStore } from './native-store.js';
import type { CoreCommand, StorageCommandEnvelope } from './contracts.js';

test('bootstrap project requires a valid replacement, supports trash lifecycle and stays deleted across restarts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-deletable-bootstrap-'));
  const filename = path.join(root, 'relay.db'), workspace = path.join(root, 'workspace');
  let initialized: Awaited<ReturnType<typeof initializeLocalStorage>> | undefined;
  let store: NativeStore | undefined;
  try {
    initialized = await initializeLocalStorage(filename, workspace);
    const db = new DatabaseSync(filename);
    const admin = db.prepare("SELECT id,default_project_id FROM users WHERE role='admin'").get()!;
    const adminId = String(admin.id), bootstrap = String(admin.default_project_id);
    db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?)').run('synthetic-bootstrap-session', adminId, 1, Date.now() + 600_000);
    db.close();
    store = new NativeStore(filename, initialized.storeId, 1);
    const principal = { kind: 'user' as const, userId: adminId, authSessionHash: 'synthetic-bootstrap-session' };
    const execute = (command: CoreCommand) => store!.execute({ protocolVersion: 1, storeId: initialized!.storeId,
      workerGeneration: 1, requestId: randomUUID(), operationId: randomUUID(), principal, command } as StorageCommandEnvelope);
    const commit = (command: CoreCommand) => {
      const result = execute(command);
      assert.equal(result.state, 'committed', JSON.stringify(result));
      if (result.state !== 'committed') throw Error('not committed');
      return result.value;
    };
    const scalar = (sql: string, ...params: string[]) => {
      const connection = new DatabaseSync(filename, { readOnly: true });
      try { return Object.values(connection.prepare(sql).get(...params)!)[0]; }
      finally { connection.close(); }
    };
    const prepareDelete = () => execute({ name: 'trash.prepareSoftDelete', input: { jobId: randomUUID(), kind: 'project', resourceId: bootstrap } });
    assert.equal(prepareDelete().state, 'rejected', 'cannot delete the current default');
    const replacement = randomUUID(), child = randomUUID();
    commit({ name: 'project.create', input: { projectId: replacement, path: path.join(root, 'replacement'), name: '替代默认项目' } });
    commit({ name: 'session.create', input: { sessionId: child, projectId: bootstrap, engine: null, title: '保留会话' } });
    commit({ name: 'account.setDefaultProject', input: { projectId: replacement } });
    const source = new DatabaseSync(filename);
    source.prepare('UPDATE users SET default_project_id=NULL WHERE id=?').run(adminId);
    assert.equal(prepareDelete().state, 'rejected', 'a null preference is not a replacement');
    source.prepare('UPDATE users SET default_project_id=? WHERE id=?').run(replacement, adminId);
    source.prepare('UPDATE projects SET deleted_at=1 WHERE id=?').run(replacement);
    assert.equal(prepareDelete().state, 'rejected', 'a deleted replacement is invalid');
    source.prepare('UPDATE projects SET deleted_at=NULL WHERE id=?').run(replacement);
    source.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at,default_project_id) VALUES(?,?,?,?,?,?)')
      .run('synthetic-other-user', 'synthetic-other-user', 'synthetic', 1, 1, bootstrap);
    assert.equal(prepareDelete().state, 'rejected', 'another account still using this default blocks deletion');
    source.prepare('UPDATE users SET default_project_id=NULL WHERE id=?').run('synthetic-other-user');
    source.close();
    const softDelete = () => {
      const jobId = randomUUID();
      commit({ name: 'trash.prepareSoftDelete', input: { jobId, kind: 'project', resourceId: bootstrap } });
      assert.equal(execute({ name: 'account.setDefaultProject', input: { projectId: bootstrap } }).state, 'rejected', 'pending deletion cannot become the default again');
      commit({ name: 'trash.commitSoftDelete', input: { jobId } });
    };
    softDelete();
    assert.ok(scalar('SELECT deleted_at FROM projects WHERE id=?', bootstrap));
    const trash = store.readTrash({ principal, name: 'projects', input: { limit: 50, offset: 0, q: '' } });
    assert.ok(trash.items.some(project => project.id === bootstrap));
    assert.equal(store.readTrash({ principal, name: 'projectSessions', input: { projectId: bootstrap, limit: 50, offset: 0 } }).total, 1);
    store.close(); store = undefined;
    await initialized.owner.release(); initialized = undefined;
    initialized = await initializeLocalStorage(filename, workspace);
    store = new NativeStore(filename, initialized.storeId, 1);
    assert.equal(scalar('SELECT default_project_id FROM users WHERE id=?', adminId), replacement);
    assert.ok(scalar('SELECT deleted_at FROM projects WHERE id=?', bootstrap), 'restart must not restore the bootstrap project');
    assert.equal(scalar('SELECT count(*) FROM projects WHERE owner_user_id=?', adminId), 2, 'restart must not create a replacement bootstrap');
    const nextSession = randomUUID();
    commit({ name: 'session.create', input: { sessionId: nextSession, projectId: null, engine: null, title: null } });
    assert.equal(scalar('SELECT project_id FROM sessions WHERE id=?', nextSession), replacement);
    const plan = store.readTrash({ principal, name: 'restorePlan', input: { kind: 'project', id: bootstrap } });
    commit({ name: 'trash.restoreProject', input: { projectId: bootstrap, sourceDigest: plan.sourceDigest } });
    assert.equal(scalar('SELECT deleted_at FROM projects WHERE id=?', bootstrap), null);
    assert.equal(scalar('SELECT deleted_at FROM sessions WHERE id=?', child), null);
    assert.equal(scalar('SELECT default_project_id FROM users WHERE id=?', adminId), replacement, 'restore must not change the preference');
    softDelete();
    const impact = store.readTrash({ principal, name: 'impact', input: { kind: 'project', id: bootstrap } });
    const purgeId = randomUUID();
    commit({ name: 'trash.preparePurge', input: { jobId: purgeId, kind: 'project', resourceId: bootstrap,
      impactRevision: impact.impactRevision, confirmationName: 'Relay 默认项目' } });
    commit({ name: 'trash.startPurgeFiles', input: { jobId: purgeId } });
    const job = store.readPurgeJob({ principal, jobId: purgeId })!;
    commit({ name: 'trash.commitPurge', input: { jobId: purgeId, intentDigest: job.intentDigest! } });
    commit({ name: 'trash.finishPurgeFiles', input: { jobId: purgeId, intentDigest: job.intentDigest } });
    assert.equal(scalar('SELECT count(*) FROM projects WHERE id=?', bootstrap), 0);
    assert.equal(scalar('SELECT count(*) FROM sessions WHERE id=?', child), 0);
    store.close(); store = undefined;
    await initialized.owner.release(); initialized = undefined;
    initialized = await initializeLocalStorage(filename, workspace);
    assert.equal(scalar('SELECT count(*) FROM projects WHERE owner_user_id=?', adminId), 1, 'purged bootstrap must not reappear either');
    assert.equal(scalar('SELECT default_project_id FROM users WHERE id=?', adminId), replacement);
  } finally {
    store?.close();
    await initialized?.owner.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

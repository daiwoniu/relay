import fs from 'node:fs';
import { PREVIEW_PREFERENCES_SCHEMA_SQL } from '../contracts/preview-preferences.js';
import { ANALYTICS_SCHEMA_SQL } from '../analytics/contract.js';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StorageCommandEnvelope } from './contracts.js';
import { ensureEngineConcurrencyTables } from '../db/engine-concurrency.js';
import { ensureWorkspaceConsoleLinksTable } from '../db/workspace-console-links-migration.js';
import { nativeQueries } from './native-queries.js';
import { ensureEngineTurnFactTables } from '../db/engine-turn-facts.js';
import { ensureSessionFollowupsTable } from '../db/session-followups.js';
import { ensureAdminAuditTable } from '../db/admin-audit.js';
import { ensureProjectMembersTable } from '../db/project-members.js';
import { ensureApprovalTrustSettingsTable } from '../db/approval-trust.js';

export function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-store-'));
  const filename = path.join(directory, 'synthetic.db');
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,disabled_at INTEGER,must_change_password INTEGER DEFAULT 0);
    CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires_at INTEGER);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,owner_user_id TEXT REFERENCES users(id),deleted_at INTEGER,active_attempt_id TEXT,
      message_revision INTEGER,engine TEXT,engine_session_id TEXT,engine_metadata TEXT,context_compaction_count INTEGER,active_turn_usage TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),turn_id TEXT,role TEXT,content TEXT,phase TEXT,
      items TEXT,metadata TEXT,created_at INTEGER,duration INTEGER,stopped INTEGER);
    CREATE TABLE engine_resource_leases(attempt_id TEXT PRIMARY KEY,session_id TEXT,lease_token TEXT,state TEXT,
      engine_id TEXT,resource_key TEXT,acquired_at INTEGER,started_at INTEGER);
    CREATE TABLE session_read_receipts(user_id TEXT REFERENCES users(id),session_id TEXT REFERENCES sessions(id),message_id TEXT,read_at INTEGER,PRIMARY KEY(user_id,session_id));
    INSERT INTO users VALUES('owner','member',NULL,0),('other','member',NULL,0),('admin','admin',NULL,0);
    INSERT INTO sessions VALUES('session','owner',NULL,'attempt',2,'codex','thread','{}',0,NULL);
    INSERT INTO engine_resource_leases VALUES('attempt','session','lease','running','codex','codex:default',1,1);
    INSERT INTO messages VALUES('m1','session','turn','assistant','first','final_answer',NULL,NULL,1,NULL,0),
      ('m2','session','turn','assistant','latest','final_answer',NULL,NULL,2,NULL,0);`);
  db.exec(PREVIEW_PREFERENCES_SCHEMA_SQL);
  db.exec(ANALYTICS_SCHEMA_SQL);
  for (const id of ['owner', 'other', 'admin']) db.prepare('INSERT INTO auth_sessions VALUES(?,?,?)').run(`auth-${id}`, id, Date.now() + 3600_000);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,owner_user_id TEXT,path TEXT,deleted_at INTEGER);
    ALTER TABLE users ADD COLUMN username TEXT;
    ALTER TABLE users ADD COLUMN password_hash TEXT;
    ALTER TABLE users ADD COLUMN updated_at INTEGER DEFAULT 1;
    ALTER TABLE users ADD COLUMN created_at INTEGER DEFAULT 1;
    ALTER TABLE users ADD COLUMN display_name TEXT;
    ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER;
    ALTER TABLE users ADD COLUMN avatar_mime TEXT;
    ALTER TABLE users ADD COLUMN avatar_data BLOB;
    ALTER TABLE users ADD COLUMN default_project_id TEXT;
    ALTER TABLE users ADD COLUMN default_engine TEXT DEFAULT 'codex';
    ALTER TABLE users ADD COLUMN default_model_id TEXT;
    ALTER TABLE users ADD COLUMN can_create_project INTEGER DEFAULT 1;
    UPDATE users SET username=id;
    ALTER TABLE auth_sessions ADD COLUMN created_at INTEGER DEFAULT 1;
    INSERT INTO projects VALUES('project','owner','D:/synthetic',NULL);
    ALTER TABLE projects ADD COLUMN name TEXT DEFAULT 'test';
    ALTER TABLE projects ADD COLUMN normalized_path TEXT;
    ALTER TABLE projects ADD COLUMN created_at INTEGER DEFAULT 1;
    ALTER TABLE projects ADD COLUMN updated_at INTEGER DEFAULT 1;
    ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0;
    ALTER TABLE projects ADD COLUMN pinned_at INTEGER;
    ALTER TABLE projects ADD COLUMN is_system INTEGER DEFAULT 0;
    ALTER TABLE projects ADD COLUMN deletion_protected INTEGER DEFAULT 0;
    ALTER TABLE projects ADD COLUMN members_can_view_sessions INTEGER DEFAULT 0;
    CREATE UNIQUE INDEX fixture_usernames ON users(username COLLATE NOCASE);
    CREATE UNIQUE INDEX fixture_project_paths ON projects(owner_user_id,normalized_path);
    ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT 'test';
    ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;
    ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN codex_thread_id TEXT;
    ALTER TABLE sessions ADD COLUMN codex_archived INTEGER DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN codex_archived_for_trash INTEGER DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN title_manually_set INTEGER DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN created_at INTEGER DEFAULT 1;
    ALTER TABLE sessions ADD COLUMN updated_at INTEGER DEFAULT 1;
    ALTER TABLE sessions ADD COLUMN project_id TEXT DEFAULT 'project';
    ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'processing';
    ALTER TABLE sessions ADD COLUMN engine_bound INTEGER DEFAULT 1;
    ALTER TABLE sessions ADD COLUMN engine_preferences_revision INTEGER DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN selected_model_id TEXT;
    ALTER TABLE sessions ADD COLUMN selected_reasoning_effort TEXT;
    ALTER TABLE sessions ADD COLUMN selected_service_tier TEXT;
    ALTER TABLE sessions ADD COLUMN active_turn_id TEXT;
    ALTER TABLE sessions ADD COLUMN active_turn_started_at INTEGER;
    ALTER TABLE sessions ADD COLUMN recovery_previous_status TEXT;`);
  db.exec('ALTER TABLE sessions ADD COLUMN token_usage TEXT');
  db.exec(`CREATE TABLE shared_records(id TEXT PRIMARY KEY,public_token TEXT NOT NULL UNIQUE,owner_user_id TEXT NOT NULL REFERENCES users(id),
    source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,title TEXT NOT NULL,scope TEXT NOT NULL,message_count INTEGER NOT NULL,include_process INTEGER NOT NULL,
    snapshot_version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER,revoked_at INTEGER)`);
  db.exec(`CREATE TABLE sidebar_order_items(scope TEXT NOT NULL,item_type TEXT NOT NULL,item_id TEXT NOT NULL,position INTEGER,PRIMARY KEY(scope,item_type,item_id))`);
  db.exec(`CREATE TABLE sidebar_order_scopes(scope TEXT PRIMARY KEY,updated_at INTEGER);
    CREATE TABLE context_compaction_events(session_id TEXT,thread_id TEXT,turn_id TEXT,created_at INTEGER,PRIMARY KEY(session_id,thread_id,turn_id))`);
  ensureEngineConcurrencyTables(nativeQueries(db));
  ensureWorkspaceConsoleLinksTable(nativeQueries(db));
  ensureEngineTurnFactTables(nativeQueries(db));
  ensureSessionFollowupsTable(nativeQueries(db));
  ensureAdminAuditTable(nativeQueries(db));
  ensureProjectMembersTable(nativeQueries(db));
  ensureApprovalTrustSettingsTable(nativeQueries(db));
  db.close();
  return { directory, filename,
    mutate: (sql: string) => { const connection = new DatabaseSync(filename); try { connection.exec(sql); } finally { connection.close(); } },
    scalar: (sql: string) => { const connection = new DatabaseSync(filename); try { return Object.values(connection.prepare(sql).get()!)[0]; } finally { connection.close(); } },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
export function markRead(operationId = 'read', actor = 'owner'): StorageCommandEnvelope & {
  command: { name: 'session.markRead'; input: { sessionId: string; messageId: string } };
} {
  return { protocolVersion: 1, storeId: 'store', requestId: operationId, workerGeneration: 1, operationId,
    principal: { kind: 'user', userId: actor, authSessionHash: `auth-${actor}` },
    command: { name: 'session.markRead', input: { sessionId: 'session', messageId: 'm2' } } };
}

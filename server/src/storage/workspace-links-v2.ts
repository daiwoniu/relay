import type { DatabaseSync } from 'node:sqlite';
import { WORKSPACE_ID, WORKSPACE_ROOT } from '../workspace-console/workspace-config.js';

export const WORKSPACE_LINKS_V2_SQL = `
ALTER TABLE workspace_console_links RENAME TO workspace_console_links_v1;
DROP INDEX IF EXISTS idx_workspace_console_links_task;
CREATE TABLE workspace_console_links (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT '', workspace_path TEXT NOT NULL,
  task_id TEXT NOT NULL, session_id TEXT DEFAULT '', feishu_work_item_id TEXT DEFAULT '',
  connection_scope TEXT NOT NULL DEFAULT '', target_ref TEXT NOT NULL DEFAULT '', run_id TEXT DEFAULT '',
  relation_source TEXT NOT NULL CHECK(relation_source IN ('explicit','structured','candidate')),
  confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')), last_verified_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id,workspace_path,task_id,session_id,connection_scope,target_ref,feishu_work_item_id,run_id)
);
CREATE INDEX idx_workspace_console_links_task ON workspace_console_links(workspace_id,task_id);
INSERT INTO workspace_console_links(id,workspace_id,workspace_path,task_id,session_id,feishu_work_item_id,run_id,relation_source,confidence,last_verified_at,created_at,updated_at)
SELECT id,'',workspace_path,task_id,session_id,feishu_work_item_id,run_id,relation_source,confidence,last_verified_at,created_at,updated_at FROM workspace_console_links_v1;
DROP TABLE workspace_console_links_v1;`;

export function migrateWorkspaceLinksV2(db: DatabaseSync) {
  db.exec(WORKSPACE_LINKS_V2_SQL);
  // Only the configured, exact historical path establishes workspace ownership.
  db.prepare('UPDATE workspace_console_links SET workspace_id=? WHERE lower(workspace_path)=lower(?)').run(WORKSPACE_ID, WORKSPACE_ROOT);
  // Original values, including nullable legacy fields, are preserved. The read projection
  // treats Feishu rows without a connection scope as candidates without rewriting history.
}

CREATE TABLE IF NOT EXISTS workspace_console_links (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT,
  feishu_work_item_id TEXT,
  run_id TEXT,
  relation_source TEXT NOT NULL CHECK (relation_source IN ('explicit', 'structured', 'candidate')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  last_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_path, task_id, session_id, feishu_work_item_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_console_links_task
  ON workspace_console_links(workspace_path, task_id);

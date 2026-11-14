-- Fresh application schema for Native format v1, captured from an empty legacy initializer.
-- Historical migration snapshot: do not regenerate from a user database.

CREATE TABLE admin_audit_events (
      id            TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action        TEXT NOT NULL CHECK(action IN ('account.create','account.disable','account.enable','account.reset_password','account.project_permission','project.member_set','project.member_remove','project.update','project.delete','project.restore','project.permanent_delete','project.upload_delete','session.update','session.delete','session.restore','session.permanent_delete','session.send','session.stop','session.approval_decide','session.engine_preferences_update','session.unarchive','session.fork_from','share.create_from_session','share.revoke','share.delete')),
      resource_type TEXT NOT NULL CHECK(resource_type IN ('user','project','session','share')),
      resource_id   TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      result        TEXT NOT NULL CHECK(result IN ('started','succeeded','failed')),
      occurred_at   INTEGER NOT NULL
    );

CREATE TABLE approval_trust_settings (
      id         TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      mode       TEXT NOT NULL CHECK(mode IN ('trusted', 'manual')),
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (project_id IS NOT NULL AND session_id IS NULL AND mode = 'trusted')
        OR (project_id IS NULL AND session_id IS NOT NULL)
      )
    );

CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

CREATE TABLE codex_local_usage_accounts (
      creator_account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL
    );

CREATE TABLE codex_local_usage_backfill (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );

CREATE TABLE codex_local_usage_events (
      fingerprint TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      email TEXT NOT NULL,
      creator_account_id TEXT,
      tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      attribution TEXT NOT NULL CHECK (attribution IN ('confirmed_backfill', 'log_account'))
    );

CREATE TABLE codex_local_usage_sync (
      email TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL
    );

CREATE TABLE context_compaction_events (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, thread_id, turn_id)
    );

CREATE TABLE engine_capacity_events (
      id TEXT PRIMARY KEY,
      resource_key TEXT NOT NULL,
      attempt_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'start_claimed','start_forwarded','start_accepted','start_failed','overload',
        'request_retry','completion_retry','cooldown_started'
      )),
      occurred_at INTEGER NOT NULL
    );

CREATE TABLE engine_concurrency_settings (
      resource_key TEXT PRIMARY KEY,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode','zcode')),
      max_active_turns INTEGER NOT NULL CHECK(max_active_turns BETWEEN 1 AND 32),
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE engine_provider_cooldowns (
      resource_key TEXT PRIMARY KEY,
      consecutive_overloads INTEGER NOT NULL DEFAULT 0,
      cooldown_until INTEGER,
      probe_attempt_id TEXT,
      last_overload_at INTEGER,
      last_success_at INTEGER,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE engine_queue_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL UNIQUE,
      user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode','zcode')),
      resource_key TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('queued','claimed')),
      claim_token TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER
    );

CREATE TABLE engine_queue_fairness (
      resource_key TEXT PRIMARY KEY,
      last_served_user_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE engine_resource_leases (
      attempt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode','zcode')),
      resource_key TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('claimed','running')),
      acquired_at INTEGER NOT NULL,
      started_at INTEGER
    );

CREATE TABLE engine_terminal_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('codex','codebuddy','opencode','zcode')),
        external_turn_id TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','interrupted','stopped')),
        reason_code TEXT NOT NULL,
        fact_id TEXT NOT NULL REFERENCES engine_turn_facts(id) ON DELETE RESTRICT,
        decided_at INTEGER NOT NULL,
        projected_at INTEGER,
        UNIQUE(session_id, engine, attempt_id)
      );

CREATE TABLE engine_turn_facts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('codex','codebuddy','opencode','zcode')),
        connection_id TEXT NOT NULL,
        external_session_id TEXT,
        external_turn_id TEXT,
        fact_type TEXT NOT NULL,
        source TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        observed_at INTEGER NOT NULL,
        safe_payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id     TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content     TEXT NOT NULL,
      phase       TEXT,
      items       TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL
    , duration INTEGER, stopped INTEGER DEFAULT 0);

CREATE TABLE project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('viewer','collaborator','manager')),
      can_view_sessions INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, user_id)
    );

CREATE TABLE projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      normalized_path TEXT,
      owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted_at  INTEGER
    , pinned INTEGER DEFAULT 0, is_system INTEGER DEFAULT 0, pinned_at INTEGER, deletion_protected INTEGER NOT NULL DEFAULT 0, members_can_view_sessions INTEGER NOT NULL DEFAULT 0);

CREATE TABLE session_followups (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      reply_to_async_question_id TEXT,
      target_turn_id TEXT,
      origin_json TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'received','steering','steered','queued','dispatching',
        'delivered','paused','uncertain','cancelled'
      )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error_code TEXT
    );

CREATE TABLE session_read_receipts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL, read_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, session_id)
  );

CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT '新对话',
        title_manually_set INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        pinned      INTEGER DEFAULT 0,
        pinned_at   INTEGER,
        archived    INTEGER DEFAULT 0,
        project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
        owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        engine      TEXT NOT NULL DEFAULT 'codex' CHECK(engine IN ('codex','codebuddy','opencode','zcode')),
        engine_bound INTEGER NOT NULL DEFAULT 1 CHECK(engine_bound IN (0,1)),
        engine_session_id TEXT,
        engine_metadata TEXT,
        codex_thread_id TEXT,
        codex_archived INTEGER DEFAULT 0,
        codex_archived_for_trash INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'idle',
        token_usage TEXT,
        active_turn_usage TEXT,
        active_turn_id TEXT,
        active_attempt_id TEXT,
        active_turn_started_at INTEGER,
        recovery_previous_status TEXT,
        message_revision INTEGER NOT NULL DEFAULT 0,
        context_compaction_count INTEGER NOT NULL DEFAULT 0,
        selected_model_id TEXT,
        selected_reasoning_effort TEXT,
        selected_service_tier TEXT,
        engine_preferences_revision INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );

CREATE TABLE shared_records (
      id                TEXT PRIMARY KEY,
      public_token      TEXT NOT NULL UNIQUE,
      owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      title             TEXT NOT NULL,
      scope             TEXT NOT NULL CHECK(scope IN ('single', 'selection', 'session')),
      message_count     INTEGER NOT NULL,
      include_process   INTEGER NOT NULL DEFAULT 0,
      snapshot_version  INTEGER NOT NULL,
      snapshot_json     TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER,
      revoked_at        INTEGER
    );

CREATE TABLE sidebar_order_items (
      scope     TEXT NOT NULL REFERENCES sidebar_order_scopes(scope) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN ('project', 'session')),
      item_id   TEXT NOT NULL,
      position  INTEGER NOT NULL,
      PRIMARY KEY(scope, item_type, item_id),
      UNIQUE(scope, position)
    );

CREATE TABLE sidebar_order_scopes (
      scope      TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE trash_attachment_cleanup_jobs (
      operation_id TEXT PRIMARY KEY,
      quarantine_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE user_notification_preferences (
      user_id                TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      desktop_system_enabled INTEGER NOT NULL DEFAULT 0,
      desktop_sound_enabled  INTEGER NOT NULL DEFAULT 0,
      desktop_session_end_system_enabled INTEGER NOT NULL DEFAULT 0,
      desktop_session_end_sound_enabled INTEGER NOT NULL DEFAULT 0,
      mobile_system_enabled  INTEGER NOT NULL DEFAULT 0,
      mobile_sound_enabled   INTEGER NOT NULL DEFAULT 0,
      mobile_session_end_system_enabled INTEGER NOT NULL DEFAULT 0,
      mobile_session_end_sound_enabled INTEGER NOT NULL DEFAULT 0,
      approval_sound         TEXT NOT NULL DEFAULT 'gentle_dual',
      session_end_sound      TEXT NOT NULL DEFAULT 'crisp',
      desktop_sound_volume   INTEGER NOT NULL DEFAULT 45,
      mobile_sound_volume    INTEGER NOT NULL DEFAULT 80,
      updated_at              INTEGER NOT NULL
    );

CREATE TABLE user_theme_assets (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

CREATE TABLE user_theme_settings (
      user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings_json TEXT NOT NULL,
      color_style  TEXT NOT NULL DEFAULT 'neutral' CHECK(color_style IN ('neutral','aurora')),
      text_scale   TEXT NOT NULL DEFAULT 'standard' CHECK(text_scale IN ('compact','standard','large')),
      updated_at   INTEGER NOT NULL
    );

CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      display_name  TEXT,
      avatar_mime   TEXT,
      avatar_data   BLOB,
      avatar_updated_at INTEGER,
      default_project_id TEXT,
      default_engine TEXT NOT NULL DEFAULT 'codex' CHECK(default_engine IN ('codex','codebuddy','opencode','zcode')),
      default_model_id TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disabled_at   INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    , can_create_project INTEGER NOT NULL DEFAULT 1);

CREATE TABLE workspace_console_links (
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

CREATE TABLE workspace_snapshots (
    source TEXT NOT NULL CHECK (source IN ('dashboard', 'responsibility', 'codex_official')),
    identity_key TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (source, identity_key)
  );

CREATE INDEX idx_admin_audit_occurred_at ON admin_audit_events(occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_owner ON admin_audit_events(owner_user_id, occurred_at DESC);

CREATE INDEX idx_approval_trust_expiry
      ON approval_trust_settings(expires_at) WHERE expires_at IS NOT NULL;

CREATE UNIQUE INDEX idx_approval_trust_owner_project
      ON approval_trust_settings(owner_user_id, project_id) WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX idx_approval_trust_owner_session
      ON approval_trust_settings(owner_user_id, session_id) WHERE session_id IS NOT NULL;

CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

CREATE INDEX idx_codex_local_usage_email_day
      ON codex_local_usage_events(email, day);

CREATE INDEX idx_engine_capacity_events_resource_time
      ON engine_capacity_events(resource_key, occurred_at DESC);

CREATE INDEX idx_engine_leases_resource
      ON engine_resource_leases(resource_key, state, acquired_at);

CREATE INDEX idx_engine_queue_fifo
      ON engine_queue_entries(resource_key, state, created_at, id);

CREATE INDEX idx_engine_queue_user_fifo
      ON engine_queue_entries(resource_key, requested_by_user_id, state, created_at, id);

CREATE INDEX idx_engine_terminal_decisions_session
        ON engine_terminal_decisions(session_id, decided_at DESC);

CREATE INDEX idx_engine_turn_facts_attempt
        ON engine_turn_facts(session_id, attempt_id, observed_at, sequence);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);

CREATE INDEX idx_messages_session_role_created ON messages(session_id, role, created_at);

CREATE INDEX idx_project_members_user ON project_members(user_id);

CREATE UNIQUE INDEX idx_projects_owner_normalized_path
      ON projects(owner_user_id, normalized_path)
      WHERE owner_user_id IS NOT NULL
    ;

CREATE UNIQUE INDEX idx_session_followups_active_question
      ON session_followups(session_id, reply_to_async_question_id)
      WHERE reply_to_async_question_id IS NOT NULL AND state != 'cancelled';

CREATE INDEX idx_session_followups_fifo
      ON session_followups(session_id, state, created_at, id);

CREATE UNIQUE INDEX idx_sessions_engine_external_id ON sessions(engine, engine_session_id) WHERE engine_session_id IS NOT NULL;

CREATE INDEX idx_sessions_project ON sessions(project_id);

CREATE INDEX idx_sessions_project_engine_updated ON sessions(project_id, engine, updated_at DESC);

CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

CREATE INDEX idx_shared_records_expiry ON shared_records(expires_at);

CREATE INDEX idx_shared_records_owner_created ON shared_records(owner_user_id, created_at DESC);

CREATE UNIQUE INDEX idx_shared_records_public_token ON shared_records(public_token);

CREATE INDEX idx_sidebar_order_items_scope_position ON sidebar_order_items(scope, position);

CREATE INDEX idx_trash_attachment_cleanup_jobs_status_created
      ON trash_attachment_cleanup_jobs(status, created_at);

CREATE INDEX idx_user_theme_assets_owner ON user_theme_assets(user_id, created_at DESC);

CREATE INDEX idx_workspace_console_links_task
      ON workspace_console_links(workspace_path, task_id);

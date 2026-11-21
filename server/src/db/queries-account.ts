import { v4 as uuid } from 'uuid';
import { resolveModelPreferenceChange } from '../engine/models/preferences.js';
import type { AccountThemeSettingsDto } from '../contracts/index.js';
import { createDefaultThemeSettings, projectThemeSettingsV1, readStoredThemeSettings } from '../theme/theme-settings.js';
import { getDB, type SQLiteDB } from './index.js';
import type { UserRole } from './user-role.js';
import type {
  AuthSession,
  EngineId,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  NotificationSound,
  Project,
  ThemeAssetRecord,
  User,
} from './query-types.js';
import { normalizeProjectPathForOwnership } from './multi-account.js';
import { disableUserAndCancelQueuedTurnsInDatabase } from './engine-concurrency.js';

export function getThemeSettingsFromDatabase(db: Pick<SQLiteDB, 'get'>, userId: string): AccountThemeSettingsDto {
  const row = db.get('SELECT settings_json, color_style, text_scale FROM user_theme_settings WHERE user_id = ?', [userId]);
  return row ? readStoredThemeSettings(String(row.settings_json), row.color_style, row.text_scale) : createDefaultThemeSettings();
}

export function saveThemeSettingsInDatabase(
  db: Pick<SQLiteDB, 'run' | 'saveToFile'>,
  userId: string,
  settings: AccountThemeSettingsDto,
): AccountThemeSettingsDto {
  db.run(`
    INSERT INTO user_theme_settings (user_id, settings_json, color_style, text_scale, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      settings_json = excluded.settings_json,
      color_style = excluded.color_style,
      text_scale = excluded.text_scale,
      updated_at = excluded.updated_at
  `, [userId, JSON.stringify(projectThemeSettingsV1(settings)), settings.colorStyle, settings.textScale, settings.updatedAt]);
  db.saveToFile();
  return settings;
}

export function getThemeSettings(userId: string): AccountThemeSettingsDto {
  return getThemeSettingsFromDatabase(getDB(), userId);
}

export function saveThemeSettings(userId: string, settings: AccountThemeSettingsDto): AccountThemeSettingsDto {
  return saveThemeSettingsInDatabase(getDB(), userId, settings);
}

export function createThemeAssetRecordInDatabase(
  db: Pick<SQLiteDB, 'run' | 'saveToFile'>,
  record: ThemeAssetRecord,
): ThemeAssetRecord {
  db.run('INSERT INTO user_theme_assets (id, user_id, created_at) VALUES (?, ?, ?)', [record.id, record.user_id, record.created_at]);
  db.saveToFile();
  return record;
}

export function getThemeAssetRecordFromDatabase(db: Pick<SQLiteDB, 'get'>, assetId: string): ThemeAssetRecord | undefined {
  return db.get('SELECT id, user_id, created_at FROM user_theme_assets WHERE id = ?', [assetId]) as ThemeAssetRecord | undefined;
}

export function deleteThemeAssetRecordInDatabase(db: Pick<SQLiteDB, 'run' | 'saveToFile'>, assetId: string): void {
  db.run('DELETE FROM user_theme_assets WHERE id = ?', [assetId]);
  db.saveToFile();
}

export function createThemeAssetRecord(record: ThemeAssetRecord): ThemeAssetRecord {
  return createThemeAssetRecordInDatabase(getDB(), record);
}

export function getThemeAssetRecord(assetId: string): ThemeAssetRecord | undefined {
  return getThemeAssetRecordFromDatabase(getDB(), assetId);
}

export function deleteThemeAssetRecord(assetId: string): void {
  deleteThemeAssetRecordInDatabase(getDB(), assetId);
}

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  desktopSystemEnabled: false,
  desktopSoundEnabled: false,
  desktopSessionEndSystemEnabled: false,
  desktopSessionEndSoundEnabled: false,
  mobileSystemEnabled: false,
  mobileSoundEnabled: false,
  mobileSessionEndSystemEnabled: false,
  mobileSessionEndSoundEnabled: false,
  approvalSound: 'gentle_dual',
  sessionEndSound: 'crisp',
  desktopSoundVolume: 45,
  mobileSoundVolume: 80,
};

const NOTIFICATION_SOUNDS = new Set<NotificationSound>(['gentle_dual', 'crisp', 'soft_chime', 'short_tone', 'high_dual', 'rising_triple', 'falling_low']);

function readNotificationSound(value: unknown, fallback: NotificationSound): NotificationSound {
  return typeof value === 'string' && NOTIFICATION_SOUNDS.has(value as NotificationSound)
    ? value as NotificationSound
    : fallback;
}

function readNotificationVolume(value: unknown, fallback: number): number {
  const volume = Number(value);
  return Number.isInteger(volume) && volume >= 10 && volume <= 100 && volume % 5 === 0 ? volume : fallback;
}

export function getNotificationPreferencesFromDatabase(db: Pick<SQLiteDB, 'get'>, userId: string): NotificationPreferences {
  const row = db.get('SELECT * FROM user_notification_preferences WHERE user_id = ?', [userId]);
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    desktopSystemEnabled: row.desktop_system_enabled === 1,
    desktopSoundEnabled: row.desktop_sound_enabled === 1,
    desktopSessionEndSystemEnabled: row.desktop_session_end_system_enabled === 1,
    desktopSessionEndSoundEnabled: row.desktop_session_end_sound_enabled === 1,
    mobileSystemEnabled: row.mobile_system_enabled === 1,
    mobileSoundEnabled: row.mobile_sound_enabled === 1,
    mobileSessionEndSystemEnabled: row.mobile_session_end_system_enabled === 1,
    mobileSessionEndSoundEnabled: row.mobile_session_end_sound_enabled === 1,
    approvalSound: readNotificationSound(row.approval_sound, DEFAULT_NOTIFICATION_PREFERENCES.approvalSound),
    sessionEndSound: readNotificationSound(row.session_end_sound, DEFAULT_NOTIFICATION_PREFERENCES.sessionEndSound),
    desktopSoundVolume: readNotificationVolume(row.desktop_sound_volume, DEFAULT_NOTIFICATION_PREFERENCES.desktopSoundVolume),
    mobileSoundVolume: readNotificationVolume(row.mobile_sound_volume, DEFAULT_NOTIFICATION_PREFERENCES.mobileSoundVolume),
  };
}

export function updateNotificationPreferencesInDatabase(
  db: Pick<SQLiteDB, 'get' | 'run' | 'saveToFile'>,
  userId: string,
  updates: NotificationPreferencesUpdate,
  now = Date.now(),
): NotificationPreferences {
  const current = getNotificationPreferencesFromDatabase(db, userId);
  const next = { ...current, ...updates };
  db.run(`
    INSERT INTO user_notification_preferences (
      user_id, desktop_system_enabled, desktop_sound_enabled,
      desktop_session_end_system_enabled, desktop_session_end_sound_enabled,
      mobile_system_enabled, mobile_sound_enabled,
      mobile_session_end_system_enabled, mobile_session_end_sound_enabled,
      approval_sound, session_end_sound, desktop_sound_volume, mobile_sound_volume,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      desktop_system_enabled = excluded.desktop_system_enabled,
      desktop_sound_enabled = excluded.desktop_sound_enabled,
      desktop_session_end_system_enabled = excluded.desktop_session_end_system_enabled,
      desktop_session_end_sound_enabled = excluded.desktop_session_end_sound_enabled,
      mobile_system_enabled = excluded.mobile_system_enabled,
      mobile_sound_enabled = excluded.mobile_sound_enabled,
      mobile_session_end_system_enabled = excluded.mobile_session_end_system_enabled,
      mobile_session_end_sound_enabled = excluded.mobile_session_end_sound_enabled,
      approval_sound = excluded.approval_sound,
      session_end_sound = excluded.session_end_sound,
      desktop_sound_volume = excluded.desktop_sound_volume,
      mobile_sound_volume = excluded.mobile_sound_volume,
      updated_at = excluded.updated_at
  `, [
    userId,
    Number(next.desktopSystemEnabled),
    Number(next.desktopSoundEnabled),
    Number(next.desktopSessionEndSystemEnabled),
    Number(next.desktopSessionEndSoundEnabled),
    Number(next.mobileSystemEnabled),
    Number(next.mobileSoundEnabled),
    Number(next.mobileSessionEndSystemEnabled),
    Number(next.mobileSessionEndSoundEnabled),
    next.approvalSound,
    next.sessionEndSound,
    next.desktopSoundVolume,
    next.mobileSoundVolume,
    now,
  ]);
  db.saveToFile();
  return next;
}

export function getNotificationPreferences(userId: string): NotificationPreferences {
  return getNotificationPreferencesFromDatabase(getDB(), userId);
}

export function updateNotificationPreferences(userId: string, updates: NotificationPreferencesUpdate): NotificationPreferences {
  return updateNotificationPreferencesInDatabase(getDB(), userId, updates);
}

// ---------- Authentication ----------

export function createUserInDatabase(
  db: Pick<SQLiteDB, 'run' | 'saveToFile'>,
  username: string,
  passwordHash: string,
  role: UserRole = 'member',
  now = Date.now(),
  id = uuid(),
): User {
  const user: User = {
    id,
    username,
    password_hash: passwordHash,
    role,
    display_name: null,
    avatar_mime: null,
    avatar_data: null,
    avatar_updated_at: null,
    default_project_id: null,
    default_engine: 'codex',
    default_model_id: null,
    must_change_password: 0,
    disabled_at: null,
    created_at: now,
    updated_at: now,
  };
  db.run(
    'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [user.id, user.username, user.password_hash, user.role, user.created_at, user.updated_at],
  );
  db.saveToFile();
  return user;
}

export function createMemberWithDefaultProjectInDatabase(
  db: Pick<SQLiteDB, 'run' | 'get' | 'exec' | 'saveToFile'>,
  input: {
    username: string;
    passwordHash: string;
    displayName?: string | null;
    workspacePath: string;
    canCreateProject?: boolean;
    projectIds?: string[];
    now?: number;
    userId?: string;
    projectId?: string;
  },
): { user: User; project: Project } {
  const now = input.now ?? Date.now();
  const userId = input.userId ?? uuid();
  const projectId = input.projectId ?? uuid();
  const normalizedPath = normalizeProjectPathForOwnership(input.workspacePath);
  db.exec('BEGIN');
  try {
    db.run(
      `INSERT INTO users
       (id, username, password_hash, role, display_name, default_project_id,
        must_change_password, disabled_at, can_create_project, created_at, updated_at)
       VALUES (?, ?, ?, 'member', ?, NULL, 1, NULL, ?, ?, ?)`,
      [userId, input.username, input.passwordHash, input.displayName ?? null, input.canCreateProject === false ? 0 : 1, now, now],
    );
    db.run(
      `INSERT INTO projects
       (id, name, path, normalized_path, owner_user_id, created_at, updated_at,
        pinned, pinned_at, is_system, deleted_at)
       VALUES (?, 'Relay 默认项目', ?, ?, ?, ?, ?, 0, NULL, 1, NULL)`,
      [projectId, input.workspacePath, normalizedPath, userId, now, now],
    );
    db.run('UPDATE users SET default_project_id = ? WHERE id = ?', [projectId, userId]);
    for (const sharedProjectId of input.projectIds ?? []) db.run('INSERT OR IGNORE INTO project_members (project_id, user_id, role, can_view_sessions, created_at, updated_at) VALUES (?, ?, \'collaborator\', 0, ?, ?)', [sharedProjectId, userId, now, now]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.saveToFile();
  return {
    user: db.get('SELECT * FROM users WHERE id = ?', [userId]) as User,
    project: db.get('SELECT * FROM projects WHERE id = ?', [projectId]) as Project,
  };
}

export function createMemberWithDefaultProject(input: {
  username: string;
  passwordHash: string;
  displayName?: string | null;
  workspacePath: string;
  canCreateProject?: boolean;
  projectIds?: string[];
}): { user: User; project: Project } {
  return createMemberWithDefaultProjectInDatabase(getDB(), input);
}

export function getUserDefaultProjectInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  userId: string,
): Project | undefined {
  return db.get(
    `SELECT projects.*
     FROM users
     JOIN projects ON projects.id = users.default_project_id
     WHERE users.id = ?
       AND projects.deleted_at IS NULL
       AND (
         projects.owner_user_id = users.id
         OR EXISTS (
           SELECT 1 FROM project_members pm
           WHERE pm.project_id = projects.id
             AND pm.user_id = users.id
             AND pm.role IN ('collaborator', 'manager')
         )
       )`,
    [userId],
  ) as Project | undefined;
}

export function getUserDefaultProject(userId: string): Project | undefined {
  return getUserDefaultProjectInDatabase(getDB(), userId);
}

export function setUserDefaultProjectInDatabase(
  db: Pick<SQLiteDB, 'get' | 'run' | 'saveToFile'>,
  userId: string,
  projectId: string,
  now = Date.now(),
): Project {
  const project = db.get(
    `SELECT * FROM projects
     WHERE id = ?
       AND deleted_at IS NULL
       AND (
         owner_user_id = ?
         OR EXISTS (
           SELECT 1 FROM project_members pm
           WHERE pm.project_id = projects.id
             AND pm.user_id = ?
             AND pm.role IN ('collaborator', 'manager')
         )
       )`,
    [projectId, userId, userId],
  ) as Project | undefined;
  if (!project) throw new Error('默认项目必须是账号可创建会话的有效项目');
  db.run('UPDATE users SET default_project_id = ?, updated_at = ? WHERE id = ?', [projectId, now, userId]);
  db.saveToFile();
  return project;
}

export function setUserDefaultProject(userId: string, projectId: string): Project {
  return setUserDefaultProjectInDatabase(getDB(), userId, projectId);
}

export function setUserDefaultEngineInDatabase(
  db: Pick<SQLiteDB, 'run' | 'get' | 'saveToFile'>,
  userId: string,
  engine: EngineId,
  now = Date.now(),
): User {
  db.run(
    `UPDATE users SET default_model_id = CASE WHEN default_engine = ? THEN default_model_id ELSE NULL END,
      default_reasoning_effort = CASE WHEN default_engine = ? THEN default_reasoning_effort ELSE NULL END,
      default_service_tier = CASE WHEN default_engine = ? THEN default_service_tier ELSE NULL END,
      default_engine = ?, updated_at = ? WHERE id = ?`,
    [engine, engine, engine, engine, now, userId],
  );
  db.saveToFile();
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]) as User | undefined;
  if (!user) throw new Error('用户不存在');
  return user;
}

export function setUserDefaultEngine(userId: string, engine: EngineId): User {
  return setUserDefaultEngineInDatabase(getDB(), userId, engine);
}

export function setUserDefaultModelInDatabase(
  db: Pick<SQLiteDB, 'run' | 'get' | 'saveToFile'>,
  userId: string,
  modelId: string | null,
  now = Date.now(),
  preferences: { reasoningEffort?: string | null; serviceTier?: string | null } = {},
): User {
  const current = db.get('SELECT * FROM users WHERE id = ?', [userId]) as User | undefined;
  if (!current) throw new Error('用户不存在');
  const resolved = resolveModelPreferenceChange({ modelId: current.default_model_id ?? null,
    reasoningEffort: current.default_reasoning_effort ?? null, serviceTier: current.default_service_tier ?? null }, { modelId, ...preferences });
  db.run('UPDATE users SET default_model_id = ?, default_reasoning_effort = ?, default_service_tier = ?, updated_at = ? WHERE id = ?',
    [modelId, resolved.reasoningEffort, resolved.serviceTier, now, userId]);
  db.saveToFile();
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]) as User | undefined;
  if (!user) throw new Error('用户不存在');
  return user;
}

export function setUserDefaultModel(userId: string, modelId: string | null, preferences?: { reasoningEffort?: string | null; serviceTier?: string | null }): User {
  return setUserDefaultModelInDatabase(getDB(), userId, modelId, Date.now(), preferences);
}

export function createUser(username: string, passwordHash: string, role: UserRole = 'member'): User {
  return createUserInDatabase(getDB(), username, passwordHash, role);
}

export function setUserRole(userId: string, role: UserRole): User {
  const db = getDB();
  const updatedAt = Date.now();
  db.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [role, updatedAt, userId]);
  db.saveToFile();
  const user = getUserById(userId);
  if (!user) throw new Error('用户不存在');
  return user;
}

export function getUserByUsername(username: string): User | undefined {
  return getDB().get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username]) as User | undefined;
}

export function getUserById(id: string): User | undefined {
  return getDB().get('SELECT * FROM users WHERE id = ?', [id]) as User | undefined;
}

export function listUsers(): User[] {
  return getDB().all('SELECT * FROM users ORDER BY created_at ASC') as unknown as User[];
}

export function updateUserDisplayName(userId: string, displayName: string | null): User {
  const db = getDB();
  db.run('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', [displayName, Date.now(), userId]);
  db.saveToFile();
  const user = getUserById(userId);
  if (!user) throw new Error('用户不存在');
  return user;
}

export function updateUserUsernameAndDeleteOtherSessions(
  userId: string,
  username: string,
  retainedTokenHash: string,
): { user: User; tokenHashes: string[] } {
  return updateUserUsernameAndDeleteOtherSessionsInDatabase(getDB(), userId, username, retainedTokenHash);
}

export function updateUserUsernameAndDeleteOtherSessionsInDatabase(
  db: Pick<SQLiteDB, 'all' | 'exec' | 'get' | 'run' | 'saveToFile'>,
  userId: string,
  username: string,
  retainedTokenHash: string,
): { user: User; tokenHashes: string[] } {
  let tokenHashes: string[] = [];
  db.exec('BEGIN');
  try {
    db.run('UPDATE users SET username = ?, updated_at = ? WHERE id = ?', [username, Date.now(), userId]);
    tokenHashes = db.all(
      'SELECT token_hash FROM auth_sessions WHERE user_id = ? AND token_hash <> ?',
      [userId, retainedTokenHash],
    ).map((row) => String(row.token_hash));
    db.run('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?', [userId, retainedTokenHash]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.saveToFile();
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]) as User | undefined;
  if (!user) throw new Error('用户不存在');
  return { user, tokenHashes };
}

export function updateUserAvatar(userId: string, mime: string | null, data: Uint8Array | null): User {
  const db = getDB();
  const avatarUpdatedAt = data ? Date.now() : null;
  db.run(
    'UPDATE users SET avatar_mime = ?, avatar_data = ?, avatar_updated_at = ?, updated_at = ? WHERE id = ?',
    [mime, data, avatarUpdatedAt, Date.now(), userId],
  );
  db.saveToFile();
  const user = getUserById(userId);
  if (!user) throw new Error('用户不存在');
  return user;
}

export function updateUserPassword(userId: string, passwordHash: string, mustChangePassword = false): User {
  const db = getDB();
  db.run(
    'UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
    [passwordHash, Number(mustChangePassword), Date.now(), userId],
  );
  db.saveToFile();
  const user = getUserById(userId);
  if (!user) throw new Error('用户不存在');
  return user;
}

export function setUserDisabled(userId: string, disabledAt: number | null): User {
  const db = getDB();
  if (disabledAt == null) {
    db.run('UPDATE users SET disabled_at = NULL, updated_at = ? WHERE id = ?', [Date.now(), userId]);
  } else {
    disableUserAndCancelQueuedTurnsInDatabase(db, { userId, disabledAt, idFactory: uuid });
  }
  db.saveToFile();
  const user = getUserById(userId);
  if (!user) throw new Error('用户不存在');
  return user;
}

export function setUserCanCreateProject(userId: string, allowed: boolean): User {
  const db = getDB();
  db.run('UPDATE users SET can_create_project = ?, updated_at = ? WHERE id = ?', [allowed ? 1 : 0, Date.now(), userId]);
  db.saveToFile();
  const user = getUserById(userId);
  if (!user) throw new Error('user not found');
  return user;
}

export function createAuthSession(session: AuthSession): void {
  const db = getDB();
  db.run(
    'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [session.token_hash, session.user_id, session.created_at, session.expires_at],
  );
  db.saveToFile();
}

export function getAuthSession(tokenHash: string): AuthSession | undefined {
  return getDB().get('SELECT * FROM auth_sessions WHERE token_hash = ?', [tokenHash]) as AuthSession | undefined;
}

export function getAuthenticatedUser(tokenHash: string, now = Date.now()): User | undefined {
  return getDB().get(
    `SELECT users.*
     FROM auth_sessions
     JOIN users ON users.id = auth_sessions.user_id
     WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
       AND users.disabled_at IS NULL`,
    [tokenHash, now],
  ) as User | undefined;
}

export function deleteAuthSession(tokenHash: string): void {
  const db = getDB();
  db.run('DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
  db.saveToFile();
}

export function deleteAuthSessionsByUserId(userId: string): string[] {
  const db = getDB();
  const tokenHashes = db.all('SELECT token_hash FROM auth_sessions WHERE user_id = ?', [userId])
    .map((row) => String(row.token_hash));
  db.run('DELETE FROM auth_sessions WHERE user_id = ?', [userId]);
  db.saveToFile();
  return tokenHashes;
}

export function deleteExpiredAuthSessions(now = Date.now()): void {
  deleteExpiredAuthSessionsInDatabase(getDB(), now);
}

export function deleteExpiredAuthSessionsInDatabase(db: Pick<SQLiteDB, 'run' | 'get' | 'saveToFile'>, now: number): void {
  db.run('DELETE FROM auth_sessions WHERE expires_at <= ?', [now]);
  if (Number(db.get('SELECT changes() AS count')?.count ?? 0) > 0) db.saveToFile();
}

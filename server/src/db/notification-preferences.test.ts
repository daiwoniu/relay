import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { ensureNotificationPreferenceColumns, SQLiteDB } from './index.js';
import { getNotificationPreferencesFromDatabase, updateNotificationPreferencesInDatabase } from './queries.js';

const defaults = {
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

test('旧通知偏好表补齐会话结束、音色和音量字段', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, ':memory:');
  try {
    raw.exec(`CREATE TABLE user_notification_preferences (
      user_id TEXT PRIMARY KEY,
      desktop_system_enabled INTEGER NOT NULL DEFAULT 0,
      desktop_sound_enabled INTEGER NOT NULL DEFAULT 0,
      mobile_system_enabled INTEGER NOT NULL DEFAULT 0,
      mobile_sound_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
    raw.exec("INSERT INTO user_notification_preferences VALUES ('legacy-user', 1, 0, 0, 1, 123)");
    const added = ensureNotificationPreferenceColumns(db);
    assert.deepEqual(added, [
      'desktop_session_end_system_enabled', 'desktop_session_end_sound_enabled',
      'mobile_session_end_system_enabled', 'mobile_session_end_sound_enabled',
      'approval_sound', 'session_end_sound', 'desktop_sound_volume', 'mobile_sound_volume',
    ]);
    assert.deepEqual(getNotificationPreferencesFromDatabase(db, 'legacy-user'), {
      ...defaults,
      desktopSystemEnabled: true,
      mobileSoundEnabled: true,
    });
    assert.deepEqual(ensureNotificationPreferenceColumns(db), []);
  } finally {
    raw.close();
  }
});

test('通知偏好首次读取使用安全默认值，部分更新保留其他字段', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notification-preferences-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);
  try {
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE user_notification_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        desktop_system_enabled INTEGER NOT NULL DEFAULT 0,
        desktop_sound_enabled INTEGER NOT NULL DEFAULT 0,
        desktop_session_end_system_enabled INTEGER NOT NULL DEFAULT 0,
        desktop_session_end_sound_enabled INTEGER NOT NULL DEFAULT 0,
        mobile_system_enabled INTEGER NOT NULL DEFAULT 0,
        mobile_sound_enabled INTEGER NOT NULL DEFAULT 0,
        mobile_session_end_system_enabled INTEGER NOT NULL DEFAULT 0,
        mobile_session_end_sound_enabled INTEGER NOT NULL DEFAULT 0,
        approval_sound TEXT NOT NULL DEFAULT 'gentle_dual',
        session_end_sound TEXT NOT NULL DEFAULT 'crisp',
        desktop_sound_volume INTEGER NOT NULL DEFAULT 45,
        mobile_sound_volume INTEGER NOT NULL DEFAULT 80,
        updated_at INTEGER NOT NULL
      );
    `);
    db.run("INSERT INTO users (id) VALUES ('user-1')");
    assert.deepEqual(getNotificationPreferencesFromDatabase(db, 'user-1'), defaults);
    assert.deepEqual(updateNotificationPreferencesInDatabase(db, 'user-1', { desktopSystemEnabled: true }, 123), {
      ...defaults, desktopSystemEnabled: true,
    });
    assert.deepEqual(updateNotificationPreferencesInDatabase(db, 'user-1', {
      mobileSessionEndSoundEnabled: true,
      approvalSound: 'high_dual',
      desktopSoundVolume: 65,
    }, 456), {
      ...defaults,
      desktopSystemEnabled: true,
      mobileSessionEndSoundEnabled: true,
      approvalSound: 'high_dual',
      desktopSoundVolume: 65,
    });
    assert.deepEqual(db.get("SELECT * FROM user_notification_preferences WHERE user_id = 'user-1'"), {
      user_id: 'user-1',
      desktop_system_enabled: 1,
      desktop_sound_enabled: 0,
      desktop_session_end_system_enabled: 0,
      desktop_session_end_sound_enabled: 0,
      mobile_system_enabled: 0,
      mobile_sound_enabled: 0,
      mobile_session_end_system_enabled: 0,
      mobile_session_end_sound_enabled: 1,
      approval_sound: 'high_dual',
      session_end_sound: 'crisp',
      desktop_sound_volume: 65,
      mobile_sound_volume: 80,
      updated_at: 456,
    });
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

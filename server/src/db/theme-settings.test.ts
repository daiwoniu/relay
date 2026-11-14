import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { ensureThemeSettingColumns, SQLiteDB } from './index.js';
import { getThemeSettingsFromDatabase, saveThemeSettingsInDatabase } from './queries.js';
import { createDefaultThemeSettings, parseThemeSettings, projectThemeSettingsV1 } from '../theme/theme-settings.js';

test('高级主题按账号隔离保存并在缺失时返回默认值', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-theme-settings-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);
  try {
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE user_theme_settings (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    assert.deepEqual(ensureThemeSettingColumns(db), ['color_style', 'text_scale']);
    assert.deepEqual(ensureThemeSettingColumns(db), []);
    db.run("INSERT INTO users (id) VALUES ('user-1')");
    db.run("INSERT INTO users (id) VALUES ('user-2')");
    const legacy = projectThemeSettingsV1(parseThemeSettings({
      ...createDefaultThemeSettings(),
      linkedProfiles: false,
      mobile: { ...createDefaultThemeSettings().mobile, backgroundKind: 'preset', backgroundValue: 'mist' },
    }, 123));
    db.run(
      'INSERT INTO user_theme_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)',
      ['user-2', JSON.stringify(legacy), legacy.updatedAt],
    );
    assert.deepEqual(getThemeSettingsFromDatabase(db, 'user-1'), createDefaultThemeSettings());
    assert.deepEqual(getThemeSettingsFromDatabase(db, 'user-2'), {
      ...legacy,
      version: 2,
      colorStyle: 'neutral',
      textScale: 'standard',
    });
    const next = parseThemeSettings({
      ...createDefaultThemeSettings(),
      colorStyle: 'aurora',
      textScale: 'large',
      linkedProfiles: false,
      desktop: { ...createDefaultThemeSettings().desktop, backgroundKind: 'preset', backgroundValue: 'forest' },
    }, 456);
    saveThemeSettingsInDatabase(db, 'user-1', next);
    assert.deepEqual(getThemeSettingsFromDatabase(db, 'user-1'), next);
    const stored = db.get("SELECT settings_json, color_style, text_scale FROM user_theme_settings WHERE user_id = 'user-1'");
    assert.equal(JSON.parse(String(stored?.settings_json)).version, 1);
    assert.equal(stored?.color_style, 'aurora');
    assert.equal(stored?.text_scale, 'large');
    assert.throws(() => db.run("UPDATE user_theme_settings SET color_style = 'invalid' WHERE user_id = 'user-1'"));
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

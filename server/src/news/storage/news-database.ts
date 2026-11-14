import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

let sqlPromise: Promise<SqlJsStatic> | null = null;

export function loadSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: () => path.resolve('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
  return sqlPromise;
}

export function openDatabase(SQL: SqlJsStatic, filename: string): Database {
  return fs.existsSync(filename)
    ? new SQL.Database(fs.readFileSync(filename))
    : new SQL.Database();
}

export function persistDatabase(filename: string, database: Database): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, Buffer.from(database.export()));
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function queryRows(database: Database, sql: string, params: Array<string | number | null> = []): Record<string, unknown>[] {
  const statement = database.prepare(sql);
  try {
    statement.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

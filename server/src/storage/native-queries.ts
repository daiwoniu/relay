import type { DatabaseSync } from 'node:sqlite';
import { StorageContractError } from './command-boundary.js';

/** Worker-local compatibility bridge, not an RPC surface. Nested legacy transactions use savepoints. */
export function nativeQueries(database: DatabaseSync) {
  const stack: string[] = [];
  let serial = 0;
  const bind = (values: any[]) => values.map((value) => {
    if (typeof value === 'boolean') return Number(value);
    if (value === null || typeof value === 'string' || value instanceof Uint8Array || typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    throw new StorageContractError('INVALID_ARGUMENT');
  });
  return {
    get: (sql: string, params: any[] = []): Record<string, any> | undefined => database.prepare(sql).get(...bind(params)),
    all: (sql: string, params: any[] = []): Record<string, any>[] => database.prepare(sql).all(...bind(params)),
    // Worker-local streaming only. This is never exposed through RPC.
    iterate: (sql: string, params: any[] = []): Iterable<Record<string, any>> => database.prepare(sql).iterate(...bind(params)),
    run: (sql: string, params: any[] = []): void => { database.prepare(sql).run(...bind(params)); },
    exec(sql: string) {
      const normalized = sql.trim().replace(/;$/, '').toUpperCase();
      if (normalized === 'BEGIN' || normalized === 'BEGIN IMMEDIATE') {
        const name = `_relay_business_${++serial}`;
        database.exec(`SAVEPOINT ${name}`); stack.push(name);
      } else if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        const name = stack.at(-1);
        if (!name) throw new StorageContractError('CONFLICT');
        if (normalized === 'ROLLBACK') database.exec(`ROLLBACK TO ${name}`);
        database.exec(`RELEASE ${name}`); stack.pop();
      } else database.exec(sql);
    },
    saveToFile() { if (!database.isTransaction) throw new StorageContractError('STORAGE_UNAVAILABLE'); },
    scheduleSaveToFile() { if (!database.isTransaction) throw new StorageContractError('STORAGE_UNAVAILABLE'); },
  };
}

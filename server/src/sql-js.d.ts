declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export interface Statement {
    bind(values?: any[] | Record<string, any>): boolean;
    step(): boolean;
    getAsObject(params?: any[] | Record<string, any> | null, config?: { useBigInt?: boolean }): Record<string, any>;
    free(): boolean;
  }

  export class Database {
    constructor(data?: ArrayLike<number>);
    run(sql: string, params?: any[] | Record<string, any>): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string, params?: any[] | Record<string, any>): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}

import path from 'node:path';
import type { Database } from 'sql.js';
import { loadSql,openDatabase,persistDatabase } from './news-database.js';
import { NewsRepository } from './news-repository-core.js';
export * from './news-repository-core.js';

export async function openNewsRepository(dataDir: string, options: { persistDatabase?: typeof persistDatabase } = {}): Promise<NewsRepository> {
  const SQL = await loadSql();
  let metadata: Database | null = null;
  let error: string | null = null;
  try {
    metadata = openDatabase(SQL, path.join(dataDir, 'news.db'));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const repository = new NewsRepository(dataDir, {open: filename=>openDatabase(SQL,filename),persist: (filename,database)=>(options.persistDatabase??persistDatabase)(filename,database as Database)}, metadata, error);
  await repository.initialize();
  return repository;
}

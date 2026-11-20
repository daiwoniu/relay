import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { initializeLocalStorage } from './local-storage-initializer.js';
import { NativeStore } from './native-store.js';
import { initializeNewsMetadataSchema } from '../news/storage/news-repository-core.js';
import type { NewsDatabase } from '../news/storage/news-storage-driver.js';

const schema=fs.readFileSync(new URL('./application-schema-v1.sql',import.meta.url),'utf8');
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-local-initialize-')),filename=path.join(root,'relay.db');
  return{root,filename,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function legacy(filename:string){
  const db=new DatabaseSync(filename);db.exec(schema);
  db.exec(`INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('owner','synthetic','hash',1,1);
    INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES('project','fixture','/synthetic','owner',1,1);
    INSERT INTO sessions(id,title,project_id,owner_user_id,created_at,updated_at) VALUES('session','保留历史','project','owner',1,1);
    INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES('message','session','turn','assistant','不能丢失的正文',1);`);
  db.prepare('UPDATE users SET avatar_data=? WHERE id=?').run(Buffer.from([0,1,255]),'owner');db.close();
}
const digest=(filename:string)=>createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

test('published Native v1 upgrades workspace links with one verified backup and no repeated migration',async()=>{
  const f=fixture();
  try{
    const first=await initializeLocalStorage(f.filename);const identity=first.storeId;await first.owner.release();
    const db=new DatabaseSync(f.filename);
    db.exec('DROP TABLE workspace_console_links; DELETE FROM _relay_storage_migrations WHERE version=2;');
    db.exec(schema.match(/CREATE TABLE workspace_console_links \([\s\S]*?\n\s*\);/)![0]);db.close();
    const upgraded=await initializeLocalStorage(f.filename);
    assert.equal(upgraded.action,'migrated');assert.equal(upgraded.storeId,identity);assert.equal(upgraded.backups.length,1);
    await upgraded.owner.release();
    const repeated=await initializeLocalStorage(f.filename);
    try{assert.equal(repeated.action,'current');assert.deepEqual(repeated.backups,[]);}finally{await repeated.owner.release();}
  }finally{f.cleanup();}
});

for (const format of ['legacy', 'native'] as const) test(`${format} startup upgrades old audit actions, preserves history and permits membership writes`, async () => {
  const f = fixture();
  try {
    legacy(f.filename);
    let identity: string | undefined;
    if (format === 'native') {
      const initial = await initializeLocalStorage(f.filename);
      identity = initial.storeId;
      await initial.owner.release();
    }
    const db = new DatabaseSync(f.filename);
    const oldAudit = schema.match(/CREATE TABLE admin_audit_events[\s\S]*?;/)![0]
      .replace("'account.project_permission','project.member_set','project.member_remove',", '');
    db.exec(`DROP TABLE admin_audit_events; ${oldAudit}
      INSERT INTO admin_audit_events VALUES('history','owner','session.delete','session','session','owner','succeeded',1);
      UPDATE users SET role='admin' WHERE id='owner';
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('candidate','candidate','synthetic',1,1);
      INSERT INTO auth_sessions VALUES('synthetic-audit-session','owner',1,${Date.now() + 600_000});`);
    const request = (storeId: string, operationId: string) => ({
      protocolVersion: 1 as const, storeId, workerGeneration: 1, requestId: operationId, operationId,
      principal: { kind: 'user' as const, userId: 'owner', authSessionHash: 'synthetic-audit-session' },
      command: { name: 'project.setMember' as const, input: { projectId: 'project', userId: 'candidate', role: 'collaborator' as const } },
    });
    if (identity) {
      const before = new NativeStore(f.filename, identity, 1);
      try { assert.equal(before.execute(request(identity, 'before-upgrade')).state, 'unknown'); }
      finally { before.close(); }
      assert.equal(db.prepare('SELECT count(*) AS n FROM project_members').get()!.n, 0);
    }
    db.close();
    const upgraded = await initializeLocalStorage(f.filename);
    try {
      assert.equal(upgraded.action, 'migrated');
      assert.equal(upgraded.backups.length, 1);
      const saved = new DatabaseSync(upgraded.backups[0], { readOnly: true });
      try {
        assert.doesNotMatch(String(saved.prepare("SELECT sql FROM sqlite_master WHERE name='admin_audit_events'").get()!.sql), /project\.member_set/);
        assert.equal(saved.prepare("SELECT count(*) AS n FROM admin_audit_events WHERE id='history'").get()!.n, 1);
      } finally { saved.close(); }
      const store = new NativeStore(f.filename, upgraded.storeId, 1);
      try { assert.equal(store.execute(request(upgraded.storeId, 'after-upgrade')).state, 'committed'); }
      finally { store.close(); }
      const current = new DatabaseSync(f.filename, { readOnly: true });
      try {
        assert.equal(current.prepare("SELECT count(*) AS n FROM admin_audit_events WHERE id='history'").get()!.n, 1);
        assert.equal(current.prepare("SELECT count(*) AS n FROM admin_audit_events WHERE action='project.member_set'").get()!.n, 1);
        assert.equal(current.prepare('SELECT count(*) AS n FROM project_members').get()!.n, 1);
        assert.equal(current.prepare("SELECT content FROM messages WHERE id='message'").get()!.content, '不能丢失的正文');
      } finally { current.close(); }
    } finally { await upgraded.owner.release(); }
    const repeated = await initializeLocalStorage(f.filename);
    try { assert.equal(repeated.action, 'current'); assert.deepEqual(repeated.backups, []); }
    finally { await repeated.owner.release(); }
  } finally { f.cleanup(); }
});

test('fresh install initializes Native and news directly; restart preserves identity and creates no repeated backup',async()=>{
  const f=fixture();
  try{
    const first=await initializeLocalStorage(f.filename);
    assert.equal(first.action,'created');assert.deepEqual(first.backups,[]);
    const identity=first.storeId;
    await assert.rejects(initializeLocalStorage(f.filename),/CONFLICT/,'one owner spans initialization and application use');
    await first.owner.release();
    const second=await initializeLocalStorage(f.filename);
    try{
      assert.equal(second.action,'current');assert.equal(second.storeId,identity);assert.deepEqual(second.backups,[]);
      const store=new NativeStore(f.filename,identity,1);store.close();
      const main=new DatabaseSync(f.filename,{readOnly:true});
      const admin=main.prepare("SELECT default_project_id FROM users WHERE role='admin'").get();
      assert.ok(admin?.default_project_id);
      assert.equal(main.prepare('SELECT is_system FROM projects WHERE id=?').get(admin!.default_project_id as string)!.is_system,1);main.close();
      const news=new DatabaseSync(path.join(f.root,'news/news.db'),{readOnly:true});
      assert.equal(news.prepare('SELECT COUNT(*) AS n FROM _relay_news_migrations').get()!.n,1);news.close();
      assert.equal(fs.existsSync(path.join(f.root,'storage-control.db')),false);
      assert.equal(fs.existsSync(path.join(f.root,'storage-enrollment.json')),false);
    }finally{await second.owner.release();}
  }finally{f.cleanup();}
});

test('legacy upgrade backs up the original, preserves message/blob content and opens through the actual Native store',async()=>{
  const f=fixture();
  try{
    legacy(f.filename);
    const result=await initializeLocalStorage(f.filename);
    try{
      assert.equal(result.action,'migrated');assert.equal(result.backups.length,1);
      for(const filename of [f.filename,...result.backups]){
        const db=new DatabaseSync(filename,{readOnly:true});
        assert.equal(db.prepare("SELECT content FROM messages WHERE id='message'").get()!.content,'不能丢失的正文');
        assert.deepEqual(Buffer.from(db.prepare("SELECT avatar_data FROM users WHERE id='owner'").get()!.avatar_data as Uint8Array),Buffer.from([0,1,255]));
        if(filename!==f.filename)assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='_relay_storage_meta'").get(),undefined);
        db.close();
      }
      const store=new NativeStore(f.filename,result.storeId,1);store.close();
    }finally{await result.owner.release();}
  }finally{f.cleanup();}
});

test('existing Native install adds hosted sites once with backup and unchanged support migration',async()=>{
  const f=fixture();
  try{
    const first=await initializeLocalStorage(f.filename);await first.owner.release();
    const db=new DatabaseSync(f.filename),migration=db.prepare('SELECT script_digest FROM _relay_storage_migrations').get()!.script_digest;
    db.exec('DROP TABLE hosted_sites');db.close();
    const upgraded=await initializeLocalStorage(f.filename);
    assert.equal(upgraded.action,'migrated');assert.equal(upgraded.backups.length,1);await upgraded.owner.release();
    const saved=new DatabaseSync(f.filename,{readOnly:true});assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM hosted_sites').get()!.n,0);
    assert.equal(saved.prepare('SELECT script_digest FROM _relay_storage_migrations').get()!.script_digest,migration);saved.close();
    const repeated=await initializeLocalStorage(f.filename);try{assert.equal(repeated.action,'current');assert.deepEqual(repeated.backups,[]);}finally{await repeated.owner.release();}
  }finally{f.cleanup();}
});

test('existing Native install adds tools settings once with backup and unchanged support migration',async()=>{
  const f=fixture();
  try{
    const first=await initializeLocalStorage(f.filename);await first.owner.release();
    const db=new DatabaseSync(f.filename);
    const migration=db.prepare('SELECT script_digest FROM _relay_storage_migrations').get()!.script_digest;
    const users=db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n;
    db.exec('DROP TABLE user_tools_settings');db.close();
    const upgraded=await initializeLocalStorage(f.filename);
    assert.equal(upgraded.action,'migrated');assert.equal(upgraded.backups.length,1);await upgraded.owner.release();
    const saved=new DatabaseSync(f.filename,{readOnly:true});
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM user_tools_settings').get()!.n,0);
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM users').get()!.n,users);
    assert.equal(saved.prepare('SELECT script_digest FROM _relay_storage_migrations').get()!.script_digest,migration);saved.close();
    const repeated=await initializeLocalStorage(f.filename);
    try{assert.equal(repeated.action,'current');assert.deepEqual(repeated.backups,[]);}finally{await repeated.owner.release();}
  }finally{f.cleanup();}
});

test('existing Native install adds preview preferences once and preserves users and support migration',async()=>{
  const f=fixture();
  try{
    const first=await initializeLocalStorage(f.filename);await first.owner.release();
    const db=new DatabaseSync(f.filename);
    const migration=db.prepare('SELECT script_digest FROM _relay_storage_migrations').get()!.script_digest;
    const users=db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n;
    db.exec('DROP TABLE user_preview_preferences');db.close();
    const upgraded=await initializeLocalStorage(f.filename);
    assert.equal(upgraded.action,'migrated');assert.equal(upgraded.backups.length,1);await upgraded.owner.release();
    const saved=new DatabaseSync(f.filename,{readOnly:true});
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM user_preview_preferences').get()!.n,0);
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM users').get()!.n,users);
    assert.equal(saved.prepare('SELECT script_digest FROM _relay_storage_migrations').get()!.script_digest,migration);saved.close();
    const repeated=await initializeLocalStorage(f.filename);
    try{assert.equal(repeated.action,'current');assert.deepEqual(repeated.backups,[]);}finally{await repeated.owner.release();}
  }finally{f.cleanup();}
});

test('unknown Native version refuses startup without backups or data replacement',async()=>{
  const f=fixture();
  try{
    const first=await initializeLocalStorage(f.filename);await first.owner.release();
    const db=new DatabaseSync(f.filename);db.exec('UPDATE _relay_storage_migrations SET version=version+999');db.close();
    const before=digest(f.filename);
    await assert.rejects(initializeLocalStorage(f.filename));
    assert.equal(digest(f.filename),before);
    assert.equal(fs.readdirSync(f.root).some(name=>name.endsWith('.bak')),false);
  }finally{f.cleanup();}
});

test('corrupt, empty and unsupported legacy files are never treated as a new installation',async()=>{
  for(const kind of ['corrupt','empty','old']){
    const f=fixture();
    try{
      if(kind==='old'){const db=new DatabaseSync(f.filename);db.exec('CREATE TABLE users(id TEXT PRIMARY KEY)');db.close();}
      else fs.writeFileSync(f.filename,kind==='empty'?'':'invalid SQLite');
      const before=digest(f.filename);await assert.rejects(initializeLocalStorage(f.filename));
      assert.equal(digest(f.filename),before);assert.equal(fs.readdirSync(f.root).some(name=>name.endsWith('.bak')),false);
    }finally{f.cleanup();}
  }
});

test('foreign key violations stop migration before backup or schema writes',async()=>{
  const f=fixture();
  try{
    legacy(f.filename);const db=new DatabaseSync(f.filename);db.exec("PRAGMA foreign_keys=OFF;UPDATE messages SET session_id='absent'");db.close();
    const before=digest(f.filename);await assert.rejects(initializeLocalStorage(f.filename),/STORAGE_FOREIGN_KEYS_FAILED/);
    assert.equal(digest(f.filename),before);
  }finally{f.cleanup();}
});

test('news migration failure rolls back its transaction and keeps the pre-upgrade backup',async()=>{
  const f=fixture();
  try{
    legacy(f.filename);const newsRoot=path.join(f.root,'news');fs.mkdirSync(newsRoot);
    const newsPath=path.join(newsRoot,'news.db'),db=new DatabaseSync(newsPath);
    const bridge={exec:(sql:string)=>db.exec(sql),prepare:(sql:string)=>{
      let rows:Record<string,unknown>[]=[],index=-1;
      return{bind:()=>{rows=db.prepare(sql).all();},step:()=>++index<rows.length,getAsObject:()=>rows[index],free:()=>{}};
    }} as unknown as NewsDatabase;
    initializeNewsMetadataSchema(bridge);db.exec("DELETE FROM news_categories WHERE id='other'");db.close();
    await assert.rejects(initializeLocalStorage(f.filename),/STORAGE_MIGRATION_CONTENT_CHANGED/);
    const after=new DatabaseSync(newsPath,{readOnly:true});
    assert.equal(after.prepare("SELECT 1 FROM news_categories WHERE id='other'").get(),undefined);
    assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name='_relay_news_migrations'").get(),undefined);after.close();
    assert.equal(fs.readdirSync(newsRoot).filter(name=>name.endsWith('.bak')).length,1);
    const repaired=new DatabaseSync(newsPath);repaired.exec("INSERT INTO news_categories VALUES('other','其他')");repaired.close();
    const retry=await initializeLocalStorage(f.filename);
    try{assert.equal(retry.action,'current');}finally{await retry.owner.release();}
  }finally{f.cleanup();}
});

test('a missing main database with existing installation evidence is never recreated',async()=>{
  for(const entry of ['news','theme-assets','page-hosting','relay.db.pre-native-v1-synthetic.bak','relay.db-wal','relay.db.relay-owner']){
    const f=fixture();
    try{
      const evidence=path.join(f.root,entry);
      if(['news','theme-assets','page-hosting','relay.db.relay-owner'].includes(entry))fs.mkdirSync(evidence);else fs.writeFileSync(evidence,'synthetic prior data');
      await assert.rejects(initializeLocalStorage(f.filename),/STORAGE_MAIN_DATABASE_MISSING/);
      assert.equal(fs.existsSync(f.filename),false);assert.equal(fs.existsSync(evidence),true);
    }finally{f.cleanup();}
  }
});

test('an existing Native installation cannot replace a missing news metadata file or directory',async()=>{
  for(const missing of ['file','directory']){
    const f=fixture();
    try{
      const initial=await initializeLocalStorage(f.filename);await initial.owner.release();
      const original=missing==='file'?path.join(f.root,'news/news.db'):path.join(f.root,'news');
      fs.renameSync(original,path.join(f.root,'preserved-news'));
      await assert.rejects(initializeLocalStorage(f.filename),/NEWS_METADATA_MISSING/);
      assert.equal(fs.existsSync(original),false);
    }finally{f.cleanup();}
  }
});

test('a missing month with recorded items refuses startup; an empty recorded month does not fabricate historical data',async()=>{
  const f=fixture();
  try{
    const initial=await initializeLocalStorage(f.filename);await initial.owner.release();
    const metadataPath=path.join(f.root,'news/news.db'),db=new DatabaseSync(metadataPath);
    db.exec("INSERT INTO news_shard_stats VALUES('2026-11',1)");db.close();
    await assert.rejects(initializeLocalStorage(f.filename),/NEWS_SHARD_MISSING/);
    assert.equal(fs.existsSync(path.join(f.root,'news/news-2026-11.db')),false);
    const empty=new DatabaseSync(metadataPath);empty.exec('UPDATE news_shard_stats SET item_count=0');empty.close();
    const next=await initializeLocalStorage(f.filename);await next.owner.release();
    assert.equal(fs.existsSync(path.join(f.root,'news/news-2026-11.db')),false);
  }finally{f.cleanup();}
});

test('Worker creation failure cleans only its own empty new file and permits retry',async()=>{
  for(const content of ['', 'nonempty data must be retained']){
    const f=fixture(),Original=workerThreads.Worker;
    try{
      workerThreads.Worker=class{constructor(){if(content)fs.writeFileSync(f.filename,content);throw Error('SYNTHETIC_WORKER_RESOURCE_ERROR');}} as any;
      syncBuiltinESMExports();
      try{await assert.rejects(initializeLocalStorage(f.filename),/SYNTHETIC_WORKER_RESOURCE_ERROR/);}
      finally{workerThreads.Worker=Original;syncBuiltinESMExports();}
      if(content)assert.equal(fs.readFileSync(f.filename,'utf8'),content);
      else{
        assert.equal(fs.existsSync(f.filename),false);
        const retry=await initializeLocalStorage(f.filename);assert.equal(retry.action,'created');await retry.owner.release();
      }
    }finally{workerThreads.Worker=Original;syncBuiltinESMExports();f.cleanup();}
  }
});

test('two concurrent first starts keep one owner and leave a usable initialized database',async()=>{
  const f=fixture(),outcomes=await Promise.allSettled([initializeLocalStorage(f.filename),initializeLocalStorage(f.filename)]);
  try{
    assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
    const winner=outcomes.find(result=>result.status==='fulfilled');assert.ok(winner?.status==='fulfilled');
    const identity=winner.value.storeId;await winner.value.owner.release();
    const retry=await initializeLocalStorage(f.filename);
    try{assert.equal(retry.action,'current');assert.equal(retry.storeId,identity);}finally{await retry.owner.release();}
  }finally{
    for(const result of outcomes)if(result.status==='fulfilled')await result.value.owner.release();
    f.cleanup();
  }
});

test('legacy repair command refuses Native databases in both WAL and standalone DELETE mode',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(path.join(f.root,'unused.jsonl'),'{}\n');
    const initial=await initializeLocalStorage(f.filename);await initial.owner.release();
    for(const mode of ['wal','delete']){
      if(mode==='delete'){const db=new DatabaseSync(f.filename);db.exec('PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE');db.close();}
      const before=digest(f.filename);
      const result=spawnSync(process.execPath,['--import','tsx','scripts/repair-empty-terminal-projections.ts',
        '--db',f.filename,'--session','synthetic','--rollout',path.join(f.root,'unused.jsonl')],
        {cwd:process.cwd(),encoding:'utf8',timeout:15000});
      assert.equal(result.status,1);assert.match(result.stderr,/此旧版离线修复工具不支持/);
      assert.equal(digest(f.filename),before);
    }
  }finally{f.cleanup();}
});

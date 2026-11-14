import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initializeLocalStorage } from './local-storage-initializer.js';
import { hashSessionToken } from '../auth/session.js';
import { EngineRegistry } from '../engine/registry.js';
import type { StoredDomainDependencies } from '../stored-domain-services.js';

test('real legacy initialization migrates into the assembled application, keeps new writes across restart and independently restores old backups',async()=>{
  process.env.RELAY_STORAGE_DRIVER='native';
  process.env.RELAY_ACCESS_TOKEN='synthetic-rehearsal';
  const {createStoredApplication}=await import('../stored-application.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-migration-rehearsal-'));
  const restoredRoot=await fs.mkdtemp(path.join(os.tmpdir(),'relay-restored-rehearsal-'));
  const filename=path.join(root,'relay.db'),project=path.join(root,'project');
  const projectId=randomUUID(),sessionId=randomUUID(),messageId=randomUUID(),userId=randomUUID();
  const sessionToken='synthetic-rehearsal-user',tokenHash=hashSessionToken(sessionToken);
  const legacyCode=`
    const fs=await import('node:fs/promises'),path=await import('node:path');
    const {initDB}=await import('./src/db/index.ts');
    const {openNewsRepository}=await import('./src/news/storage/news-repository.ts');
    const root=process.env.SYNTHETIC_ROOT,db=await initDB(),now=Date.now();
    db.run('INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?)',[process.env.SYNTHETIC_USER,'rehearsal','unused-synthetic-hash','admin',now,now]);
    db.run('INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',[process.env.SYNTHETIC_PROJECT,'演练项目',path.join(root,'project'),process.env.SYNTHETIC_USER,now,now]);
    db.run('INSERT INTO sessions(id,title,project_id,owner_user_id,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?)',[process.env.SYNTHETIC_SESSION,'迁移前标题',process.env.SYNTHETIC_PROJECT,process.env.SYNTHETIC_USER,now,now,'completed']);
    db.run('INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES(?,?,?,?,?,?)',[process.env.SYNTHETIC_MESSAGE,process.env.SYNTHETIC_SESSION,'synthetic-turn','assistant','旧正文保持完整',now]);
    db.run('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',[process.env.SYNTHETIC_TOKEN_HASH,process.env.SYNTHETIC_USER,now,now+600000]);
    db.saveToFile();db.raw().close();
    await fs.mkdir(path.join(root,'news'),{recursive:true});
    const news=await openNewsRepository(path.join(root,'news'));
    if(!news.getStatus().available)throw Error(news.getStatus().error||'legacy news unavailable');
    news.saveCategory('synthetic','演练分类','synthetic');await news.close();
  `;
  let application:Awaited<ReturnType<typeof createStoredApplication>>|undefined;
  const unused=new Proxy({},{get:()=>()=>{throw Error('external provider must not be called during rehearsal');}});
  const open=async(initial:Awaited<ReturnType<typeof initializeLocalStorage>>)=>{
    const registry=new EngineRegistry([]);
    return createStoredApplication({storage:{filename:initial.owner.filename,storeId:initial.storeId,generation:Date.now()},storageOwner:initial.owner,
      runtime:{registry,collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>null,diagnostic:()=>{}},
      dependencies:async()=>({registry,themeRoot:path.join(root,'theme-assets'),repairSourceRoot:root,chinaDayCacheRoot:path.join(root,'cache'),newsRoot:path.join(root,'news'),
        newsSources:[],auth:{workspacePath:project},system:{version:unused,engines:unused,resources:unused,models:unused,recovery:unused,maintenance:unused},
        publicShares:{getClientId:()=> 'synthetic'},resources:unused,snapshots:unused,usage:unused,workspace:unused,threads:unused,fork:unused,
        fetchArchivedThreadIds:async()=>[],assertAdmission:async()=>{},attachmentAvailability:()=>false,maintenanceBusy:()=>false,diagnostic:()=>{}} as unknown as StoredDomainDependencies)});
  };
  try{
    await fs.mkdir(path.join(project,'.relay_upload/messages',messageId),{recursive:true});
    await fs.mkdir(path.join(root,'theme-assets'),{recursive:true});
    const attachment=path.join(project,'.relay_upload/messages',messageId,'synthetic.txt'),theme=path.join(root,'theme-assets','synthetic.bin');
    await fs.writeFile(attachment,'附件保持原位');await fs.writeFile(theme,Buffer.from([0,1,255]));
    const legacy=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',legacyCode],{cwd:process.cwd(),encoding:'utf8',timeout:20000,
      env:{...process.env,RELAY_STORAGE_DRIVER:'legacy',RELAY_DB_PATH:filename,SYNTHETIC_ROOT:root,SYNTHETIC_PROJECT:projectId,SYNTHETIC_SESSION:sessionId,
        SYNTHETIC_MESSAGE:messageId,SYNTHETIC_USER:userId,SYNTHETIC_TOKEN_HASH:tokenHash}});
    assert.equal(legacy.status,0,legacy.stderr);
    const initial=await initializeLocalStorage(filename,project);assert.equal(initial.action,'migrated');assert.equal(initial.backups.length,2);
    const backups=[...initial.backups],identity=initial.storeId;
    application=await open(initial);await application.activate();
    const headers={'x-relay-token':'synthetic-rehearsal',cookie:`relay_session=${sessionToken}`};
    assert.equal((await application.app.request('/api/health')).status,200);
    assert.equal((await application.app.request('/api/auth/me',{headers})).status,200);
    const messages=await application.app.request(`/api/sessions/${sessionId}/messages`,{headers});
    assert.equal(messages.status,200);assert.match(await messages.text(),/旧正文保持完整/);
    const rename=await application.app.request(`/api/sessions/${sessionId}`,{method:'PATCH',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({title:'迁移后新增修改'})});
    assert.equal(rename.status,200);
    await application.close();application=undefined;
    const restart=await initializeLocalStorage(filename,project);
    assert.equal(restart.action,'current');assert.equal(restart.storeId,identity);assert.deepEqual(restart.backups,[]);
    application=await open(restart);await application.activate();
    const after=await application.app.request(`/api/sessions/${sessionId}`,{headers});
    assert.equal(after.status,200);assert.match(await after.text(),/迁移后新增修改/);
    await application.close();application=undefined;
    for(const backup of backups){
      const relative=path.relative(root,backup.split('.pre-native-v1-')[0]!);
      const target=path.join(restoredRoot,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(backup,target);
    }
    const restoredFile=path.join(restoredRoot,'relay.db');
    const original=new DatabaseSync(restoredFile,{readOnly:true});
    try{assert.equal(original.prepare('SELECT title FROM sessions WHERE id=?').get(sessionId)!.title,'迁移前标题');
      assert.equal(original.prepare("SELECT 1 FROM sqlite_master WHERE name='_relay_storage_meta'").get(),undefined);}
    finally{original.close();}
    const restored=await initializeLocalStorage(restoredFile,path.join(restoredRoot,'project'));
    assert.equal(restored.action,'migrated');await restored.owner.release();
    const news=new DatabaseSync(path.join(restoredRoot,'news/news.db'),{readOnly:true});
    try{assert.equal(news.prepare("SELECT label FROM news_categories WHERE id='synthetic'").get()!.label,'演练分类');}finally{news.close();}
    assert.equal(await fs.readFile(attachment,'utf8'),'附件保持原位');assert.deepEqual(await fs.readFile(theme),Buffer.from([0,1,255]));
  }finally{await application?.close();await fs.rm(root,{recursive:true,force:true});await fs.rm(restoredRoot,{recursive:true,force:true});}
});

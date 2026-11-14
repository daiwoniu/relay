import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { themeAssetsFixture,actor,owner,other,gate } from '../theme/theme-assets-fixture.test-support.js';
import { createDefaultThemeSettings } from '../theme/theme-settings.js';
import { JournaledThemeAssets } from '../theme/journaled-assets.js';
import type { CoreCommand,StoragePrincipal } from '../storage/contracts.js';
const maintenance={kind:'system' as const,purpose:'maintenance' as const};
async function exists(file:string){try{await fs.lstat(file);return true;}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT')return false;throw e;}}
function command(command:CoreCommand,principal:StoragePrincipal=actor()){return{protocolVersion:1 as const,storeId:'assets-test',workerGeneration:1,requestId:randomUUID(),operationId:randomUUID(),principal,command};}

test('theme assets upload atomically publishes both verified files, reads exact bytes and deletes once',async()=>{
  const p=await themeAssetsFixture();try{const service=p.make(),key=randomUUID(),bytes=p.pair();
    const result=await service.upload(actor(),bytes,key);assert.equal(result.state,'committed');assert.ok(result.state==='committed'&&!result.cleanupPending);if(result.state!=='committed')return;
    const id=result.assetId;assert.deepEqual(await service.read(actor(),id,'desktop'),bytes.desktop);assert.deepEqual(await service.read(actor(),id,'mobile'),bytes.mobile);
    assert.equal((await p.job())!.filesFinished,true);assert.equal((await fs.stat(p.file(id))).nlink,1);
    assert.deepEqual(await p.make().upload(actor(),bytes,key),result);assert.equal(p.f.scalar("SELECT count(*) FROM _relay_theme_asset_jobs WHERE kind='upload'"),1);
    const remove=randomUUID();assert.deepEqual(await service.delete(actor(),id,remove),{state:'committed',assetId:id,cleanupPending:false});assert.equal(await exists(p.file(id)),false);assert.equal(await exists(p.file(id,'mobile')),false);
    assert.deepEqual(await service.delete(actor(),id,remove),{state:'committed',assetId:id,cleanupPending:false});assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_assets'),0);
    assert.deepEqual(await service.upload(actor(),bytes,key),{state:'rejected',code:'NOT_FOUND'});assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_assets'),0);
  }finally{await p.cleanup();}
});
test('asset ownership, referenced backgrounds and changed upload content reject without touching files',async()=>{
  const p=await themeAssetsFixture();try{const service=p.make(),key=randomUUID(),result=await service.upload(actor(),p.pair(),key);assert.equal(result.state,'committed');if(result.state!=='committed')return;const id=result.assetId;
    await assert.rejects(service.read(actor(other),id,'desktop'),{code:'NOT_FOUND'});assert.deepEqual(await service.delete(actor(other),id,randomUUID()),{state:'rejected',code:'NOT_FOUND'});
    const settings=createDefaultThemeSettings();settings.desktop.backgroundKind='asset';settings.desktop.backgroundValue=id;
    assert.equal((await p.port.execute(command({name:'account.setTheme',input:{settings}}))).state,'committed');assert.deepEqual(await service.delete(actor(),id,randomUUID()),{state:'rejected',code:'CONFLICT'});
    assert.deepEqual(await fs.readFile(p.file(id)),p.pair().desktop);
    const changed=p.pair();changed.desktop[25]=1;assert.deepEqual(await service.upload(actor(),changed,key),{state:'rejected',code:'CONFLICT'});
  }finally{await p.cleanup();}
});
test('lost commit replies recover from durable job state without repeating file publication',async()=>{
  const p=await themeAssetsFixture();try{let commits=0;const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);if(request.command.name==='themeAsset.commit'){commits++;return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};}return result;},lookup:async()=>{throw new Error('synthetic lost receipt');}} as any);
    const result=await p.make({port}).upload(actor(),p.pair(),randomUUID());assert.equal(result.state,'committed');assert.equal(commits,1);assert.equal((await p.job())!.filesFinished,true);
  }finally{await p.cleanup();}
});
test('failed upload metadata commit preserves pending files; exact retry commits after receipt rollback',async()=>{
  const p=await themeAssetsFixture();try{const service=p.make(),key=randomUUID();p.f.mutate("CREATE TRIGGER asset_commit_failure BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='themeAsset.commit' BEGIN SELECT RAISE(ABORT,'synthetic');END");
    assert.deepEqual(await service.upload(actor(),p.pair(),key),{state:'unknown'});assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_assets'),0);assert.equal((await p.job())!.phase,'prepared');
    p.f.mutate('DROP TRIGGER asset_commit_failure');const result=await service.upload(actor(),p.pair(),key);assert.equal(result.state,'committed');assert.equal((await p.job())!.filesFinished,true);
  }finally{await p.cleanup();}
});
test('maintenance rejects a prepared upload and rolls back both published variants instead of committing',async()=>{
  const p=await themeAssetsFixture();try{p.f.mutate("CREATE TRIGGER asset_commit_failure BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='themeAsset.commit' BEGIN SELECT RAISE(ABORT,'synthetic');END");
    const service=p.make();await service.upload(actor(),p.pair(),randomUUID());const job=(await p.job())!;assert.equal(await exists(p.file(job.assetId)),true);
    assert.deepEqual(await service.recover(job.jobId),{state:'rejected',code:'CONFLICT'});assert.equal((await p.job())!.filesFinished,true);assert.equal(await exists(p.file(job.assetId)),false);assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_assets'),0);
  }finally{await p.cleanup();}
});
test('partial upload publication compensates only its exact first file',async()=>{
  const p=await themeAssetsFixture();try{let failed=false;const service=p.make({assertExclusiveWriter:async()=>{if(failed||p.f.scalar('SELECT count(*) FROM _relay_theme_asset_jobs')===0)return;const job=await p.job();
      if(job&&await exists(p.file(job.assetId))&&!await exists(p.file(job.assetId,'mobile'))){failed=true;throw new Error('synthetic partial upload');}}});
    assert.deepEqual(await service.upload(actor(),p.pair(),randomUUID()),{state:'rejected',code:'CONFLICT'});const job=(await p.job())!;assert.equal(failed,true);assert.equal(job.filesFinished,true);assert.equal(await exists(p.file(job.assetId)),false);
  }finally{await p.cleanup();}
});
test('partial deletion isolation restores both exact originals and retains the metadata row',async()=>{
  const p=await themeAssetsFixture();try{const id=await p.upload();let failed=false;const service=p.make({assertExclusiveWriter:async()=>{if(!failed&&!await exists(p.file(id))&&await exists(p.file(id,'mobile'))){failed=true;throw new Error('synthetic partial delete');}}});
    assert.deepEqual(await service.delete(actor(),id,randomUUID()),{state:'rejected',code:'CONFLICT'});assert.equal(failed,true);assert.deepEqual(await fs.readFile(p.file(id)),p.pair().desktop);assert.deepEqual(await fs.readFile(p.file(id,'mobile')),p.pair().mobile);
    assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_assets'),1);assert.equal((await p.job('delete'))!.filesFinished,true);
  }finally{await p.cleanup();}
});
test('prepared deletion prevents new theme references and hidden reads until rollback finishes',async()=>{
  const p=await themeAssetsFixture();try{const id=await p.upload(),jobId=randomUUID();assert.equal((await p.port.execute(command({name:'themeAsset.prepareDelete',input:{jobId,assetId:id}}))).state,'committed');
    await assert.rejects(p.port.readThemeAsset({principal:actor(),assetId:id}),{code:'CONFLICT'});const settings=createDefaultThemeSettings();settings.desktop.backgroundKind='asset';settings.desktop.backgroundValue=id;
    const update=await p.port.execute(command({name:'account.setTheme',input:{settings}}));assert.equal(update.state,'rejected');
    assert.deepEqual(await p.make().recover(jobId),{state:'rejected',code:'CONFLICT'});assert.equal((await p.port.readThemeAsset({principal:actor(),assetId:id})).id,id);
  }finally{await p.cleanup();}
});
test('maintenance cannot register, start, bind a prepared proof or commit a new asset',async()=>{
  const p=await themeAssetsFixture();try{const jobId=randomUUID(),assetId=randomUUID(),bytes=p.pair(),file=(b:Uint8Array)=>({digest:createHash('sha256').update(b).digest('hex'),size:b.length});
    const prepare={name:'themeAsset.prepareUpload' as const,input:{jobId,assetId,desktop:file(bytes.desktop),mobile:file(bytes.mobile)}};
    await assert.rejects(p.port.execute(command(prepare,maintenance)),{code:'FORBIDDEN'});await p.port.execute(command(prepare));
    await assert.rejects(p.port.execute(command({name:'themeAsset.startFiles',input:{jobId}},maintenance)),{code:'FORBIDDEN'});
    const bound=await p.port.execute(command({name:'themeAsset.bindFiles',input:{jobId,proofDigest:'a'.repeat(64)}},maintenance));assert.equal(bound.state,'rejected');
    await assert.rejects(p.port.execute(command({name:'themeAsset.commit',input:{jobId,proofDigest:'a'.repeat(64)}},maintenance)),{code:'FORBIDDEN'});
    assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_assets'),0);
  }finally{await p.cleanup();}
});
test('missing started journal remains unknown; recovery does not invent an empty proof',async()=>{
  const p=await themeAssetsFixture();try{const jobId=randomUUID(),assetId=randomUUID(),bytes=p.pair(),file=(b:Uint8Array)=>({digest:createHash('sha256').update(b).digest('hex'),size:b.length});
    await p.port.execute(command({name:'themeAsset.prepareUpload',input:{jobId,assetId,desktop:file(bytes.desktop),mobile:file(bytes.mobile)}}));await p.port.execute(command({name:'themeAsset.startFiles',input:{jobId}}));
    assert.deepEqual(await p.make().recover(jobId),{state:'unknown'});const job=await p.port.readThemeAssetJob({principal:maintenance,jobId});assert.equal(job!.phase,'rejected');assert.equal(job!.filesFinished,false);assert.equal(await exists(p.root),false);
  }finally{await p.cleanup();}
});
test('a foreign replacement is preserved rather than erased during upload compensation',async()=>{
  const p=await themeAssetsFixture();try{let injected=false;const service=p.make({assertExclusiveWriter:async()=>{if(injected||p.f.scalar('SELECT count(*) FROM _relay_theme_asset_jobs')===0)return;const job=await p.job();if(job?.filesStarted){injected=true;await fs.mkdir(path.join(p.root,owner),{recursive:true});await fs.writeFile(p.file(job.assetId),'USER REPLACEMENT');}}});
    assert.deepEqual(await service.upload(actor(),p.pair(),randomUUID()),{state:'unknown'});const job=(await p.job())!;assert.equal(await fs.readFile(p.file(job.assetId),'utf8'),'USER REPLACEMENT');assert.equal(job.phase,'rejected');assert.equal(job.filesFinished,false);
  }finally{await p.cleanup();}
});
test('read after I/O rechecks current login and rejects externally hard-linked files',async()=>{
  const p=await themeAssetsFixture();try{const id=await p.upload(),outside=path.join(p.f.directory,'synthetic-hardlink.webp');await fs.link(p.file(id),outside);
    await assert.rejects(p.make().read(actor(),id,'desktop'),{code:'CONFLICT'});await fs.unlink(outside);
    let reads=0;const port=p.proxy({readThemeAsset:async(input)=>{if(++reads===2)p.f.mutate(`UPDATE users SET disabled_at=1 WHERE id='${owner}'`);return p.port.readThemeAsset(input);}});
    await assert.rejects(p.make({port}).read(actor(),id,'desktop'),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});
test('timed-out caller retains accepted work and a repeated key joins one upload',async()=>{
  const p=await themeAssetsFixture(),entered=gate(),release=gate();try{let once=false;const service=p.make({timeoutMs:20,assertExclusiveWriter:async()=>{if(!once){once=true;entered.resolve();await release.promise;}}}),key=randomUUID();
    const first=service.upload(actor(),p.pair(),key);await entered.promise;assert.deepEqual(await first,{state:'unknown'});const second=p.make().upload(actor(),p.pair(),key);release.resolve();assert.equal((await second).state,'committed');assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_assets'),1);
  }finally{release.resolve();await p.cleanup();}
});
test('job proof tampering is refused before a rollback can remove files',async()=>{
  const p=await themeAssetsFixture();try{p.f.mutate("CREATE TRIGGER asset_commit_failure BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='themeAsset.commit' BEGIN SELECT RAISE(ABORT,'synthetic');END");
    const service=p.make();await service.upload(actor(),p.pair(),randomUUID());const job=(await p.job())!;const manifest=path.join(p.root,'.relay-assets',job.jobId,'intent.json');
    const raw=JSON.parse(await fs.readFile(manifest,'utf8'));raw.files.desktop.digest='a'.repeat(64);await fs.writeFile(manifest,JSON.stringify(raw));
    assert.deepEqual(await service.recover(job.jobId),{state:'unknown'});assert.equal(await exists(p.file(job.assetId)),true);
  }finally{await p.cleanup();}
});
test('filesystem rejects a symlink root and never traverses it',async()=>{
  const p=await themeAssetsFixture();try{const target=path.join(p.f.directory,'outside-root');await fs.mkdir(target);await fs.symlink(target,p.root,process.platform==='win32'?'junction':'dir');
    const service=p.make();assert.notEqual((await service.upload(actor(),p.pair(),randomUUID())).state,'committed');assert.deepEqual(await fs.readdir(target),[]);
  }finally{await p.cleanup();}
});
test('exact file proof is committed before publication/isolation and both variants are applied before DB commit',async()=>{
  const p=await themeAssetsFixture();try{let binds=0,commits=0;const port=p.proxy({execute:async(request:any)=>{
    const name=request.command.name;
    if(name==='themeAsset.bindFiles'&&request.principal.kind==='user'){
      const job=await p.port.readThemeAssetJob({principal:actor(),jobId:request.command.input.jobId});assert.ok(job);binds++;
      for(const variant of ['desktop','mobile'])assert.equal(await exists(p.file(job!.assetId,variant)),job!.kind==='delete');
    }
    if(name==='themeAsset.commit'){
      const job=await p.port.readThemeAssetJob({principal:actor(),jobId:request.command.input.jobId});assert.match(job!.proofDigest!,/^[a-f0-9]{64}$/);commits++;
      for(const variant of ['desktop','mobile'])assert.equal(await exists(p.file(job!.assetId,variant)),job!.kind==='upload');
    }
    return p.port.execute(request);
  }} as any);
    const service=p.make({port}),id=await p.upload(service);assert.equal((await service.delete(actor(),id,randomUUID())).state,'committed');assert.equal(binds,2);assert.equal(commits,2);
  }finally{await p.cleanup();}
});

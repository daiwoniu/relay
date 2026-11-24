import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { HOSTING_SCHEMA_SQL, type HostedSite } from './contract.js';
import { PageHosting, createHostingPublicId } from './service.js';
import { createHostingAdminRouter, createHostingPublicRouter } from './routes.js';
import { Hono } from 'hono';
import { safePackagePath, rewriteReferences } from './paths.js';

const admin={kind:'user' as const,userId:'admin',authSessionHash:'auth-admin'};
const member={kind:'user' as const,userId:'owner',authSessionHash:'auth-owner'};
test('short public addresses retry collisions and bound generation failures',()=>{
  const candidates=['same123456','fresh12345'];
  assert.equal(createHostingPublicId([{publicId:'same123456'}],()=>candidates.shift()!),'fresh12345');
  assert.throws(()=>createHostingPublicId([{publicId:'same123456'}],()=>'same123456'),/生成访问地址失败/);
});
test('Native metadata rejects duplicate or changed short addresses and accepts legacy UUID records',async()=>{
  const t=await setup();try{
    const stage=await t.service.upload(admin,'index.html',stream('<h1>site</h1>'),13);
    const site=await t.service.publish(admin,{uploadId:stage.uploadId,name:'Site',entry:'index.html'});
    const save=(value:HostedSite,expectedToken:string|null)=>t.port.execute<'hosting.save'>({protocolVersion:1,storeId:'hosting',workerGeneration:1,requestId:randomUUID(),operationId:randomUUID(),principal:admin,command:{name:'hosting.save',input:{site:value,expectedToken}}});
    const duplicate=await save({...site,id:randomUUID()},null);
    assert.ok(duplicate.state==='rejected');assert.equal(duplicate.code,'CONFLICT');
    const changed=await save({...site,publicId:'different1',contentToken:randomUUID()},site.contentToken);
    assert.ok(changed.state==='rejected');assert.equal(changed.code,'CONFLICT');
    assert.equal((await t.port.readHostedSites({siteId:site.publicId!}))[0].contentToken,site.contentToken);
    const {publicId:_,source:__,...legacy}=site;legacy.id=randomUUID();legacy.contentToken=randomUUID();
    assert.equal((await save(legacy,null)).state,'committed');
    assert.equal((await t.service.list(admin)).find(item=>item.id===legacy.id)?.source,undefined);
    await fs.mkdir(path.join(t.root,'sites',legacy.id));await fs.writeFile(path.join(t.root,'sites',legacy.id,'index.html'),'<h1>legacy</h1>');
    assert.equal((await t.service.read(legacy.id,'index.html'))!.bytes.toString(),'<h1>legacy</h1>');
    const replacement=await t.service.upload(admin,'index.html',stream('<h1>updated legacy</h1>'),23);
    const markerPath=path.join(t.root,'staging',replacement.uploadId,'meta.json');
    const {source:stagedSource,...legacyMarker}=JSON.parse(await fs.readFile(markerPath,'utf8'));
    assert.ok(stagedSource);
    await fs.writeFile(markerPath,JSON.stringify(legacyMarker));
    const updated=await t.service.publish(admin,{uploadId:replacement.uploadId,name:'Legacy updated',entry:'index.html',siteId:legacy.id,expectedToken:legacy.contentToken});
    assert.equal(updated.source,undefined);
    assert.equal(updated.id,legacy.id);assert.match(updated.publicId!,/^[a-z0-9]{10}$/);assert.notEqual(updated.publicId,site.publicId);
    for(const address of [updated.id,updated.publicId!])assert.equal((await t.service.read(address,'index.html'))!.bytes.toString(),'<h1>updated legacy</h1>');
  }finally{await t.close();}
});
function stream(value:string|Buffer){return new Blob([new Uint8Array(Buffer.from(value))]).stream();}

test('large HTML imports keep outer rewrites while oversized inline code is preserved with accurate totals',async()=>{
  const t=await setup();try{
    const directory=path.join(t.f.directory,'large-site');await fs.mkdir(path.join(directory,'assets'),{recursive:true});
    const code='/*'+'x'.repeat(2*1024*1024)+'*/import "/assets/app.js";';
    const html='<img src="data:image/png;base64,'+'A'.repeat(5*1024*1024)+'"><img src="/assets/logo.png"><script type="module">'+code+'</script>';
    await fs.writeFile(path.join(directory,'index.html'),html);await fs.writeFile(path.join(directory,'assets/logo.png'),'image');await fs.writeFile(path.join(directory,'assets/app.js'),'export {};');
    const stage=await t.service.importLocal(admin,directory);
    const rewritten=html.replace('src="/assets/logo.png"','src="./assets/logo.png"');
    assert.equal(stage.fileCount,3);assert.equal(stage.rewritten,1);
    assert.equal(stage.totalBytes,Buffer.byteLength(rewritten)+Buffer.byteLength('image')+Buffer.byteLength('export {};'));
    assert.ok(stage.warnings.some(value=>/模块脚本超过 2 MiB/.test(value)));
    assert.equal(stage.warnings.some(value=>/超过 4 MB/.test(value)),false);
    assert.equal((await t.service.read(stage.uploadId,'index.html',stage.previewToken))!.bytes.toString(),rewritten);
  }finally{await t.close();}
});
async function setup(){
  const f=fixture();f.mutate(HOSTING_SCHEMA_SQL);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'hosting',generation:1,initialize:true});
  const root=path.join(f.directory,'page-hosting');
  const options={root,port,storeId:'hosting',generation:1,assertExclusiveWriter:async()=>{}};
  const service=new PageHosting(options);await service.initialize();
  return {f,port,root,service,options,close:async()=>{await service.close();await port.close();f.cleanup();}};
}

test('upload, preview, publish, replace, disable, rename and delete use Native metadata and fixed directories',async()=>{
  const t=await setup();try{
    const first=await t.service.upload(admin,'hello.html',stream('<h1>first</h1>'),14);
    assert.equal((await t.service.read(first.uploadId,'index.html',first.previewToken))!.bytes.toString(),'<h1>first</h1>');
    assert.equal(await t.service.read(first.uploadId,'index.html','a'.repeat(64)),null);
    const site=await t.service.publish(admin,{uploadId:first.uploadId,name:'First',entry:'index.html'});
    assert.deepEqual(site.source,{kind:'upload',filename:'hello.html'});
    assert.deepEqual((await t.service.list(admin))[0].source,site.source);
    assert.match(site.publicId!,/^[a-z0-9]{10}$/);
    assert.deepEqual(await fs.readdir(path.join(t.root,'sites',site.id)),['index.html']);
    assert.equal((await t.port.readHostedSites({siteId:site.id}))[0].name,'First');
    const publicApp=new Hono().route('/p',createHostingPublicRouter(t.service));
    const shortCanonical=await publicApp.request(`/p/${site.publicId}/`);
    assert.equal(shortCanonical.status,302);assert.equal(shortCanonical.headers.get('location'),`/p/${site.publicId}/index.html`);
    const shortResponse=await publicApp.request(`/p/${site.publicId}/index.html`);
    assert.equal(shortResponse.status,200);assert.equal(await shortResponse.text(),'<h1>first</h1>');
    const canonical=await publicApp.request(`/p/${site.id}/`);assert.equal(canonical.status,302);assert.equal(canonical.headers.get('location'),`/p/${site.id}/index.html`);
    const response=await publicApp.request(`/p/${site.id}/index.html`,{headers:{origin:'null'}});
    assert.equal(response.status,200);assert.equal(await response.text(),'<h1>first</h1>');
    assert.match(response.headers.get('content-security-policy')!,/sandbox allow-scripts/);assert.doesNotMatch(response.headers.get('content-security-policy')!,/allow-same-origin/);
    assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.equal(response.headers.get('access-control-allow-credentials'),null);
    assert.equal((await publicApp.request(`/p/${site.id}/index.html`,{method:'HEAD'})).headers.get('content-length'),'14');
    assert.equal((await publicApp.request(`/p/${site.id}/index.html`,{method:'POST'})).status,405);
    assert.equal((await publicApp.request(`/p/${site.id}/%2e%2e%2fsecret.txt`)).status,404);
    const next=await t.service.upload(admin,'new.html',stream('<h1>second</h1>'),15);
    const updated=await t.service.publish(admin,{uploadId:next.uploadId,name:'Updated',entry:'index.html',siteId:site.id,expectedToken:site.contentToken});
    assert.deepEqual(updated.source,{kind:'upload',filename:'new.html'});
    assert.equal(updated.id,site.id);assert.equal((await t.service.read(site.id,'index.html'))!.bytes.toString(),'<h1>second</h1>');
    assert.equal(updated.publicId,site.publicId);assert.equal((await t.service.read(site.publicId!,'index.html'))!.bytes.toString(),'<h1>second</h1>');
    assert.deepEqual(await fs.readdir(path.join(t.root,'staging')),[]);
    await assert.rejects(t.service.patch(admin,site.id,site.contentToken,{name:'Stale'}),/站点已变化/);
    const disabled=await t.service.patch(admin,site.id,updated.contentToken,{enabled:false,name:'Renamed'});
    assert.deepEqual(disabled.source,updated.source);
    assert.equal(await t.service.read(site.id,'index.html'),null);
    assert.equal(await t.service.read(site.publicId!,'index.html'),null);
    const enabled=await t.service.patch(admin,site.id,disabled.contentToken,{enabled:true});
    assert.equal((await t.service.read(site.id,'index.html'))!.bytes.toString(),'<h1>second</h1>');
    await t.service.remove(admin,site.id,enabled.contentToken);
    assert.equal(await t.service.read(site.publicId!,'index.html'),null);
    assert.equal(await t.service.read(site.id,'index.html'),null);assert.deepEqual(await fs.readdir(path.join(t.root,'sites')),[]);
  }finally{await t.close();}
});

test('ZIP flattens wrapper, rewrites root and local references, retains remote URLs and serves subpages',async()=>{
  const t=await setup();try{
    const zip=new JSZip();zip.file('website/index.html','<link href="/css/main.css"><script src="/js/main.js"></script><a href="/pages/about.html">About</a><img src="https://cdn.example.com/a.png">');
    zip.file('website/pages/about.html','<img src="C:\\site\\images\\logo.png">');zip.file('website/css/main.css','body{background:url(/images/logo.png)}');zip.file('website/js/main.js','import "./other.js";');zip.file('website/js/other.js','export const x=1;');zip.file('website/images/logo.png',Buffer.from([1,2,3]));
    const bytes=await zip.generateAsync({type:'nodebuffer'}),stage=await t.service.upload(admin,'site.zip',stream(bytes),bytes.length);
    assert.equal(stage.suggestedEntry,'index.html');assert.equal(stage.fileCount,6);assert.ok(stage.rewritten>=5);
    const site=await t.service.publish(admin,{uploadId:stage.uploadId,name:'ZIP',entry:'index.html'});
    assert.deepEqual(site.source,{kind:'upload',filename:'site.zip'});
    assert.match((await t.service.read(site.id,'index.html'))!.bytes.toString(),/href="\.\/css\/main.css"/);
    assert.match((await t.service.read(site.id,'index.html'))!.bytes.toString(),/https:\/\/cdn.example.com\/a.png/);
    assert.match((await t.service.read(site.id,'pages/about.html'))!.bytes.toString(),/\.\.\/images\/logo.png/);
    assert.match((await t.service.read(site.id,'css/main.css'))!.bytes.toString(),/\.\.\/images\/logo.png/);
  }finally{await t.close();}
});

test('ZIP and directory accept subtitles and audio and serve preview/public MIME with unchanged bytes',async()=>{
  const t=await setup();try{
    const resources=[
      {name:'captions.VTT',mime:'text/vtt; charset=utf-8',bytes:Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\n字幕\n')},
      {name:'audio.m4a',mime:'audio/mp4',bytes:Buffer.from([0,0,0,24,102,116,121,112])},
      {name:'audio.AAC',mime:'audio/aac',bytes:Buffer.from([255,241,80,128])},
    ];
    const app=new Hono().route('/p',createHostingPublicRouter(t.service)).route('/p-preview',createHostingPublicRouter(t.service));
    for(const kind of ['zip','directory']){
      let stage;
      if(kind==='zip'){
        const zip=new JSZip();zip.file('index.html','<h1>Media</h1>');for(const file of resources)zip.file(file.name,file.bytes);
        const bytes=await zip.generateAsync({type:'nodebuffer'});stage=await t.service.upload(admin,'media.zip',stream(bytes),bytes.length);
      }else{
        const source=path.join(t.f.directory,'media');await fs.mkdir(source);await fs.writeFile(path.join(source,'index.html'),'<h1>Media</h1>');
        for(const file of resources)await fs.writeFile(path.join(source,file.name),file.bytes);
        stage=await t.service.importLocal(admin,source);
      }
      assert.equal(stage.fileCount,4);
      for(const file of resources){
        const response=await app.request(`/p-preview/${stage.uploadId}/${stage.previewToken}/${file.name}`,{headers:{origin:'null'}});
        assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),file.mime);
        assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.deepEqual(Buffer.from(await response.arrayBuffer()),file.bytes);
      }
      const site=await t.service.publish(admin,{uploadId:stage.uploadId,name:kind,entry:'index.html'});
      for(const file of resources){
        const url=`/p/${site.publicId}/${file.name}`,response=await app.request(url);
        assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),file.mime);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()),file.bytes);
        const head=await app.request(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),file.mime);
        assert.equal(head.headers.get('content-length'),String(file.bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
      }
    }
    for(const file of resources)await assert.rejects(t.service.upload(admin,file.name,stream(file.bytes),file.bytes.length),/HTML/);
  }finally{await t.close();}
});

test('local HTML, ZIP and directory import copy independent snapshots without browser bytes',async()=>{
  const t=await setup();try{
    const source=path.join(t.f.directory,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'index.html'),'<h1>local</h1>');await fs.mkdir(path.join(source,'assets'));await fs.writeFile(path.join(source,'assets','style.css'),'h1{color:red}');
    const directory=await t.service.importLocal(admin,source);assert.equal(directory.fileCount,2);
    const site=await t.service.publish(admin,{uploadId:directory.uploadId,name:'Local',entry:'index.html'});
    assert.deepEqual(site.source,{kind:'local',path:await fs.realpath(source)});
    assert.equal((await t.port.readHostedSites({siteId:site.id}))[0].source,undefined);
    assert.equal((await t.port.readHostedSites({principal:{kind:'system',purpose:'recovery'}}))[0].source,undefined);
    await fs.writeFile(path.join(source,'index.html'),'changed');assert.equal((await t.service.read(site.id,'index.html'))!.bytes.toString(),'<h1>local</h1>');
    const filename=path.join(source,'index.html');
    const single=await t.service.importLocal(admin,filename);assert.equal(single.fileCount,1);
    const updated=await t.service.publish(admin,{uploadId:single.uploadId,name:site.name,entry:'index.html',siteId:site.id,expectedToken:site.contentToken});
    assert.deepEqual(updated.source,{kind:'local',path:await fs.realpath(filename)});
    assert.deepEqual((await t.service.list(admin))[0].source,updated.source);
    const zip=new JSZip();zip.file('index.html','from zip');const zipfile=path.join(t.f.directory,'local.zip');await fs.writeFile(zipfile,await zip.generateAsync({type:'nodebuffer'}));
    const zipped=await t.service.importLocal(admin,zipfile);assert.equal(zipped.fileCount,1);await t.service.cancel(admin,zipped.uploadId);
    const nested=path.join(t.f.directory,'nested');await fs.mkdir(path.join(nested,'pages'),{recursive:true});await fs.writeFile(path.join(nested,'pages','index.html'),'nested homepage');
    const preserved=await t.service.importLocal(admin,nested);assert.deepEqual(preserved.entries,['pages/index.html']);await t.service.cancel(admin,preserved.uploadId);
    await assert.rejects(t.service.importLocal(admin,t.root),/托管数据目录/);
    await assert.rejects(t.service.importLocal(member,source),{code:'FORBIDDEN'});
  }finally{await t.close();}
});

test('reject traversal, links, duplicate paths, decompression expansion and unsupported files',async()=>{
  for(const name of ['../index.html','/index.html','C:/index.html','a\\index.html','con.html','a/../x.html','a/.env','a/b.'])assert.throws(()=>safePackagePath(name));
  const t=await setup();try{
    const invalid=new JSZip();invalid.file('../escape.html','bad');
    await assert.rejects(t.service.upload(admin,'bad.zip',stream(await invalid.generateAsync({type:'nodebuffer'})),100),/不安全/);
    const symlink=new JSZip();symlink.file('index.html','target',{unixPermissions:0o120777});
    await assert.rejects(t.service.upload(admin,'link.zip',stream(await symlink.generateAsync({type:'nodebuffer',platform:'UNIX'})),100),/符号链接/);
    const duplicate=new JSZip();duplicate.file('index.html','one');duplicate.file('INDEX.html','two');
    await assert.rejects(t.service.upload(admin,'duplicate.zip',stream(await duplicate.generateAsync({type:'nodebuffer'})),100),/大小写冲突/);
    const bomb=new JSZip();bomb.file('index.html',Buffer.alloc(33*1024*1024,32));
    await assert.rejects(t.service.upload(admin,'bomb.zip',stream(await bomb.generateAsync({type:'nodebuffer',compression:'DEFLATE'})),100),/解压内容超过限制/);
    await assert.rejects(t.service.upload(admin,'run.exe',stream('bad'),3),/HTML/);
    assert.deepEqual(await fs.readdir(path.join(t.root,'staging')),[]);
  }finally{await t.close();}
});

test('failed Native commit restores old content and leaves the new upload retryable',async()=>{
  const t=await setup();try{
    const stage=await t.service.upload(admin,'old.html',stream('old'),3),old=await t.service.publish(admin,{uploadId:stage.uploadId,name:'Old',entry:'index.html'});
    const next=await t.service.upload(admin,'new.html',stream('new'),3);
    const original=t.port.execute.bind(t.port);let fail=true;
    t.port.execute=(async request=>fail&&request.command.name==='hosting.save'?{state:'rejected',operationId:request.operationId,code:'CONFLICT'}:original(request)) as typeof t.port.execute;
    await assert.rejects(t.service.publish(admin,{uploadId:next.uploadId,name:'New',entry:'index.html',siteId:old.id,expectedToken:old.contentToken}),{code:'CONFLICT'});
    assert.deepEqual((await t.service.list(admin))[0].source,{kind:'upload',filename:'old.html'});
    assert.equal((await t.service.read(old.id,'index.html'))!.bytes.toString(),'old');
    assert.equal((await t.service.read(next.uploadId,'index.html',next.previewToken))!.bytes.toString(),'new');
    fail=false;await t.service.publish(admin,{uploadId:next.uploadId,name:'New',entry:'index.html',siteId:old.id,expectedToken:old.contentToken});
    assert.deepEqual((await t.service.list(admin))[0].source,{kind:'upload',filename:'new.html'});
    assert.equal((await t.service.read(old.id,'index.html'))!.bytes.toString(),'new');
  }finally{await t.close();}
});

test('startup recovers an interrupted directory switch from authoritative Native metadata',async()=>{
  const t=await setup();let recovered:PageHosting|undefined;
  try{
    const stage=await t.service.upload(admin,'index.html',stream('old'),3),old=await t.service.publish(admin,{uploadId:stage.uploadId,name:'Old',entry:'index.html'});
    const next=await t.service.upload(admin,'index.html',stream('new'),3),folder=path.join(t.root,'staging',`swap-${old.id}`);
    const newSite:HostedSite={...old,contentToken:randomUUID()};await fs.mkdir(folder);await fs.writeFile(path.join(folder,'journal.json'),JSON.stringify({old,next:newSite,uploadId:next.uploadId}));
    await fs.rename(path.join(t.root,'sites',old.id),path.join(folder,'previous'));await fs.rename(path.join(t.root,'staging',next.uploadId,'content'),path.join(t.root,'sites',old.id));
    await t.service.close();recovered=new PageHosting(t.options);await recovered.initialize();
    assert.equal((await recovered.read(old.id,'index.html'))!.bytes.toString(),'old');
    assert.equal((await recovered.read(next.uploadId,'index.html',next.previewToken))!.bytes.toString(),'new');
  }finally{await recovered?.close();await t.close();}
});

test('management rejects members and guests, including direct storage writes and stale sessions',async()=>{
  const t=await setup();try{
    const router=new Hono().route('/admin',createHostingAdminRouter({port:t.port,service:t.service}));
    assert.equal((await router.request('/admin')).status,401);
    // Real cookie hashes are intentionally synthetic, never taken from a live browser.
    const {hashSessionToken}=await import('../auth/session.js');
    for(const id of ['admin','owner'])t.f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hashSessionToken(`host-${id}`)}','${id}',${Date.now()+60000})`);
    assert.equal((await router.request('/admin',{headers:{cookie:'relay_session=host-owner'}})).status,403);
    assert.equal((await router.request('/admin',{headers:{cookie:'relay_session=host-admin'}})).status,200);
    const response=await t.port.execute({protocolVersion:1,storeId:'hosting',workerGeneration:1,requestId:randomUUID(),operationId:randomUUID(),principal:member,command:{name:'hosting.delete',input:{id:randomUUID(),expectedToken:randomUUID()}}});
    assert.equal(response.state,'rejected');if(response.state==='rejected')assert.equal(response.code,'FORBIDDEN');
    t.f.mutate("UPDATE users SET disabled_at=1 WHERE id='admin'");
    await assert.rejects(t.service.list(admin),{code:'FORBIDDEN'});
  }finally{await t.close();}
});

test('reference normalization preserves network URLs, relative links, anchors and non-resource script strings',()=>{
  const files=new Set(['index.html','css/main.css','img/logo.png','js/main.js']);
  const html='<link href="/css/main.css"><img src="https://example.com/x"><a href="#a">x</a><script>const example="/img/logo.png";</script>';
  const value=rewriteReferences('index.html',html,files);
  assert.match(value.text,/\.\/css\/main.css/);assert.match(value.text,/https:\/\/example.com\/x/);assert.match(value.text,/const example="\/img\/logo.png"/);assert.match(value.text,/href="#a"/);
  assert.equal(rewriteReferences('index.html','<img src="./img/logo.png">',files).rewritten,0);
  const js=`// import '/js/main.js';\nconst example="import '/js/main.js'";\nimport '/js/main.js';\nexport {x} from '/js/main.js';`;
  const script=rewriteReferences('index.js',js,files);
  assert.match(script.text,/\/\/ import '\/js\/main.js'/);assert.match(script.text,/const example="import '\/js\/main.js'"/);
  assert.match(script.text,/\nimport '.\/js\/main.js'/);assert.equal(script.rewritten,2);
  const css=`/* url(/img/logo.png) */ a{content:"url(/img/logo.png)";background:url(/img/logo.png)}`;
  const style=rewriteReferences('style.css',css,files);assert.equal(style.rewritten,1);assert.match(style.text,/content:"url\(\/img\/logo.png\)"/);
  assert.equal(rewriteReferences('index.html','<img data-src="/img/logo.png">',files).rewritten,0);
  assert.equal(rewriteReferences('index.html',`<div title="example src='/js/main.js'">x</div>`,files).rewritten,0);
  assert.match(rewriteReferences('index.html','<script type="module">import "/js/main.js";</script>',files).text,/import "\.\/js\/main.js"/);
  assert.match(rewriteReferences('index.html','<img src=/img/logo.png>',files).text,/src=\.\/img\/logo.png/);
  const special=new Set(["assets/a'b).css"]);assert.match(rewriteReferences('index.html',`<link href='/assets/a%27b%29.css'>`,special).text,/a%27b%29\.css/);
  const candidates=rewriteReferences('index.html','<img srcset="https://cdn.example.com/a,b.png 1x, /img/logo.png 2x">',files);
  assert.equal(candidates.text,'<img srcset="https://cdn.example.com/a,b.png 1x, ./img/logo.png 2x">');
  const nestedTemplate="const example = `outer ${`import '/js/main.js'`}`;\nimport '/js/main.js';";
  const parsed=rewriteReferences('index.js',nestedTemplate,files);
  assert.equal(parsed.text,"const example = `outer ${`import '/js/main.js'`}`;\nimport './js/main.js';");assert.equal(parsed.rewritten,1);
});

test('closing the service aborts a stalled upload, cleans temporary files and waits for completion',async()=>{
  const t=await setup();
  try{
    const pending=t.service.upload(admin,'index.html',new ReadableStream(),1);
    const rejected=assert.rejects(pending);
    await new Promise(resolve=>setTimeout(resolve,50));await t.service.close();await rejected;
    assert.deepEqual(await fs.readdir(path.join(t.root,'staging')),[]);
  }finally{await t.close();}
});

test('processing timeout waits for Worker exit before deleting the stage and releasing the operation',async()=>{
  const t=await setup();let timed:PageHosting|undefined;
  try{
    await t.service.close();timed=new PageHosting({...t.options,processingTimeoutMs:1});
    await assert.rejects(timed.upload(admin,'index.html',stream('<h1>timeout</h1>'),16),/处理超时/);
    assert.deepEqual(await fs.readdir(path.join(t.root,'staging')),[]);
    await timed.close();await new Promise(resolve=>setTimeout(resolve,25));
    assert.deepEqual(await fs.readdir(path.join(t.root,'staging')),[],'terminated Worker cannot recreate files after cleanup');
  }finally{await timed?.close();await t.close();}
});

test('startup removes a switch interrupted before the final journal without touching the published site',async()=>{
  const t=await setup();let recovered:PageHosting|undefined;
  try{
    const stage=await t.service.upload(admin,'index.html',stream('published'),9),site=await t.service.publish(admin,{uploadId:stage.uploadId,name:'Live',entry:'index.html'});
    await t.service.close();const folder=path.join(t.root,'staging',`swap-${site.id}`);await fs.mkdir(folder);await fs.writeFile(path.join(folder,'journal.tmp'),'{partial');
    recovered=new PageHosting(t.options);await recovered.initialize();
    assert.equal((await recovered.read(site.id,'index.html'))!.bytes.toString(),'published');
    assert.deepEqual(await fs.readdir(path.join(t.root,'staging')),[]);
  }finally{await recovered?.close();await t.close();}
});

test('public file streams limit open transfers and release capacity on cancellation',async()=>{
  const t=await setup();const transfers:Array<NonNullable<Awaited<ReturnType<PageHosting['open']>>>>=[];
  try{
    const zip=new JSZip();zip.file('index.html','stream');zip.file('large.jpg',Buffer.alloc(256*1024,1));
    const buffer=await zip.generateAsync({type:'nodebuffer'}),stage=await t.service.upload(admin,'site.zip',stream(buffer),buffer.length);
    const site=await t.service.publish(admin,{uploadId:stage.uploadId,name:'Stream',entry:'index.html'});
    for(let index=0;index<32;index++){const file=await t.service.open(site.id,'large.jpg');assert.ok(file);transfers.push(file);}
    await assert.rejects(t.service.open(site.id,'large.jpg'),/访问繁忙/);
    await transfers.shift()!.stream.cancel();
    let replacement:Awaited<ReturnType<PageHosting['open']>>=null;
    // Native stream cancellation requests descriptor close; capacity returns on the actual close event.
    for(let attempt=0;attempt<50;attempt++){
      try{replacement=await t.service.open(site.id,'large.jpg');break;}catch(error){if((error as any).status!==503)throw error;await new Promise(resolve=>setTimeout(resolve,10));}
    }
    assert.ok(replacement);transfers.push(replacement);
    const reader=transfers[0].stream.getReader();const first=await reader.read();assert.ok(first.value!.byteLength<=64*1024);assert.equal(transfers[0].size,256*1024);await reader.cancel();transfers.shift();
  }finally{await Promise.all(transfers.map(file=>file.stream.cancel()));await t.close();}
});

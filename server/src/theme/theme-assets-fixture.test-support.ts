import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StoredThemeAssets } from '../services/stored-theme-assets.js';
import { hashSessionToken } from '../auth/session.js';
export const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const token=(id:string)=>`synthetic-asset-${id}`;
export const actor=(id=owner)=>({kind:'user' as const,userId:id,authSessionHash:hashSessionToken(token(id))});
export function webp(width=16,height=12){
  const bytes=Buffer.alloc(26);bytes.write('RIFF',0);bytes.writeUInt32LE(18,4);bytes.write('WEBP',8);bytes.write('VP8L',12);bytes.writeUInt32LE(5,16);bytes[20]=0x2f;
  const w=width-1,h=height-1;bytes[21]=w&255;bytes[22]=((w>>8)&63)|((h&3)<<6);bytes[23]=(h>>2)&255;bytes[24]=(h>>10)&15;return bytes;
}
export function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
export async function themeAssetsFixture(){
  const f=fixture(),root=path.join(f.directory,'assets');
  f.mutate(`INSERT INTO users(id,role,username) VALUES('${owner}','member','asset-owner'),('${other}','member','asset-other');
    CREATE TABLE user_theme_settings(user_id TEXT PRIMARY KEY,settings_json TEXT NOT NULL,color_style TEXT NOT NULL DEFAULT 'neutral',text_scale TEXT NOT NULL DEFAULT 'standard',updated_at INTEGER NOT NULL);
    CREATE TABLE user_theme_assets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL)`);
  for(const id of [owner,other])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${actor(id).authSessionHash}','${id}',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'assets-test',generation:1,initialize:true});const instances:StoredThemeAssets[]=[];
  const make=(overrides:Partial<ConstructorParameters<typeof StoredThemeAssets>[0]>={})=>{const s=new StoredThemeAssets({port,storeId:'assets-test',generation:1,root,assertExclusiveWriter:async()=>{},...overrides});instances.push(s);return s;};
  const proxy=(overrides:Partial<CoreStoragePort>)=>new Proxy(port,{get(target,key){const value=Reflect.get(overrides,key)??Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as CoreStoragePort;
  const pair=()=>({desktop:webp(),mobile:webp(12,16)});
  const jobId=(kind='upload')=>f.scalar(`SELECT id FROM _relay_theme_asset_jobs WHERE kind='${kind}' ORDER BY created_at DESC LIMIT 1`) as string;
  const job=(kind='upload')=>port.readThemeAssetJob({principal:{kind:'system',purpose:'maintenance'},jobId:jobId(kind)});
  const upload=async(service=make())=>{const result=await service.upload(actor(),pair(),randomUUID());if(result.state!=='committed'||result.cleanupPending)throw new Error('SYNTHETIC_UPLOAD_NOT_FINISHED');return result.assetId;};
  return{f,root,port,make,proxy,pair,jobId,job,upload,file:(id:string,v='desktop')=>path.join(root,owner,`${id}-${v}.webp`),cleanup:async()=>{await Promise.all(instances.map(s=>s.close()));await port.close();f.cleanup();}};
}

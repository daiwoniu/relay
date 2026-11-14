import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StoreOwner } from './store-owner.js';

test('store owner excludes concurrent writers, validates its nonce and releases only after explicit close',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-owner-')),filename=path.join(root,'fixture.db');await fs.writeFile(filename,'synthetic');
  try{
    const owner=await StoreOwner.acquire(filename);await owner.assertCurrent();
    await assert.rejects(StoreOwner.acquire(filename),/CONFLICT/);
    const previous=await fs.readFile(filename+'.relay-owner/owner.json','utf8');
    await fs.writeFile(filename+'.relay-owner/owner.json',JSON.stringify({...JSON.parse(previous),nonce:randomUUID()}));
    await assert.rejects(owner.assertCurrent(),/CONFLICT/);await assert.rejects(owner.release(),/CONFLICT/);
    await fs.writeFile(filename+'.relay-owner/owner.json',previous);await owner.release();await owner.release();
    const next=await StoreOwner.acquire(filename);await assert.rejects(owner.assertCurrent(),/CONFLICT/);await next.release();
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('absent-process ownership can be reclaimed; malformed or incomplete acquisition is retained',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-owner-')),filename=path.join(root,'fixture.db');await fs.writeFile(filename,'synthetic');
  try{
    const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});const pid=child.pid!;
    await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>resolve());});
    await fs.mkdir(filename+'.relay-owner');await fs.writeFile(filename+'.relay-owner/owner.json',JSON.stringify({version:1,pid,nonce:randomUUID(),createdAt:1}));
    const owner=await StoreOwner.acquire(filename);await owner.assertCurrent();await owner.release();
    await fs.mkdir(filename+'.relay-owner');await fs.writeFile(filename+'.relay-owner/owner.json','incomplete');
    await assert.rejects(StoreOwner.acquire(filename));assert.equal(await fs.readFile(filename+'.relay-owner/owner.json','utf8'),'incomplete');
    await fs.mkdir(filename+'.relay-owner.claim');await assert.rejects(StoreOwner.acquire(filename),/CONFLICT/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

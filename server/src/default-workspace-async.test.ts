import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectFilesAsync,DEFAULT_WORKSPACE_TEMPLATES } from './default-workspace.js';

test('Native project initialization preserves existing rules across concurrent callers',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-native-project-'));
  try{
    await fs.writeFile(path.join(root,'AGENTS.md'),'user-owned instructions');
    const results=await Promise.all([ensureProjectFilesAsync(root,async()=>{}),ensureProjectFilesAsync(root,async()=>{})]);
    assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),'user-owned instructions');
    assert.equal(results.flatMap(value=>value.created).length,Object.keys(DEFAULT_WORKSPACE_TEMPLATES).length-1);
    assert.ok((await fs.readFile(path.join(root,'WORKBUDDY.md'),'utf8')).includes('AGENTS.md'));
    assert.deepEqual((await ensureProjectFilesAsync(root,async()=>{})).created,[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Native project initialization refuses lost ownership and linked rules before writing templates',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-native-project-'));
  try{
    await assert.rejects(()=>ensureProjectFilesAsync(root,async()=>{throw Error('owner lost');}),/owner lost/);assert.deepEqual(await fs.readdir(root),[]);
    await fs.writeFile(path.join(root,'original'),'private rule');await fs.link(path.join(root,'original'),path.join(root,'AGENTS.md'));
    await assert.rejects(()=>ensureProjectFilesAsync(root,async()=>{}),/独立普通文件/);
    assert.equal(await fs.readFile(path.join(root,'original'),'utf8'),'private rule');assert.equal((await fs.readdir(root)).length,2);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

import fs from 'node:fs';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import type { StoreWriterProof } from './store-owner.js';
/** Synchronous filesystem checks are confined to the owned file/database Worker immediately before mutation and COMMIT. */
export function assertWorkerWriter(proof:StoreWriterProof){
  if(isMainThread||proof?.version!==1||proof.pid!==process.pid||!Number.isSafeInteger(proof.pid)||typeof proof.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(proof.nonce)
    ||proof.ownerFile!==path.join(proof.filename+'.relay-owner','owner.json'))throw Error('WORKER_OWNER_LOST');
  const root=fs.lstatSync(path.dirname(proof.ownerFile)),file=fs.lstatSync(proof.ownerFile);
  if(!root.isDirectory()||root.isSymbolicLink()||!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>4096)throw Error('WORKER_OWNER_LOST');
  const value=JSON.parse(fs.readFileSync(proof.ownerFile,'utf8'));
  if(value?.version!==1||value.pid!==proof.pid||value.nonce!==proof.nonce)throw Error('WORKER_OWNER_LOST');
}

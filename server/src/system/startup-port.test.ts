import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { assertBackendStopped } from './startup-port.js';

test('occupied backend port refuses startup before storage migration; a stopped endpoint is released after checking',async()=>{
  const server=createServer();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  try{await assert.rejects(assertBackendStopped('127.0.0.1',port),/BACKEND_STOP_REQUIRED/);}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  await assertBackendStopped('127.0.0.1',port);
  await assertBackendStopped('127.0.0.1',port);
});
